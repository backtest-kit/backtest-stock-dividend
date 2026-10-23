import {
  addLauncherSchema,
  addStrategySchema,
  commitDividend,
  getCandles,
  listenActivePing,
  Position,
} from "backtest-kit";

import { UzSEDividends } from "./classes/UzSEDividends";

// Параметры движка (издержки, дневной шаг, дистанции стопа и тейка) общие для всех годов и заданы в config/loader.config.ts

// Стратегия: захват дивиденда вокруг собрания акционеров. На UzSE цена после решения о дивиденде
// не падает на его размер: при доходности 8-15% к цене чистое движение цены за окно около -3%.
// Вход за ENTRY_DAYS до даты решения, выход через EXIT_DAYS после неё, дивиденд начисляется
// на дату решения. Остальное время капитал свободен (ставка депозита учитывается в сводке).
const DEPOSIT_UZS = 10_000_000;
// Доля депозита на одно событие и потолок по ликвидности: не больше LIQUIDITY_SHARE медианного
// дневного оборота за TURNOVER_DAYS дней, набранных за ENTRY_DAYS дней входа
const SLOT_UZS = DEPOSIT_UZS / 3;
const LIQUIDITY_SHARE = 0.25;
const TURNOVER_DAYS = 20;
const MIN_POSITION_UZS = 200_000;

const ENTRY_DAYS = 10;
const EXIT_DAYS = 5;
const MIN_DIVIDEND_YIELD = 0.08;

// Уровни технические: за три недели -50% на споте маловероятен, штатный выход по времени
const STOP_LOSS_PERCENT = 50;
const TAKE_PROFIT_PERCENT = 2000;

const DAY_MS = 86_400_000;

// BASKET:BEGIN
// 2020: акции UzSE с эмитентом в таблице дивидендов, историей от начала 2019, сделками не реже
// 50% дней 2019 года и без дроблений внутри года. Сгенерировано scripts/common/generate_months.mjs
// из scripts/common/universe.json.
const BASKET = [
  "QZSM",
  "KVTS",
  "AGMKP",
  "SQBN",
  "HMKB",
  "SQBNP",
  "IPTB",
  "IPTBP",
];
// BASKET:END

// ISSUERS:BEGIN
// Тикер -> id эмитента в таблице дивидендов биржи (scripts/common/uzse_issuers.json)
const ISSUER_IDS: Record<string, number> = {
  QZSM: 17,
  KVTS: 21,
  AGMKP: 12,
  SQBN: 2,
  HMKB: 5,
  SQBNP: 2,
  IPTB: 4,
  IPTBP: 4,
};
// ISSUERS:END

const kindOf = (symbol: string) => (symbol.endsWith("P") ? "preferred" : "common");

// Начисленные дивиденды: ключ позиция + финансовый год, чтобы решение не начислилось дважды
const credited = new Set<string>();

addStrategySchema({
  strategyName: "uzse_dividend_capture",
  interval: "1h",
  getSignal: async (symbol, when, currentPrice) => {

    // Ближайшее собрание в окне входа; решение, до которого больше ENTRY_DAYS, ещё не торгуется
    const [upcoming] = await UzSEDividends.getUpcoming(ISSUER_IDS[symbol], kindOf(symbol), when, ENTRY_DAYS);
    if (!upcoming) {
      return null;
    }
    const dividendYield = upcoming.perShare / currentPrice;
    if (dividendYield < MIN_DIVIDEND_YIELD) {
      return null;
    }

    // Размер по ликвидности: медианный дневной оборот за TURNOVER_DAYS закрытых дней
    const daily = await getCandles(symbol, "1d", TURNOVER_DAYS);
    const turnovers = daily.map((candle) => candle.close * candle.volume).sort((a, b) => a - b);
    const medianTurnover = turnovers.length ? turnovers[Math.floor(turnovers.length / 2)] : 0;
    const cost = Math.min(SLOT_UZS, LIQUIDITY_SHARE * medianTurnover * ENTRY_DAYS);
    if (cost < MIN_POSITION_UZS) {
      return null;
    }

    // Выход в 23:59 дня decisionDate + EXIT_DAYS
    const exitAt = upcoming.decisionDate + EXIT_DAYS * DAY_MS + DAY_MS - 60_000;
    const holdMinutes = Math.floor((exitAt - when.getTime()) / 60_000);
    if (holdMinutes < 24 * 60) {
      return null;
    }

    return {
      id: `${symbol.toLowerCase()}-fy${upcoming.fiscalYear}-${when.toISOString().slice(0, 10)}`,
      symbol,
      ...Position.bracket({
        position: "long",
        currentPrice,
        percentStopLoss: STOP_LOSS_PERCENT,
        percentTakeProfit: TAKE_PROFIT_PERCENT,
      }),
      cost: Math.round(cost),
      minuteEstimatedTime: holdMinutes,
      payload: {
        fiscalYear: upcoming.fiscalYear,
        decisionDate: new Date(upcoming.decisionDate).toISOString().slice(0, 10),
        perShare: upcoming.perShare,
        dividendYield,
        medianTurnover,
        issuerId: ISSUER_IDS[symbol],
      },
      note: `${symbol} FY${upcoming.fiscalYear} yield=${(dividendYield * 100).toFixed(1)}% cost=${cost.toFixed(0)} UZS decision=${new Date(upcoming.decisionDate).toISOString().slice(0, 10)}`,
    };
  },
});

// Дивиденд начисляется на дату решения собрания, если оно принято за время жизни позиции.
// Движок сам календаря не ведёт: когда и сколько - решает стратегия, он лишь складывает
// сумму в pnlCost позиции (строки action=dividend в dump/report/strategy.jsonl), стоп и тейк
// это не трогает. listenActivePing приходит на каждом шаге по каждой активной позиции,
// timestamp события это логическое время движка, не часы машины.
listenActivePing(async ({ symbol, data, timestamp }) => {
  const when = new Date(timestamp);
  const shares = data.cost / data.priceOpen;
  for (const dividend of await UzSEDividends.getDividends(ISSUER_IDS[symbol], kindOf(symbol), when)) {
    if (dividend.decisionDate < data.pendingAt) {
      continue;
    }
    const key = `${data.id}:${dividend.fiscalYear}`;
    if (credited.has(key)) {
      continue;
    }
    credited.add(key);
    const amount = Math.round(dividend.perShare * shares * 100) / 100;
    await commitDividend(symbol, {
      amount,
      note: `FY${dividend.fiscalYear}: ${dividend.perShare} UZS/share x ${shares.toFixed(2)}, decision ${new Date(dividend.decisionDate).toISOString().slice(0, 10)}`,
    });
  }
});

addLauncherSchema({
  launcherName: "main_launcher",
  backtest: true,
  symbolList: BASKET,
  cache: false,
});
