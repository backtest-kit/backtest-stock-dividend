import {
  addExchangeSchema,
  addFrameSchema,
  getCandlesSampled,
} from "backtest-kit";

import { UzSE } from "../classes/UzSE";

// Символ стратегии - биржевой тикер акции UzSE ("UZMK", "AGMKP"), ISIN класс подбирает сам по
// справочнику биржи. Биржа отдаёт только дневные бары: getCandlesSampled размножает дневной бар на
// минуты и часы, дневные запросы отдаёт как есть через getCandlesFilled: сетка, выходные и битые
// бары (нулевые закрытия в дни без сделок) чинятся в ядре плоской свечой по соседям.
addExchangeSchema({
  exchangeName: "uzse",
  getCandles: async (symbol, interval, since, limit) =>
    await getCandlesSampled(UzSE.getCandles, { symbol, interval, since, limit }),
});

addFrameSchema({
  frameName: "2024_frame",
  entryInterval: "1h",
  // Свечи дневные с биржи, минутки семплированы и внутри дня одинаковы: позиция оценивается
  // раз в сутки вместо поминутного цикла. Каденция тиков стратегии остаётся часовой.
  watchInterval: "1d",
  startDate: new Date("2024-01-01T00:00:00Z"),
  endDate: new Date("2024-12-31T23:59:59Z"),
  note: "Year 2024",
});
