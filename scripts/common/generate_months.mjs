// Штампует годовые папки content/<yyyy>/ копипастой из эталонного года: код стратегии, биржи и
// классов копируется как есть, подставляются только корзина (блок BASKET:BEGIN..BASKET:END),
// соответствие тикер -> эмитент (блок ISSUERS:BEGIN..ISSUERS:END) в main.strategy.ts и фрейм года
// в modules/backtest.module.ts. Общего кода между папками нет. Незавершённый год не штампуется.
// Заодно переписывает scripts/linux/run_strategy.sh и scripts/win/run_strategy.bat.
//
// Запуск из корня репо: node scripts/common/generate_months.mjs [--source content/2021]
// Источник корзин: scripts/common/universe.json (см. build_universe.mjs), эмитенты: uzse_issuers.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SOURCE = join(ROOT, arg("source", "content/2021"));
const universe = JSON.parse(readFileSync(join(ROOT, "scripts/common/universe.json"), "utf8"));
const issuers = JSON.parse(readFileSync(join(ROOT, "scripts/common/uzse_issuers.json"), "utf8"));
const { MIN_MEDIAN_TURNOVER_UZS, MIN_ACTIVE_SHARE } = universe.rules;

const strategySource = readFileSync(join(SOURCE, "main.strategy.ts"), "utf8");
const moduleSource = readFileSync(join(SOURCE, "modules/backtest.module.ts"), "utf8");
for (const [file, source, block] of [["main.strategy.ts", strategySource, "BASKET"], ["main.strategy.ts", strategySource, "ISSUERS"]]) {
  if (!new RegExp(`// ${block}:BEGIN[\\s\\S]*// ${block}:END`).test(source)) {
    throw new Error(`${SOURCE}/${file}: нет блока // ${block}:BEGIN .. // ${block}:END`);
  }
}
if (!/frameName: "[^"]*"/.test(moduleSource) || !/startDate: new Date\("[^"]*"\)/.test(moduleSource)) {
  throw new Error(`${SOURCE}/modules/backtest.module.ts: нет фрейма`);
}

const generated = [];
for (const [year, { rankedBy, basket }] of Object.entries(universe.years)) {
  if (Date.UTC(Number(year), 11, 31, 23, 59, 59) > Date.now()) {
    console.log(`skip ${year}: year not finished`);
    continue;
  }
  const missing = basket.filter((ticker) => !(ticker in issuers));
  if (missing.length) {
    throw new Error(`${year}: нет id эмитента для ${missing.join(", ")} в scripts/common/uzse_issuers.json`);
  }
  const dir = join(ROOT, "content", year);
  mkdirSync(join(dir, "modules"), { recursive: true });

  const basketBlock = [
    "// BASKET:BEGIN",
    `// ${year}: акции UzSE с медианным дневным оборотом за ${rankedBy} от ${MIN_MEDIAN_TURNOVER_UZS / 1e6} млн сумов, сделки не реже ${MIN_ACTIVE_SHARE * 100}% дней,`,
    `// история от начала ${rankedBy}, без дроблений внутри года; топ по обороту. Сгенерировано`,
    "// scripts/common/generate_months.mjs из scripts/common/universe.json.",
    "const BASKET = [",
    ...basket.map((ticker) => `  "${ticker}",`),
    "];",
    "// BASKET:END",
  ].join("\n");
  const issuersBlock = [
    "// ISSUERS:BEGIN",
    "// Тикер -> id эмитента в таблице дивидендов биржи (scripts/common/uzse_issuers.json)",
    "const ISSUER_IDS: Record<string, number> = {",
    ...basket.map((ticker) => `  ${ticker}: ${issuers[ticker]},`),
    "};",
    "// ISSUERS:END",
  ].join("\n");
  const strategy = strategySource
    .replace(/\/\/ BASKET:BEGIN[\s\S]*\/\/ BASKET:END/, basketBlock)
    .replace(/\/\/ ISSUERS:BEGIN[\s\S]*\/\/ ISSUERS:END/, issuersBlock);
  const module = moduleSource
    .replace(/frameName: "[^"]*"/, `frameName: "${year}_frame"`)
    .replace(/startDate: new Date\("[^"]*"\)/, `startDate: new Date("${year}-01-01T00:00:00Z")`)
    .replace(/endDate: new Date\("[^"]*"\)/, `endDate: new Date("${year}-12-31T23:59:59Z")`)
    .replace(/note: "[^"]*"/, `note: "Year ${year}"`);

  writeFileSync(join(dir, "main.strategy.ts"), strategy);
  writeFileSync(join(dir, "modules/backtest.module.ts"), module);
  // classes/ копируются как есть: источники свечей и дивидендов папки года
  if (existsSync(join(SOURCE, "classes"))) {
    mkdirSync(join(dir, "classes"), { recursive: true });
    for (const file of readdirSync(join(SOURCE, "classes"))) {
      copyFileSync(join(SOURCE, "classes", file), join(dir, "classes", file));
    }
  }
  generated.push(year);
}

// Раннеры всех годов: явный список, один процесс на год
const cli = "./node_modules/@backtest-kit/cli/build/index.mjs";
mkdirSync(join(ROOT, "scripts/linux"), { recursive: true });
mkdirSync(join(ROOT, "scripts/win"), { recursive: true });
// Код выхода года не проверяется: стратегия завершает процесс через kill() (SIGKILL, код 137),
// это штатный финал, а не ошибка. Упавший год виден по отсутствию closed в его отчёте.
writeFileSync(join(ROOT, "scripts/linux/run_strategy.sh"), [
  "#!/bin/bash",
  "# Прогон фонда акций UzSE по всем годам, один процесс CLI на год. Нужны поднятые docker/mongo и docker/redis.",
  "# Отчёты: content/<год>/dump/report/backtest.jsonl. Запуск из корня репо: bash scripts/linux/run_strategy.sh",
  "# Каждый год завершается kill() со статусом 137 - это штатно, прогон продолжается; сводка: node scripts/common/summarize_reports.mjs",
  ...generated.map((year) => `node ${cli} --backtest --entry ./content/${year}/main.strategy.ts`),
  "",
].join("\n"));
writeFileSync(join(ROOT, "scripts/win/run_strategy.bat"), [
  "@echo off",
  "REM Прогон фонда акций UzSE по всем годам, один процесс CLI на год. Нужны поднятые docker\\mongo и docker\\redis.",
  "REM Отчёты: content\\<год>\\dump\\report\\backtest.jsonl. Запуск из корня репо: scripts\\win\\run_strategy.bat",
  "REM Каждый год завершается kill() с ненулевым кодом - это штатно, прогон продолжается; сводка: node scripts\\common\\summarize_reports.mjs",
  ...generated.map((year) => `node ${cli.replace(/\//g, "\\")} --backtest --entry .\\content\\${year}\\main.strategy.ts`),
  "",
].join("\r\n"));

console.log(`generated ${generated.length} years: ${generated[0]} .. ${generated[generated.length - 1]}`);
