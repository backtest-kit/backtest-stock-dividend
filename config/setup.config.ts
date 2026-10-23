import {
  Markdown,
  StorageLive,
  StorageBacktest,
  NotificationLive,
  NotificationBacktest,
  RecentLive,
  RecentBacktest,
  Dump,
  MemoryLive,
  MemoryBacktest,
  StateLive,
  StateBacktest,
  SessionLive,
  SessionBacktest,
  Log,
} from "backtest-kit";

import {
  PersistCandleAdapter,
  PersistSignalAdapter,
  PersistRiskAdapter,
  PersistScheduleAdapter,
  PersistStrategyAdapter,
  PersistPartialAdapter,
  PersistBreakevenAdapter,
  PersistStorageAdapter,
  PersistNotificationAdapter,
  PersistLogAdapter,
  PersistMeasureAdapter,
  PersistIntervalAdapter,
  PersistMemoryAdapter,
  PersistRecentAdapter,
  PersistStateAdapter,
  PersistDictionaryAdapter,
  PersistSessionAdapter,
} from "backtest-kit";


{
  Dump.useMarkdown();
}

{
  SessionLive.usePersist();
  SessionBacktest.useLocal();
}

{
  StorageLive.usePersist();
  StorageBacktest.useMemory();
}

{
  RecentLive.usePersist();
  RecentBacktest.useMemory();
}

{
  NotificationLive.usePersist();
  NotificationBacktest.useMemory();
}

{
  RecentLive.usePersist();
  RecentBacktest.useMemory();
}

{
  MemoryLive.usePersist();
  MemoryBacktest.useLocal();
}

{
  StateLive.usePersist();
  StateBacktest.useLocal();
}

{
  Markdown.useDummy();
  Log.useJsonl();
}

{
  PersistCandleAdapter.useDummy();
  PersistSignalAdapter.useDummy();
  PersistRiskAdapter.useDummy();
  PersistScheduleAdapter.useDummy();
  PersistStrategyAdapter.useDummy();
  PersistPartialAdapter.useDummy();
  PersistBreakevenAdapter.useDummy();
  PersistStorageAdapter.useDummy();
  PersistNotificationAdapter.useDummy();
  PersistLogAdapter.useDummy();
  PersistMeasureAdapter.useDummy();
  PersistIntervalAdapter.useDummy();
  PersistMemoryAdapter.useDummy();
  PersistRecentAdapter.useDummy();
  PersistStateAdapter.useDummy();
  PersistDictionaryAdapter.useDummy();
  PersistSessionAdapter.useDummy();
}
