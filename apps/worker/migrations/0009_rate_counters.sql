CREATE TABLE rate_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX idx_rate_counters_window
  ON rate_counters(window_start);
