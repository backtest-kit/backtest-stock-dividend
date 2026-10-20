<img src="https://github.com/tripolskypetr/backtest-kit/raw/refs/heads/master/assets/consciousness.svg" height="45px" align="right">

# 🧿 backtest-uzse-fund

> A yearly dividend fund on the Tashkent stock exchange (UzSE), built on [backtest-kit](https://github.com/tripolskypetr/backtest-kit): a fixed deposit in soum is spread in equal parts over the most liquid shares of the previous year, every position is opened on the first tick of the year and closed by time on 31 December, and every dividend the issuer decides during that year is credited to the position through `commitDividend`. One folder per year, no shared code between years, daily bars and the dividend table taken from the exchange's own site, no API key, no broker connection.

![screenshot](https://raw.githubusercontent.com/tripolskypetr/backtest-kit/HEAD/assets/screenshots/screenshot16.png)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/tripolskypetr/backtest-kit)
[![npm](https://img.shields.io/npm/v/backtest-kit.svg?style=flat-square)](https://npmjs.org/package/backtest-kit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)]()
[![Build](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml/badge.svg)](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml)

A frontier stock market is a different animal from a crypto exchange: a handful of names trade every day, the spread on the best of them is a percent or more, a round trip costs more than a month of expected return, and a large share of the total return arrives as a dividend decided once a year by a shareholders' meeting. A backtest that ignores any of these facts is not wrong by a little, it is wrong in kind. This repo is built around them:

- **The basket is the liquidity of last year.** For year Y the candidates are shares that traded on at least 90% of the days of Y−1 with a median daily turnover above one million soum; the top names by that turnover form the basket. Nothing from year Y is used to pick it.
- **One round trip per name per year.** The position opens on the first hourly tick of 1 January and is closed by the engine's time exit at 23:59 on 31 December. At the costs set in the strategy (0.15% fee and 0.5% slippage per side) a weekly or monthly cycle on this market loses money before it starts; the holding period is the only cost control there is.
- **Dividends are part of the position, not a footnote.** When the exchange's dividend table shows a decision taken while the position is open, the strategy credits `dividend per share × shares` to the position with `commitDividend`. The engine folds it into `pnlCost` and `pnlPercentage`, publishes it as `pnlDividends`, and never lets it touch the stop or the take-profit.
- **The exchange's own data, cached forever.** Daily bars come from the exchange's Excel export (one job per share, rate limited, downloaded once into a persistent cache through a `.part` file), the dividend table from the exchange's dividends page. Both live in `classes/` next to the strategy.

📚 **[API Reference](https://backtest-kit.github.io/documents/example_02_first_backtest.html)** | 🌟 **[Quick Start](https://github.com/tripolskypetr/backtest-kit/tree/master/example)** | 📰 **[Article](https://backtest-kit.github.io/documents/article_08_ai_liquidity_harvesting.html)**


## 🚀 Quick Start

**1. Start the persistence** the engine expects (`config/loader.config.ts` waits for both before loading any strategy):

```bash
npm install
docker compose -f docker/mongo/docker-compose.yaml up -d
docker compose -f docker/redis/docker-compose.yaml up -d
```

**2. Run one year** (the frame and the exchange adapter live next to the strategy, in [content/2021/modules/backtest.module.ts](content/2021/modules/backtest.module.ts)):

```bash
npm start -- --backtest --ui --entry ./content/2021/main.strategy.ts
```

The first run of a share orders its Excel export from the exchange. The exchange allows a few exports per half hour and the class waits out the limit it is told about, so a cold start of a five-name year can take an hour; every later run reads the cached file.

**3. Run every year** in chronological order, one engine process per year:

```bash
bash scripts/linux/run_strategy.sh      # scripts/win/run_strategy.bat on Windows
```

Each year writes `content/<year>/dump/report/backtest.jsonl` with the `opened` and `closed` rows and `strategy.jsonl` with one `dividend` row per credited decision. `node scripts/common/summarize_reports.mjs` folds all years into one table: net result, the part that came from prices and the part that came from dividends, the estimated cost of the round trips, the same result in dollars at the soum rate of the year, and every close that was not the time exit.


## 📐 How the Fund Works

The whole strategy is one file per year, [content/2021/main.strategy.ts](content/2021/main.strategy.ts) being the reference the others are stamped from. Reading it top to bottom:

### The costs

`setConfig` in the strategy sets the engine's fee to 0.15% and slippage to 0.5% per transaction, i.e. 1.3% per round trip, and raises the minimum take-profit distance so that the engine's validator accepts them. These are the numbers for a liquid UzSE share bought and sold at market inside the spread; the HOWTO explains where they come from and how to change them for your broker's tariff.

### The basket

The block between `// BASKET:BEGIN` and `// BASKET:END` is the list of tickers for the year, the block between `// ISSUERS:BEGIN` and `// ISSUERS:END` maps each ticker to the issuer's id in the exchange's dividend table (preferred shares, ticker suffix `P`, take the preferred dividend of the same issuer). Both are generated from [scripts/common/universe.json](scripts/common/universe.json) and [scripts/common/uzse_issuers.json](scripts/common/uzse_issuers.json) and are the only thing that differs between the strategies of two years.

### The cycle

Every ticker gets `deposit / basket size` soum. `minuteEstimatedTime` is computed from the entry time to 23:59 of 31 December, so the first-tick entry and any re-entry after a stop close in the same minute. The stop at −50% is a drawdown cap on a one-year holding and does fire in a crash; the take-profit at +2000% exists only to satisfy the validator. A ticker that is stopped out re-enters on the next tick for the rest of the year.

### The dividends

A top-level `listenActivePing` subscription fires on every engine step for every open position. For the position's issuer it asks the dividend class for every decision dated on or before the current engine time, skips the ones taken before the position was opened and the ones already credited for this position and fiscal year, and commits the rest. The exchange publishes the decision date, not the record date; the HOWTO lists this among the known approximations.


## 🗂 One Folder Per Year, By Construction

`content/<yyyy>/` is a calendar year and is self-contained: the strategy, both data classes and the exchange adapter with the year's frame. There is no shared module between years, which is a rule of this repo rather than an omission. A backtest should be reproducible from the folder alone, years must never influence each other through a refactor, and the reference year is the only place where the strategy is edited by hand:

| Path | Role |
|---|---|
| `main.strategy.ts` | the fund: costs, deposit, basket and issuer map, time exit, dividend crediting; `setConfig` lives only here |
| `classes/UzSE.ts` | daily bars of a share from the exchange's Excel export, ticker → ISIN by the exchange's own list, persistent cache with `.part` downloads, waits out the export rate limit; compatible with `getCandlesFilled` / `getCandlesSampled` as a fetcher |
| `classes/UzSEDividends.ts` | the exchange's dividend table (decision date, dividend per common and preferred share, payout window) cached once, queried as "decisions known at `when`" |
| `modules/backtest.module.ts` | the exchange schema (`getCandlesSampled` over `UzSE.getCandles`), the year's frame |

The generator in [scripts/common/generate_months.mjs](scripts/common/generate_months.mjs) copies the reference folder into every finished year and substitutes exactly three things: the basket and issuer blocks in the strategy and the frame in the module. It also rewrites the two runner scripts so that they always list every year on disk.


## 📊 Data: Daily Bars Driving a Minute Engine

The engine simulates positions on minute candles and asks the exchange adapter for them. The exchange publishes daily bars. The adapter bridges the two with backtest-kit's own tools:

- every request goes through `getCandlesSampled`; a `1d` request is handed to `getCandlesFilled`, which puts the bars on a continuous calendar grid and repairs weekends, holidays and anomalous bars (zero closes on days without trades) with a flat bar from the neighbouring closes, and anything shorter repeats the repaired daily bar across its minutes or hours;
- the strategy sets `CC_BACKTEST_STEP_MINUTES` to a full day, so the engine evaluates each position once per daily bar;
- `PersistCandleAdapter.useDummy()` keeps the synthesized candles out of Mongo.

The accepted trade-off: every minute of a day carries that day's high, low and close. For a time exit on 31 December this does not matter; for the −50% stop it means the stop fires on the day's low.

The exchange's series are not adjusted for splits. [scripts/common/build_universe.mjs](scripts/common/build_universe.mjs) flags a close-to-close jump of ×1.8 or ×0.55 between two traded days as a split and keeps that share out of the basket for that year; the HOWTO lists the cases it caught.


## 🧭 Design Rules of This Repo

- **Copy-paste over abstraction.** Years are stamped, not imported. A refactor must not be able to change the result of a year that already ran.
- **`setConfig` only in the strategy file.** The exchange module registers schemas and adapters; it does not change engine behaviour.
- **Constants describe the process, not the outcome.** The liquidity thresholds are what a ten-million-soum deposit can buy and sell in a day, the holding period is the calendar year the dividend cycle runs on, the costs are the spread and the tariff. None of them is tuned to a PnL curve, and the README does not quote one.
- **Every approximation is written down.** [docs/HOWTO.md](docs/HOWTO.md) is the operating manual: prerequisites, the universe build, the issuer map, how to change the strategy (edit the reference year, regenerate), and the list of known gaps: decision date instead of record date, daily-bar sampling, unadjusted splits, per-symbol accounting with a fixed deposit.


## 📜 Summary

| Aspect | This repo |
|---|---|
| **Subject** | A yearly long-only dividend fund on UzSE shares, replayed year by year |
| **Universe** | Shares with a median daily turnover above one million soum and trades on 90% of the days of the previous year, top names by turnover; frozen per year, no survivorship |
| **Cycle** | Equal-weight positions opened on the first tick of the year, time exit at 23:59 on 31 December, re-entry only after a −50% stop |
| **Dividends** | Every decision taken while the position is open is credited with `commitDividend` on its decision date |
| **Costs** | 0.15% fee and 0.5% slippage per side set in the strategy |
| **Data** | Exchange Excel exports and dividend table, cached once, sampled to minutes by `getCandlesSampled`, one engine step per day |
| **Layout** | Self-contained year folders generated from one reference year; universe builder, issuer map and summary in `scripts/common/` |
| **Honesty budget** | Decision date for record date, synthetic intraday path, stops on daily lows, unadjusted splits excluded by rule; all documented in `docs/HOWTO.md` |
