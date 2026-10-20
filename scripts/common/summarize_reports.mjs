// Сводка по годовым папкам фонда акций UzSE: читает content/<yyyy>/dump/report/backtest.jsonl
// (открытия и закрытия) и strategy.jsonl (начисления дивидендов через commitDividend).
// Все суммы в сумах; долларовый столбец пересчитан по курсу UZS=X с Yahoo на начало и конец года
// (кэш tmp/uzse/uzs_usd.json). Запуск из корня репо: node scripts/common/summarize_reports.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPOSIT = 10_000_000;            // DEPOSIT_UZS в main.strategy.ts
const ROUND_TRIP_COST = (0.15 + 0.5) * 2 / 100; // CC_PERCENT_FEE и CC_PERCENT_SLIPPAGE на входе и выходе
const FX_CACHE = join(ROOT, "tmp", "uzse", "uzs_usd.json");

const readRows = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const folders = readdirSync(join(ROOT, "content")).filter((f) => /^\d{4}$/.test(f)).sort();

// Курс сума: дневные закрытия UZS=X, один запрос, кэш на диске
const loadFx = async () => {
  if (existsSync(FX_CACHE)) return JSON.parse(readFileSync(FX_CACHE, "utf8"));
  const r = await fetch("https://query2.finance.yahoo.com/v8/finance/chart/UZS=X?range=15y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const res = (await r.json()).chart.result[0];
  const out = {};
  res.timestamp.forEach((t, i) => { const c = res.indicators.quote[0].close[i]; if (c) out[new Date(t * 1000).toISOString().slice(0, 10)] = c; });
  mkdirSync(dirname(FX_CACHE), { recursive: true });
  writeFileSync(FX_CACHE, JSON.stringify(out));
  return out;
};
const fx = await loadFx();
const fxAt = (iso) => { if (!fx) return null; const days = Object.keys(fx).sort(); let best = null; for (const d of days) { if (d <= iso) best = d; else break; } return best ? fx[best] : null; };

const years = []; const allClosed = [];
for (const folder of folders) {
  const report = join(ROOT, "content", folder, "dump", "report");
  const rows = readRows(join(report, "backtest.jsonl"));
  if (!rows.length) { years.push({ folder, missing: true }); continue; }
  const opened = rows.filter((r) => r.data.action === "opened");
  const closed = rows.filter((r) => r.data.action === "closed");
  const dividends = readRows(join(report, "strategy.jsonl")).filter((r) => r.data.action === "dividend");
  const net = closed.reduce((s, r) => s + r.data.pnlCost, 0);
  const divSum = dividends.reduce((s, r) => s + r.data.amount, 0);
  const fees = closed.reduce((s, r) => s + r.data.cost * ROUND_TRIP_COST, 0);
  const reasons = {};
  for (const r of closed) reasons[r.data.closeReason] = (reasons[r.data.closeReason] ?? 0) + 1;
  const fxStart = fxAt(`${folder}-01-01`), fxEnd = fxAt(`${folder}-12-31`);
  const usd = fxStart && fxEnd ? (DEPOSIT + net) / fxEnd - DEPOSIT / fxStart : null;
  years.push({ folder, opened: opened.length, closed: closed.length, symbols: new Set(opened.map((r) => r.symbol)).size, net, divSum, fees, reasons, usd, fxStart, fxEnd,
    divBySymbol: dividends.map((r) => `${r.data.symbol}:${(r.data.amount / 1e3).toFixed(0)}k`).join(" ") });
  for (const r of closed) allClosed.push({ ...r.data, year: folder });
}

const pct = (x) => `${(x / DEPOSIT * 100).toFixed(1).padStart(6)}%`;
const mln = (x) => `${(x / 1e6).toFixed(2).padStart(7)}`;
console.log(`deposit ${DEPOSIT.toLocaleString("en-US")} UZS per year, ${folders.length} year folders, ${years.filter((y) => !y.missing).length} with reports; round trip cost ${(ROUND_TRIP_COST * 100).toFixed(1)}%\n`);
console.log("year  names opened closed   net,mln   net%   price,mln  dividends,mln  fees,mln   usd$   closes");
let cum = 0, peak = 0, maxDd = 0;
for (const y of years) {
  if (y.missing) { console.log(`${y.folder}  (no report)`); continue; }
  cum += y.net; peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak);
  const flags = y.opened !== y.closed ? " OPEN!=CLOSED" : "";
  console.log(`${y.folder}  ${String(y.symbols).padStart(5)} ${String(y.opened).padStart(6)} ${String(y.closed).padStart(6)} ${mln(y.net)} ${pct(y.net)} ${mln(y.net - y.divSum)}    ${mln(y.divSum)}    ${mln(y.fees)} ${y.usd == null ? "    n/a" : String(Math.round(y.usd)).padStart(7)}   ${Object.entries(y.reasons).map(([k, v]) => `${k}:${v}`).join(" ")}${flags}`);
  if (y.divBySymbol) console.log(`        dividends: ${y.divBySymbol}`);
}
const done = years.filter((y) => !y.missing);
const tot = done.reduce((a, y) => ({ net: a.net + y.net, div: a.div + y.divSum, fees: a.fees + y.fees, usd: a.usd + (y.usd ?? 0) }), { net: 0, div: 0, fees: 0, usd: 0 });
console.log(`\nTOTAL ${done.length} years: net ${mln(tot.net)} mln UZS (${(tot.net / DEPOSIT * 100).toFixed(0)}% of the yearly deposit, ${(tot.net / DEPOSIT * 100 / done.length).toFixed(1)}%/y simple), dividends ${mln(tot.div)} mln, fees ${mln(tot.fees)} mln, in USD ${Math.round(tot.usd)}$`);
console.log(`cumulative P&L: final ${mln(cum)} mln, peak ${mln(peak)} mln, max drawdown ${mln(maxDd)} mln`);
if (fx) console.log(`UZS per USD: ${done.map((y) => `${y.folder}: ${Math.round(y.fxStart)}→${Math.round(y.fxEnd)}`).join(", ")}`);

const nonTime = allClosed.filter((r) => r.closeReason !== "time_expired");
if (nonTime.length) {
  console.log(`\n${nonTime.length} closes not by time:`);
  for (const r of nonTime) console.log(`  ${r.year} ${r.symbol.padEnd(6)} ${r.closeReason.padEnd(12)} pnl ${r.pnl.toFixed(1).padStart(6)}%  open ${r.priceOpen} close ${r.pnlPriceClose}`);
}
