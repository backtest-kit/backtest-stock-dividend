@echo off
REM Прогон фонда акций UzSE по всем годам, один процесс CLI на год.
REM Отчёты: content\<год>\dump\report\backtest.jsonl. Запуск из корня репо: scripts\win\run_strategy.bat
REM Сводка после прогона: node scripts\common\summarize_reports.mjs
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2020\main.strategy.ts
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2021\main.strategy.ts
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2022\main.strategy.ts
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2023\main.strategy.ts
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2024\main.strategy.ts
node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\2025\main.strategy.ts
