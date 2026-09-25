#!/usr/bin/env node
// Toast -> D1 sync.
//
//   node etl/src/index.js                       # yesterday + today (default)
//   node etl/src/index.js --days 7              # last 7 business dates
//   node etl/src/index.js --start 2025-01-01 --end 2025-12-31   # backfill
//   node etl/src/index.js --locations PL,PB --out .tmp/sync.sql  # write SQL instead of D1
//
// Environment: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, [TOAST_API_HOST],
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID,
//   [LOCATIONS_JSON], [OVERTIME_MULTIPLIER]

import { parseArgs } from 'node:util';
import { addDays, eachDate, parseDate, todayIn, toToastDate } from './dates.js';
import { loadLocations } from './config.js';
import { ToastClient } from './toast.js';
import { aggregateLabor, aggregateOrders } from './transform.js';
import { dayStatements, upsertLocationsSql } from './sql.js';
import { D1Sink, FileSink } from './sink.js';

const { values: args } = parseArgs({
  options: {
    start: { type: 'string' },
    end: { type: 'string' },
    days: { type: 'string' },
    locations: { type: 'string' },
    out: { type: 'string' },
    'skip-labor': { type: 'boolean', default: false },
    config: { type: 'string', default: 'config/locations.json' },
  },
});

const log = (...a) => console.error(new Date().toISOString(), ...a);

async function main() {
  let locations = loadLocations(args.config);
  if (args.locations) {
    const want = new Set(args.locations.split(',').map((s) => s.trim().toUpperCase()));
    locations = locations.filter((l) => want.has(l.id.toUpperCase()));
    if (!locations.length) throw new Error(`No configured locations match --locations ${args.locations}`);
  }

  const toast = new ToastClient({
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    host: process.env.TOAST_API_HOST || undefined,
    log,
  });
  const sink = args.out
    ? new FileSink(args.out)
    : new D1Sink({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.D1_DATABASE_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        log,
      });
  const overtimeMultiplier = Number(process.env.OVERTIME_MULTIPLIER || 1.5);

  // Keep the locations table in step with config.
  await sink.write(upsertLocationsSql(locations));

  let failures = 0;
  for (const loc of locations) {
    const tz = loc.timezone || 'America/Los_Angeles';
    const { start, end } = dateRange(tz);
    log(`${loc.id} (${loc.name}): syncing ${start} .. ${end}`);

    const lookups = await toast.lookups(loc.toastGuid);
    for (const date of eachDate(start, end)) {
      try {
        const toastDate = toToastDate(date);
        const orders = await toast.ordersForBusinessDate(loc.toastGuid, toastDate);
        const sales = aggregateOrders(orders, { timezone: tz, lookups });

        let entries = [];
        let labor = null;
        if (!args['skip-labor']) {
          entries = await toast.timeEntriesForBusinessDate(loc.toastGuid, toastDate);
          labor = aggregateLabor(entries, {
            lookups,
            overtimeMultiplier,
            salariedLaborPerDay: loc.salariedLaborPerDay,
          });
        }

        await sink.write(
          dayStatements(loc.id, date, sales, labor, { orders: orders.length, timeEntries: entries.length }),
        );
        log(`  ${loc.id} ${date}: ${orders.length} orders, net $${sales.daily.net_sales.toFixed(2)}, ${entries.length} time entries`);
      } catch (err) {
        failures++;
        log(`  ${loc.id} ${date}: FAILED - ${err.message}`);
      }
    }
  }
  await sink.close();
  if (sink.rowsWritten !== undefined) log(`D1 rows written: ${sink.rowsWritten}`);
  if (failures) {
    log(`Finished with ${failures} failed location-day(s)`);
    process.exitCode = 1;
  } else {
    log('Sync complete');
  }
}

function dateRange(tz) {
  if (args.start) {
    const start = args.start;
    const end = args.end || todayIn(tz);
    parseDate(start);
    parseDate(end);
    if (end < start) throw new Error('--end is before --start');
    return { start, end };
  }
  const days = Math.max(1, Number(args.days || 2));
  const end = todayIn(tz);
  return { start: addDays(end, -(days - 1)), end };
}

main().catch((err) => {
  log(err.stack || err.message);
  process.exit(1);
});
