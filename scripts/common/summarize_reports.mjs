// Сводка по годовым папкам стратегии захвата дивидендов UzSE: читает content/<yyyy>/dump/report/backtest.jsonl
// (открытия и закрытия) и strategy.jsonl (начисления дивидендов через commitDividend).
// Капитал вне позиций считается размещённым на депозите по ставке CASH_RATE годовых; занятый капитал
// считается по дням из открытий и закрытий, превышение депозита в пиковые дни показывается отдельно.
// Все суммы в сумах; долларовый столбец по курсу UZS=X с Yahoo (кэш tmp/uzse/uzs_usd.json).
// Запуск из корня репо: node scripts/common/summarize_reports.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPOSIT = 10_000_000;                   // DEPOSIT_UZS в main.strategy.ts
const CASH_RATE = 0.20;                       // ставка банковского депозита в сумах, годовых
const ROUND_TRIP_COST = (0.15 + 0.5) * 2 / 100; // CC_PERCENT_FEE и CC_PERCENT_SLIPPAGE на входе и выходе
const FX_CACHE = join(ROOT, "tmp", "uzse", "uzs_usd.json");
const DAY_MS = 86_400_000;

const readRows = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const folders = readdirSync(join(ROOT, "content")).filter((f) => /^\d{4}$/.test(f)).sort();

