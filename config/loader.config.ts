import {
  Launcher,
  listenError,
  Log,
  setConfig,
} from "backtest-kit";
import { errorData, getErrorMessage } from "functools-kit";

Launcher.run();


// Параметры движка общие для всех годовых папок content/<yyyy>/, чтобы не копировать их в стратегии
{
  setConfig({
    // Отключить кеш свечей по умолчанию
    CC_LAUNCHER_CANDLE_CACHE_DEFAULT: false,
    // Стоп -50% на годовом удержании: валидатор по умолчанию такой дистанции не пропускает
    CC_MAX_STOPLOSS_DISTANCE_PERCENT: 100,
    // Свечи дневные с биржи, минутки семплированы и внутри дня одинаковы: позиции оцениваются
    // раз в сутки вместо поминутного цикла. Каденция тиков стратегии остаётся по интервалу фрейма.
    CC_BACKTEST_STEP_MINUTES: 24 * 60,
    // Издержки: комиссия брокера и биржи около 0.15% за сделку, спред ликвидных бумаг 1-3%,
    // половина спреда ложится на каждую сторону. Движок применяет оба числа на входе и на выходе.
    CC_PERCENT_FEE: 0.15,
    CC_PERCENT_SLIPPAGE: 0.5,
    // Валидатор требует, чтобы минимальная дистанция тейка покрывала круг издержек (1.3% при этих числах)
    CC_MIN_TAKEPROFIT_DISTANCE_PERCENT: 2,
  });
}


listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});
