#!/bin/bash
# Прогон фонда акций UzSE по всем годам, один процесс CLI на год. Нужны поднятые docker/mongo и docker/redis.
# Отчёты: content/<год>/dump/report/backtest.jsonl. Запуск из корня репо: bash scripts/linux/run_strategy.sh
# Каждый год завершается kill() со статусом 137 - это штатно, прогон продолжается; сводка: node scripts/common/summarize_reports.mjs
node ./node_modules/@backtest-kit/cli/build/index.mjs --backtest --entry ./content/2021/main.strategy.ts
node ./node_modules/@backtest-kit/cli/build/index.mjs --backtest --entry ./content/2022/main.strategy.ts
node ./node_modules/@backtest-kit/cli/build/index.mjs --backtest --entry ./content/2023/main.strategy.ts
node ./node_modules/@backtest-kit/cli/build/index.mjs --backtest --entry ./content/2024/main.strategy.ts
node ./node_modules/@backtest-kit/cli/build/index.mjs --backtest --entry ./content/2025/main.strategy.ts
