// Собирает корзины годовых папок content/<yyyy>/ из ликвидности акций UzSE: для года Y берутся
// акции с достаточным оборотом в году Y-1 (известен до начала года), топ-N по медианному дневному
// обороту. Источник - страницы бумаг uzse.uz (/isu_infos/STK?isu_cd=...&begin_date=..&end_date=..),
// где дневной ряд лежит прямо в HTML; кэш в tmp/uzse/pages/, --refresh перекачивает.
//
// Запуск из корня репо: node scripts/common/build_universe.mjs [--refresh] [--top 10]
// Результат: scripts/common/universe.json (годы, корзины, причины исключений).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGES = join(ROOT, "tmp", "uzse", "pages");
const ISSUERS = JSON.parse(readFileSync(join(ROOT, "scripts/common/uzse_issuers.json"), "utf8"));
const OUT = join(ROOT, "scripts/common/universe.json");
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const REFRESH = process.argv.includes("--refresh");
const TOP = Number(arg("top", 10));

/** Пороги ликвидности по году Y-1: медианный дневной оборот в сумах и доля дней со сделками */
const MIN_MEDIAN_TURNOVER_UZS = 1_000_000;
const MIN_ACTIVE_SHARE = 0.9;
const MIN_TRADING_DAYS = 200;
/** Минимальный размер корзины: меньше - год не торгуется */
const MIN_BASKET = 3;
/** Скачок закрытия между соседними торговыми днями со сделками: дробление или консолидация, ряд биржи не скорректирован */
const SPLIT_UP = 1.8;
const SPLIT_DOWN = 0.55;

const H = { "User-Agent": "Mozilla/5.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const today = new Date();
const fmt = (d) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

const scrape = async () => {
  mkdirSync(PAGES, { recursive: true });
  const names = await (await fetch("https://uzse.uz/isu_infos/names?mkt_id=STK", { headers: H })).json();
  writeFileSync(join(ROOT, "tmp/uzse/names.json"), JSON.stringify(names));
  for (const [isin, ticker] of names) {
    const out = join(PAGES, `${ticker}_${isin}.json`);
    if (existsSync(out) && !REFRESH) continue;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(`https://uzse.uz/isu_infos/STK?isu_cd=${isin}&begin_date=01.01.2010&end_date=${fmt(today)}`, { headers: H });
      if (r.status === 429) { console.log(`429 ${ticker}, waiting 60s`); await sleep(60_000); continue; }
      const s = await r.text();
      const ohlc = [...s.matchAll(/moment\("(\d{8})", "YYYYMMDD"\)\._d\.valueOf\(\),\s*([\d.eE+-]+),\s*([\d.eE+-]+),\s*([\d.eE+-]+),\s*([\d.eE+-]+),\s*(\d+)/g)].map((m) => [m[1], +m[2], +m[3], +m[4], +m[5], +m[6]]);
      const table = [...s.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).find((t) => t.includes("Цена закрытия"));
      const daily = [];
      if (table) for (const row of table.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
        const cells = [...row[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => clean(c[1]));
        if (/^\d\d\.\d\d\.\d{4}$/.test(cells[0] || "")) daily.push([cells[0], +cells[1].replace(/,/g, ""), +(cells[3] || "0").replace(/,/g, ""), +(cells[4] || "0").replace(/,/g, "")]);
      }
      writeFileSync(out, JSON.stringify({ isin, ticker, ohlc, daily }));
      console.log("ok", ticker, daily.length);
      break;
    }
    await sleep(1500);
  }
};
if (REFRESH || !existsSync(PAGES) || !readdirSync(PAGES).length) await scrape();

// daily: [dd.mm.yyyy, close, qty, turnoverUZS]; дни без сделок биржа тоже отдаёт (с нулевым оборотом)
const parseDate = (s) => { const [d, m, y] = s.split(".").map(Number); return Date.UTC(y, m - 1, d); };
const series = {};
for (const file of readdirSync(PAGES)) {
  const { ticker, daily } = JSON.parse(readFileSync(join(PAGES, file), "utf8"));
  // Нулевое закрытие - битая строка биржи (21.04.2026 такие у всего рынка), в статистику не идёт
  series[ticker] = daily.filter(([, close]) => close > 0).map(([d, close, qty, turnover]) => ({ t: parseDate(d), close, qty, turnover })).sort((a, b) => a.t - b.t);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const yearOf = (t) => new Date(t).getUTCFullYear();
const statsOf = (rows) => ({ days: rows.length, median: median(rows.map((r) => r.turnover)), active: rows.length ? rows.filter((r) => r.turnover > 0).length / rows.length : 0 });
const splitYears = (rows) => {
  const out = new Set(); let prev = null;
  for (const r of rows) {
    if (r.qty > 0) { if (prev && (r.close / prev.close >= SPLIT_UP || r.close / prev.close <= SPLIT_DOWN)) out.add(yearOf(r.t)); prev = r; }
  }
  return out;
};

const firstYear = 2018;
const lastYear = today.getUTCFullYear();
const years = {};
for (let y = firstYear; y <= lastYear; y++) {
  const ranked = []; const excluded = {};
  for (const [ticker, rows] of Object.entries(series)) {
    const prev = rows.filter((r) => yearOf(r.t) === y - 1);
    if (!rows.length || yearOf(rows[0].t) >= y - 1) { continue; } // нужна история с начала года Y-1
    const s = statsOf(prev);
    if (s.days < MIN_TRADING_DAYS) { excluded[ticker] = `only ${s.days} trading days in ${y - 1}`; continue; }
    if (s.median < MIN_MEDIAN_TURNOVER_UZS) { continue; }
    if (s.active < MIN_ACTIVE_SHARE) { excluded[ticker] = `traded on ${(s.active * 100).toFixed(0)}% of days in ${y - 1}`; continue; }
    if (!(ticker in ISSUERS)) { excluded[ticker] = "no issuer id in uzse_issuers.json (dividends unknown)"; continue; }
    const splits = splitYears(rows);
    if (splits.has(y)) { excluded[ticker] = `split-like close jump inside ${y} (exchange series is not adjusted)`; continue; }
    ranked.push({ ticker, medianTurnover: Math.round(s.median), active: +s.active.toFixed(2) });
  }
  ranked.sort((a, b) => b.medianTurnover - a.medianTurnover);
  const basket = ranked.slice(0, TOP);
  if (basket.length < MIN_BASKET) { console.log(`${y}: skipped, only ${basket.length} liquid names ranked by ${y - 1}`); continue; }
  years[y] = { rankedBy: String(y - 1), basket: basket.map((b) => b.ticker), liquidity: basket, excluded };
  console.log(`${y} (by ${y - 1}): ${basket.map((b) => `${b.ticker}(${(b.medianTurnover / 1e6).toFixed(1)}M)`).join(" ")}${Object.keys(excluded).length ? `  | excluded: ${Object.entries(excluded).map(([t, r]) => `${t}: ${r}`).join("; ")}` : ""}`);
}
writeFileSync(OUT, JSON.stringify({ generatedAt: today.toISOString(), rules: { MIN_MEDIAN_TURNOVER_UZS, MIN_ACTIVE_SHARE, MIN_TRADING_DAYS, MIN_BASKET, TOP, SPLIT_UP, SPLIT_DOWN }, years }, null, 1) + "\n");
console.log(`\n${Object.keys(years).length} years -> ${OUT}`);
