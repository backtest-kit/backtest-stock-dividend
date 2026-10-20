import { memoize } from "functools-kit";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Одно решение о дивидендах эмитента за финансовый год */
export interface IDividend {
  /** Финансовый год, за который платят */
  fiscalYear: number;
  /** Дата решения общего собрания, ms UTC: с этого дня размер дивиденда известен */
  decisionDate: number;
  /** Дивиденд на одну акцию запрошенного типа, в сумах */
  perShare: number;
  /** Окно выплаты по данным биржи, ms UTC; null, если биржа его не указала */
  payoutStart: number | null;
  payoutEnd: number | null;
}

export type TShareKind = "common" | "preferred";

/** Страница биржи с таблицей дивидендов всех эмитентов: данные лежат в HTML как window.DIVIDENDS_DATA */
const DIVIDENDS_PAGE = "https://uzse.uz/dividends?locale=ru";
/** Та же постоянная папка, что у выгрузок свечей UzSE */
const CACHE_DIR = join(tmpdir(), "backtest-kit", "uzse");
const CACHE_FILE = "dividends.html";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

/** Запись биржи за один год: dd - дата решения, dc/dp - дивиденд на обыкновенную/привилегированную акцию, ps/pe - окно выплаты */
interface IExchangeYearRow {
  y: number;
  dd: string | null;
  dc: number | null;
  dp: number | null;
  ps: string | null;
  pe: string | null;
}

interface IExchangeIssuer {
  id: number;
  name: string;
  years: IExchangeYearRow[];
}

const parseIsoDate = (value: string | null): number | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  return Date.parse(`${value}T00:00:00Z`);
};

/**
 * Дивиденды эмитентов UzSE для commitDividend.
 *
 * Биржа публикует по каждому эмитенту и финансовому году дату решения собрания, дивиденд на
 * обыкновенную и на привилегированную акцию и окно выплаты. Даты закрытия реестра нет, поэтому
 * моментом начисления считается дата решения: раньше неё размер дивиденда неизвестен, и
 * getDividends отдаёт только решения с датой не позже `when` - заглядывания вперёд нет.
 *
 * Страница качается один раз в CACHE_DIR (через .part с переименованием) и дальше читается с диска.
 * Эмитент задаётся его id в таблице биржи; соответствие тикер -> id лежит в стратегии рядом с корзиной.
 */
export class UzSEDividendsUtils {

  private ensurePage = async (): Promise<string> => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const target = join(CACHE_DIR, CACHE_FILE);
    if (existsSync(target)) {
      return target;
    }
    const partial = `${target}.part`;
    if (existsSync(partial)) {
      unlinkSync(partial);
    }
    const response = await fetch(DIVIDENDS_PAGE, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`UzSEDividends: HTTP ${response.status}`);
    }
    const html = await response.text();
    if (!html.includes("window.DIVIDENDS_DATA")) {
      throw new Error("UzSEDividends: the page has no DIVIDENDS_DATA block, the exchange changed the layout");
    }
    writeFileSync(partial, html);
    renameSync(partial, target);
    console.log(`UzSEDividends: saved ${html.length} bytes to ${target}`);
    return target;
  };

  /** Таблица биржи целиком, один раз на процесс: id эмитента -> записи по годам */
  private fetchAll = memoize(
    () => "dividends",
    async (): Promise<Map<number, IExchangeIssuer>> => {
      const html = readFileSync(await this.ensurePage(), "utf8");
      const match = /window\.DIVIDENDS_DATA\s*=\s*(\[[\s\S]*?\]);\s*\n/.exec(html);
      if (!match) {
        throw new Error("UzSEDividends: cannot parse DIVIDENDS_DATA");
      }
      const issuers = JSON.parse(match[1]) as IExchangeIssuer[];
      console.log(`UzSEDividends: ${issuers.length} issuers, fiscal years ${Math.min(...issuers.flatMap((i) => i.years.map((y) => y.y)))} .. ${Math.max(...issuers.flatMap((i) => i.years.map((y) => y.y)))}`);
      return new Map(issuers.map((issuer) => [issuer.id, issuer]));
    },
  );

  /**
   * Решения о дивидендах эмитента, известные на момент when (дата решения <= when), по возрастанию
   * даты. kind - тип акции: обыкновенная или привилегированная. Годы без выплаты пропускаются.
   */
  public getDividends = async (issuerId: number, kind: TShareKind, when: Date): Promise<IDividend[]> => {
    const issuer = (await this.fetchAll()).get(issuerId);
    if (!issuer) {
      throw new Error(`UzSEDividends: unknown issuer id ${issuerId}`);
    }
    const out: IDividend[] = [];
    for (const row of issuer.years) {
      const perShare = kind === "preferred" ? row.dp : row.dc;
      const decisionDate = parseIsoDate(row.dd);
      if (!perShare || perShare <= 0 || decisionDate === null || decisionDate > when.getTime()) {
        continue;
      }
      out.push({ fiscalYear: row.y, decisionDate, perShare, payoutStart: parseIsoDate(row.ps), payoutEnd: parseIsoDate(row.pe) });
    }
    return out.sort((a, b) => a.decisionDate - b.decisionDate);
  };

  /** Название эмитента по id, для отчётов */
  public getIssuerName = async (issuerId: number): Promise<string | null> =>
    (await this.fetchAll()).get(issuerId)?.name ?? null;
}

export const UzSEDividends = new UzSEDividendsUtils();
