import { memoize } from "functools-kit";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { read as readWorkbook, utils as xlsxUtils } from "xlsx";

/** Сырая свеча в формате ccxt: [timestamp, open, high, low, close, volume] */
type TRawCandle = (number | undefined)[];

/** Публичный сайт Республиканской фондовой биржи «Тошкент», без ключа и логина */
const NAMES_ENDPOINT = "https://uzse.uz/isu_infos/names";
const EXPORT_ENDPOINT = "https://uzse.uz/isu_infos/export";
const STATUS_ENDPOINT = "https://uzse.uz/trade_results/export_status";
const MARKET_ID = "STK";
/** Раньше этой даты в выгрузках биржи нет ни одной сделки */
const HISTORY_START = "01.01.2010";
/**
 * Постоянная папка для выгрузок: файл качается один раз и потом читается с диска.
 * Докачка идёт в файл с расширением .part, готовый файл переименовывается в .xlsx,
 * поэтому битая выгрузка никогда не читается как готовая.
 */
const CACHE_DIR = join(tmpdir(), "backtest-kit", "uzse");
const POLL_MS = 2_000;
const MAX_POLLS = 150;
const MAX_RATE_LIMIT_WAITS = 4;
const HEADERS = { "User-Agent": "Mozilla/5.0" };

const DAY_MS = 86_400_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatDate = (date: Date) =>
  `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${date.getUTCFullYear()}`;

const parseDate = (value: string) => {
  const [day, month, year] = value.split(".").map(Number);
  return Date.UTC(year, month - 1, day);
};

/**
 * Дневные свечи акций UzSE без ccxt.
 *
 * getCandles совместим с фетчером getCandlesFilled / getCandlesSampled из backtest-kit:
 * (symbol, interval, since, limit) => сырые массивы. Символ - биржевой тикер акции ("HMKB",
 * "AGBAP"), ISIN подбирается по справочнику биржи. Биржа отдаёт историю только выгрузкой Excel
 * через очередь заданий с жёстким лимитом запросов, поэтому выгрузка по бумаге делается один
 * раз и хранится в CACHE_DIR; повторный запуск читает файл с диска и в сеть не ходит.
 *
 * Заглядывания вперёд нет по построению: ядро запрашивает свечи с since и limit, обрезанными
 * по текущему времени движка, класс отдаёт ровно запрошенный диапазон из полной истории.
 */
export class UzSEUtils {

  /** Справочник бумаг рынка акций: тикер -> ISIN */
  private fetchNames = memoize(
    () => MARKET_ID,
    async (): Promise<Map<string, string>> => {
      const response = await fetch(`${NAMES_ENDPOINT}?mkt_id=${MARKET_ID}`, { headers: HEADERS });
      if (!response.ok) {
        throw new Error(`UzSE names: HTTP ${response.status}`);
      }
      const rows = (await response.json()) as Array<[string, string, string]>;
      return new Map(rows.map(([isin, ticker]) => [ticker, isin]));
    },
  );

