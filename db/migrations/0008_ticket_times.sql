-- Kitchen ticket times from the KDS: one row per order whose items were bumped
-- READY. minutes = earliest item fired -> latest item marked READY (same
-- estimate as the Fishshops-Labor report). Only kitchens that bump tickets on
-- the KDS produce rows.
CREATE TABLE ticket_times (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  order_guid    TEXT NOT NULL,
  hour          INTEGER,           -- local hour the order was opened
  channel       TEXT NOT NULL,     -- Dine-in | Online | Takeout
  minutes       REAL NOT NULL,
  PRIMARY KEY (location_id, business_date, order_guid)
) WITHOUT ROWID;