const loadFx = async () => {
  if (existsSync(FX_CACHE)) return JSON.parse(readFileSync(FX_CACHE, "utf8"));
  try {
    const r = await fetch("https://query2.finance.yahoo.com/v8/finance/chart/UZS=X?range=15y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const res = (await r.json()).chart.result[0];
    const out = {};
    res.timestamp.forEach((t, i) => { const c = res.indicators.quote[0].close[i]; if (c) out[new Date(t * 1000).toISOString().slice(0, 10)] = c; });
    mkdirSync(dirname(FX_CACHE), { recursive: true });
    writeFileSync(FX_CACHE, JSON.stringify(out));
    return out;
  } catch { return null; }
};
const fx = await loadFx();
const fxAt = (iso) => { if (!fx) return null; let best = null; for (const d of Object.keys(fx).sort()) { if (d <= iso) best = d; else break; } return best ? fx[best] : null; };

const mln = (x) => (x / 1e6).toFixed(2).padStart(6);
const pct = (x) => `${(x / DEPOSIT * 100).toFixed(1).padStart(5)}%`;
const years = []; const allClosed = [];
for (const folder of folders) {
  const report = join(ROOT, "content", folder, "dump", "report");
  const rows = readRows(join(report, "backtest.jsonl"));
  if (!rows.length) { years.push({ folder, missing: true }); continue; }
  const opened = rows.filter((r) => r.data.action === "opened");
  const closed = rows.filter((r) => r.data.action === "closed");
  const dividends = readRows(join(report, "strategy.jsonl")).filter((r) => r.data.action === "dividend");
  const eventPnl = closed.reduce((s, r) => s + r.data.pnlCost, 0);
  const divSum = dividends.reduce((s, r) => s + r.data.amount, 0);
  const fees = closed.reduce((s, r) => s + r.data.cost * ROUND_TRIP_COST, 0);
  const wins = closed.filter((r) => r.data.pnlCost > 0).length;
  // Занятый капитал по дням года: сумма cost открытых позиций
  const y0 = Date.UTC(Number(folder), 0, 1), y1 = Date.UTC(Number(folder) + 1, 0, 1);
  const days = Math.round((y1 - y0) / DAY_MS);
  const deployed = new Float64Array(days);
  for (const r of closed) {
    const openedAt = r.data.openTime ?? r.data.pendingAt, closedAt = r.data.closeTime ?? r.data.timestamp;
    const from = Math.max(0, Math.floor((openedAt - y0) / DAY_MS)), to = Math.min(days - 1, Math.floor((closedAt - y0) / DAY_MS));
    for (let d = from; d <= to; d++) deployed[d] += r.data.cost;
  }
  let cashYield = 0, peak = 0, overDays = 0;
  for (let d = 0; d < days; d++) { peak = Math.max(peak, deployed[d]); if (deployed[d] > DEPOSIT) overDays++; cashYield += Math.max(0, DEPOSIT - deployed[d]) * CASH_RATE / 365; }
  const total = eventPnl + cashYield;
  const fxStart = fxAt(`${folder}-01-01`), fxEnd = fxAt(`${folder}-12-31`);
  const usd = fxStart && fxEnd ? (DEPOSIT + total) / fxEnd - DEPOSIT / fxStart : null;
  const reasons = {};
  for (const r of closed) reasons[r.data.closeReason] = (reasons[r.data.closeReason] ?? 0) + 1;
  years.push({ folder, opened: opened.length, closed: closed.length, wins, eventPnl, divSum, fees, cashYield, total, peak, overDays, usd, reasons,
    events: closed.map((r) => `${r.symbol}:${(r.data.pnlCost / 1e3).toFixed(0)}k`).join(" ") });
  for (const r of closed) allClosed.push({ ...r.data, year: folder });
}

console.log(`deposit ${DEPOSIT.toLocaleString("en-US")} UZS, cash rate ${CASH_RATE * 100}%/y on idle capital, round trip cost ${(ROUND_TRIP_COST * 100).toFixed(1)}%, ${folders.length} year folders, ${years.filter((y) => !y.missing).length} with reports\n`);
console.log("year  events wins  eventP&L,mln  of which dividends  fees,mln  idle cash,mln  TOTAL,mln  total%  cash-only  peak deployed,mln  usd$  closes");
for (const y of years) {
  if (y.missing) { console.log(`${y.folder}  (no report)`); continue; }
  const flags = (y.opened !== y.closed ? " OPEN!=CLOSED" : "") + (y.overDays ? ` OVER-DEPOSIT ${y.overDays}d` : "");
  console.log(`${y.folder}  ${String(y.closed).padStart(5)} ${String(y.wins).padStart(4)}   ${mln(y.eventPnl)}        ${mln(y.divSum)}      ${mln(y.fees)}     ${mln(y.cashYield)}     ${mln(y.total)}  ${pct(y.total)}   ${mln(DEPOSIT * CASH_RATE)}        ${mln(y.peak)}  ${y.usd == null ? "  n/a" : String(Math.round(y.usd)).padStart(5)}  ${Object.entries(y.reasons).map(([k, v]) => `${k}:${v}`).join(" ")}${flags}`);
  if (y.events) console.log(`        events: ${y.events}`);
}
const done = years.filter((y) => !y.missing);
const tot = done.reduce((a, y) => ({ ev: a.ev + y.eventPnl, div: a.div + y.divSum, cash: a.cash + y.cashYield, total: a.total + y.total, n: a.n + y.closed, w: a.w + y.wins }), { ev: 0, div: 0, cash: 0, total: 0, n: 0, w: 0 });
console.log(`\nTOTAL ${done.length} years: ${tot.n} events, ${tot.n ? (tot.w / tot.n * 100).toFixed(0) : 0}% positive, event P&L ${mln(tot.ev)} mln (dividends ${mln(tot.div)}), idle cash ${mln(tot.cash)} mln, total ${mln(tot.total)} mln = ${(tot.total / DEPOSIT / done.length * 100).toFixed(1)}%/y vs cash-only ${(CASH_RATE * 100).toFixed(0)}%/y; excess over cash ${mln(tot.total - DEPOSIT * CASH_RATE * done.length)} mln`);

const nonTime = allClosed.filter((r) => r.closeReason !== "time_expired");
if (nonTime.length) {
  console.log(`\n${nonTime.length} closes not by time:`);
  for (const r of nonTime) console.log(`  ${r.year} ${r.symbol.padEnd(6)} ${r.closeReason.padEnd(12)} pnl ${r.pnl.toFixed(1).padStart(6)}%  open ${r.priceOpen} close ${r.pnlPriceClose}`);
}