  /** Заказывает выгрузку на бирже, ждёт готовности и возвращает содержимое xlsx */
  private downloadExport = async (ticker: string, isin: string): Promise<Buffer> => {
    const params = new URLSearchParams({ isu_cd: isin, mkt_id: MARKET_ID, begin_date: HISTORY_START, end_date: formatDate(new Date()) });
    let jobId: number | null = null;
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_WAITS && jobId === null; attempt++) {
      const response = await fetch(`${EXPORT_ENDPOINT}?${params}`, { headers: HEADERS });
      if (response.status === 429) {
        // Биржа пускает единицы выгрузок за полчаса и сама называет срок; ждём его и повторяем
        // Окно на деле длиннее заявленного: при повторном 429 пауза удваивается
        const text = await response.text();
        const minutes = Number(/(\d+)\s*minutes?/.exec(text)?.[1] ?? 30) * 2 ** attempt + 1;
        console.warn(`UzSE ${ticker}: export rate limited, waiting ${minutes} min (${attempt + 1}/${MAX_RATE_LIMIT_WAITS})`);
        await sleep(minutes * 60_000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`UzSE ${ticker}: export HTTP ${response.status}`);
      }
      jobId = ((await response.json()) as { job_id: number }).job_id;
    }
    if (jobId === null) {
      throw new Error(`UzSE ${ticker}: export still rate limited after ${MAX_RATE_LIMIT_WAITS} waits`);
    }
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await sleep(POLL_MS);
      const statusResponse = await fetch(`${STATUS_ENDPOINT}?id=${jobId}`, { headers: HEADERS });
      if (!statusResponse.ok) {
        throw new Error(`UzSE ${ticker}: export status HTTP ${statusResponse.status}`);
      }
      const status = (await statusResponse.json()) as { status: string; file_url?: string; error?: string | null };
      if (status.status === "failed") {
        throw new Error(`UzSE ${ticker}: export failed: ${status.error}`);
      }
      if (status.status === "completed" && status.file_url) {
        const file = await fetch(status.file_url, { headers: HEADERS });
        if (!file.ok) {
          throw new Error(`UzSE ${ticker}: file HTTP ${file.status}`);
        }
        return Buffer.from(await file.arrayBuffer());
      }
    }
    throw new Error(`UzSE ${ticker}: export job ${jobId} not completed after ${(MAX_POLLS * POLL_MS) / 1000}s`);
  };

  /** Путь к готовой выгрузке бумаги: с диска, если есть, иначе качается через .part */
  private ensureExport = async (ticker: string): Promise<string> => {
    const isin = (await this.fetchNames()).get(ticker);
    if (!isin) {
      throw new Error(`UzSE: unknown ticker ${ticker}, expected one of the ${MARKET_ID} market tickers`);
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    const target = join(CACHE_DIR, `${ticker}_${isin}.xlsx`);
    if (existsSync(target)) {
      return target;
    }
    const partial = `${target}.part`;
    if (existsSync(partial)) {
      unlinkSync(partial);
    }
    const buffer = await this.downloadExport(ticker, isin);
    writeFileSync(partial, buffer);
    renameSync(partial, target);
    console.log(`UzSE ${ticker}: exported ${buffer.length} bytes to ${target}`);
    return target;
  };

  /**
   * Вся дневная история бумаги, один раз на процесс. Колонки выгрузки биржи:
   * дата, закрытие, изменение, объём (шт.), оборот (UZS), открытие, максимум, минимум, капитализация, выпуск
   */
  private fetchDaily = memoize(
    ([ticker]) => ticker,
    async (ticker: string): Promise<TRawCandle[]> => {
      const path = await this.ensureExport(ticker);
      const workbook = readWorkbook(readFileSync(path), { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = xlsxUtils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
      const candles: TRawCandle[] = [];
      for (const row of rows.slice(1)) {
        const [date, close, , volume, , open, high, low] = row;
        if (typeof date !== "string" || !/^\d\d\.\d\d\.\d{4}$/.test(date)) {
          continue;
        }
        candles.push([parseDate(date), Number(open), Number(high), Number(low), Number(close), Number(volume ?? 0)]);
      }
      candles.sort((a, b) => a[0]! - b[0]!);
      if (candles.length) {
        console.log(`UzSE ${ticker}: ${candles.length} daily bars ${new Date(candles[0][0]!).toISOString().slice(0, 10)} .. ${new Date(candles[candles.length - 1][0]!).toISOString().slice(0, 10)}`);
      } else {
        console.warn(`UzSE ${ticker}: export has no daily bars`);
      }
      return candles;
    },
  );

  /** История бумаги; неудачная выгрузка (лимит биржи, обрыв) не остаётся в кэше процесса */
  private getDaily = async (ticker: string): Promise<TRawCandle[]> => {
    try {
      return await this.fetchDaily(ticker);
    } catch (error) {
      this.fetchDaily.clear(ticker);
      throw error;
    }
  };

  public getCandles = async (symbol: string, interval: string, since: number, limit: number): Promise<TRawCandle[]> => {
    if (interval !== "1d") {
      throw new Error(`UzSE: unsupported interval ${interval}, the exchange publishes daily bars only`);
    }
    const start = Math.floor(since / DAY_MS) * DAY_MS;
    const all = await this.getDaily(symbol);
    const out: TRawCandle[] = [];
    for (const candle of all) {
      if (candle[0]! < start) {
        continue;
      }
      out.push(candle);
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  };
}

export const UzSE = new UzSEUtils();
