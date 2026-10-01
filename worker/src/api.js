// Read-only data endpoints. Every query is scoped to the locations the
// signed-in user is allowed to see, and each section checks its permission.

import { HttpError, requireAdmin, requireSection } from './auth.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 1100;

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function readPeriod(params, startKey, endKey, required) {
  const start = params.get(startKey);
  const end = params.get(endKey);
  if (!start && !end && !required) return null;
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
    throw new HttpError(400, `${startKey} and ${endKey} must be YYYY-MM-DD`);
  }
  if (end < start) throw new HttpError(400, `${endKey} is before ${startKey}`);
  if (daysBetween(start, end) > MAX_RANGE_DAYS) throw new HttpError(400, 'Date range is too long');
  return { start, end };
}

/** Parses ?start&end&cstart&cend&locations=PL,PB and intersects locations with the user's rights. */
export function readQuery(url, user) {
  const p = url.searchParams;
  const current = readPeriod(p, 'start', 'end', true);
  const compare = readPeriod(p, 'cstart', 'cend', false);
  const requested = (p.get('locations') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set(user.locations);
  const locations = requested.length ? requested.filter((l) => allowed.has(l)) : [...allowed];
  if (!locations.length) throw new HttpError(403, 'You do not have access to any of the requested locations');
  return { current, compare, locations };
}

/** Runs one parameterized query for the current period and (optionally) the comparison period. */
async function bothPeriods(env, q, sql, extraBinds = []) {
  const inList = q.locations.map(() => '?').join(',');
  const text = sql.replaceAll('{LOCATIONS}', inList);
  const stmt = (period) => env.DB.prepare(text).bind(period.start, period.end, ...q.locations, ...extraBinds);
  const stmts = [stmt(q.current)];
  if (q.compare) stmts.push(stmt(q.compare));
  const res = await env.DB.batch(stmts);
  return { current: res[0].results, compare: q.compare ? res[1].results : null };
}

const RANGE = 'business_date BETWEEN ? AND ? AND location_id IN ({LOCATIONS})';

// Toast jobs left out of every labor figure (hours, cost, labor %, SPLH).
// Matched case-insensitively. The rows stay in D1, so removing a name here
// brings them back for all dates.
export const EXCLUDED_JOBS = ['register'];
const LABOR_RANGE = `${RANGE} AND LOWER(TRIM(job_title)) NOT IN (${EXCLUDED_JOBS.map((j) => `'${j}'`).join(', ')})`;

function stripDiscounts(rows) {
  return rows?.map(({ gross_sales, discounts, voids, void_count, ...rest }) => rest) ?? null;
}

export async function overview(env, url, user) {
  requireSection(user, 'sales');
  const q = readQuery(url, user);

  const [totals, daily] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT location_id, COUNT(*) AS days, SUM(orders) AS orders, SUM(checks) AS checks, SUM(guests) AS guests,
              SUM(gross_sales) AS gross_sales, SUM(discounts) AS discounts, SUM(net_sales) AS net_sales,
              SUM(voids) AS voids, SUM(void_count) AS void_count, SUM(tax) AS tax, SUM(tips) AS tips,
              SUM(service_charges) AS service_charges
         FROM daily_sales WHERE ${RANGE} GROUP BY location_id`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, orders, guests, gross_sales, discounts, net_sales, voids, void_count
         FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
  ]);

  let labor = null;
  let laborDaily = null;
  if (user.sections.labor) {
    [labor, laborDaily] = await Promise.all([
      bothPeriods(
        env,
        q,
        `SELECT location_id, SUM(regular_hours + overtime_hours) AS hours, SUM(overtime_hours) AS overtime_hours,
                SUM(regular_cost + overtime_cost) AS cost
           FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY location_id`,
      ),
      bothPeriods(
        env,
        q,
        `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
                SUM(regular_cost + overtime_cost) AS cost
           FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
      ),
    ]);
  }

  if (!user.sections.discounts) {
    for (const k of ['current', 'compare']) {
      totals[k] = stripDiscounts(totals[k]);
      daily[k] = stripDiscounts(daily[k]);
    }
  }
  return { query: q, totals, daily, labor, laborDaily };
}

export const MIX_DIMENSIONS = new Set(['dining_option', 'revenue_center', 'sales_category']);

export async function mix(env, url, user) {
  requireSection(user, 'sales');
  const q = readQuery(url, user);
  const dimension = url.searchParams.get('dimension') || 'hour';

  if (dimension === 'hour') {
    const r = await bothPeriods(
      env,
      q,
      `SELECT location_id, hour AS label, SUM(orders) AS orders, SUM(guests) AS guests, SUM(net_sales) AS net_sales
         FROM hourly_sales WHERE ${RANGE} GROUP BY location_id, hour ORDER BY hour`,
    );
    return { query: q, dimension, ...r };
  }
  if (dimension === 'weekday') {
    // 0 = Sunday. Days counted so the UI can show average per weekday.
    const r = await bothPeriods(
      env,
      q,
      `SELECT location_id, CAST(strftime('%w', business_date) AS INTEGER) AS label, COUNT(*) AS days,
              SUM(orders) AS orders, SUM(guests) AS guests, SUM(net_sales) AS net_sales
         FROM daily_sales WHERE ${RANGE} GROUP BY location_id, label ORDER BY label`,
    );
    return { query: q, dimension, ...r };
  }
  if (!MIX_DIMENSIONS.has(dimension)) throw new HttpError(400, 'Unknown dimension');
  // Labels an admin has grouped (Admin > Category groups) are merged here.
  const r = await bothPeriods(
    env,
    q,
    `SELECT location_id, COALESCE(g.group_name, m.label) AS label, m.label AS source_label, SUM(orders) AS orders,
            SUM(quantity) AS quantity, SUM(net_sales) AS net_sales
       FROM sales_mix m
       LEFT JOIN category_groups g ON g.dimension = m.dimension AND g.source_label = m.label
      WHERE ${RANGE} AND m.dimension = ?
      GROUP BY location_id, COALESCE(g.group_name, m.label), m.label ORDER BY net_sales DESC`,
    [dimension],
  );
  return { query: q, dimension, ...r };
}

// Discount names an admin has grouped (Admin > Category groups > Discounts) are merged here.
export async function discounts(env, url, user) {
  requireSection(user, 'discounts');
  const q = readQuery(url, user);
  const [byName, byLocation, byApprover, daily] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT COALESCE(g.group_name, d.discount_name) AS discount_name, d.discount_name AS source_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} GROUP BY COALESCE(g.group_name, d.discount_name), d.discount_name ORDER BY amount DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, COALESCE(g.group_name, d.discount_name) AS discount_name, d.discount_name AS source_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} GROUP BY location_id, COALESCE(g.group_name, d.discount_name), d.discount_name`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT approver, COALESCE(g.group_name, d.discount_name) AS discount_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} AND approver <> '' GROUP BY approver, COALESCE(g.group_name, d.discount_name) ORDER BY amount DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, gross_sales, discounts, net_sales
         FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
  ]);
  return { query: q, byName, byLocation, byApprover, daily };
}

export async function labor(env, url, user) {
  requireSection(user, 'labor');
  const q = readQuery(url, user);
  const [byJob, byLocationJob, daily, sales] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT job_title, SUM(regular_hours) AS regular_hours, SUM(overtime_hours) AS overtime_hours,
              SUM(regular_cost) AS regular_cost, SUM(overtime_cost) AS overtime_cost, SUM(shifts) AS shifts
         FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY job_title ORDER BY SUM(regular_cost + overtime_cost) DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, job_title, SUM(regular_hours + overtime_hours) AS hours, SUM(overtime_hours) AS overtime_hours,
              SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY location_id, job_title`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
              SUM(overtime_hours) AS overtime_hours, SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, net_sales, guests FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
  ]);
  // Labor % and SPLH need net sales; users with labor but not sales access
  // get hours and cost only.
  return { query: q, byJob, byLocationJob, daily, sales: user.sections.sales ? sales : null };
}

export async function items(env, url, user) {
  requireSection(user, 'items');
  const q = readQuery(url, user);
  const limit = Math.min(200, Math.max(5, Number(url.searchParams.get('limit')) || 50));
  const r = await bothPeriods(
    env,
    q,
    `SELECT item_name, COALESCE(g.group_name, i.sales_category) AS sales_category, SUM(quantity) AS quantity,
            SUM(gross_sales) AS gross_sales, SUM(net_sales) AS net_sales
       FROM item_sales i
       LEFT JOIN category_groups g ON g.dimension = 'sales_category' AND g.source_label = i.sales_category
      WHERE ${RANGE}
      GROUP BY item_name, COALESCE(g.group_name, i.sales_category) ORDER BY net_sales DESC LIMIT ?`,
    [limit],
  );
  return { query: q, limit, ...r };
}

const laDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

export async function locations(env, user) {
  if (!user.locations.length) return { locations: [] };
  // "Yesterday" in Pacific time, to report whether it was re-synced after the
  // day ended (a sync during service leaves the dinner rush missing).
  const today = laDate.format(new Date());
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.timezone,
            (SELECT MAX(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS last_business_date,
            (SELECT MIN(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS first_business_date,
            (SELECT MAX(synced_at) FROM sync_log s WHERE s.location_id = l.id) AS last_synced_at,
            (SELECT synced_at FROM sync_log s WHERE s.location_id = l.id AND s.business_date = ?) AS yesterday_synced_at
       FROM locations l
      WHERE l.id IN (${user.locations.map(() => '?').join(',')})
      ORDER BY l.sort_order, l.name`,
  )
    .bind(yesterday, ...user.locations)
    .all();
  for (const r of results) {
    r.yesterday = yesterday;
    // Complete once synced on a later Pacific date than the day itself.
    r.yesterday_complete = !!r.yesterday_synced_at && laDate.format(new Date(r.yesterday_synced_at)) > yesterday;
  }
  return { locations: results };
}

const shiftDate = (s, n) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Admin-only 7shifts tab: scheduled labor (7shifts) against actual labor and
 * sales (Toast) for the selected period, plus the next 14 days of schedule
 * with a sales projection from the last 4 weeks' same-weekday average.
 */
export async function sevenShifts(env, url, user) {
  requireAdmin(user);
  const q = readQuery(url, user);
  const today = laDate.format(new Date());
  const upEnd = shiftDate(today, 13);
  const histStart = shiftDate(today, -28);
  const inList = q.locations.map(() => '?').join(',');
  const binds = (start, end) => [start, end, ...q.locations];
  const { start, end } = q.current;
  const stmt = (sql, b) => env.DB.prepare(sql.replaceAll('{LOCATIONS}', inList)).bind(...b);

  const res = await env.DB.batch([
    stmt(`SELECT business_date, location_id, SUM(hours) AS hours, SUM(cost) AS cost, SUM(shifts) AS shifts,
                 SUM(open_shifts) AS open_shifts, SUM(open_hours) AS open_hours
            FROM scheduled_labor WHERE ${RANGE} GROUP BY business_date, location_id ORDER BY business_date`, binds(start, end)),
    stmt(`SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours, SUM(regular_cost + overtime_cost) AS cost
            FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY business_date, location_id ORDER BY business_date`, binds(start, end)),
    stmt(`SELECT business_date, location_id, net_sales FROM daily_sales WHERE ${RANGE} ORDER BY business_date`, binds(start, end)),
    stmt(`SELECT role AS name, SUM(hours) AS hours, SUM(cost) AS cost, SUM(shifts) AS shifts
            FROM scheduled_labor WHERE ${RANGE} GROUP BY role`, binds(start, end)),
    stmt(`SELECT job_title AS name, SUM(regular_hours + overtime_hours) AS hours, SUM(regular_cost + overtime_cost) AS cost
            FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY job_title`, binds(start, end)),
    stmt(`SELECT business_date, location_id, SUM(hours) AS hours, SUM(cost) AS cost, SUM(shifts) AS shifts,
                 SUM(open_shifts) AS open_shifts, SUM(open_hours) AS open_hours
            FROM scheduled_labor WHERE ${RANGE} GROUP BY business_date, location_id ORDER BY business_date`, binds(today, upEnd)),
    stmt(`SELECT location_id, CAST(strftime('%w', business_date) AS INTEGER) AS weekday, AVG(net_sales) AS net_sales
            FROM daily_sales WHERE ${RANGE} GROUP BY location_id, weekday`, binds(histStart, shiftDate(today, -1))),
    stmt(`SELECT location_id, synced_at, first_date, last_date FROM schedule_sync WHERE location_id IN ({LOCATIONS})`, q.locations),
  ]);
  const [scheduled, actual, sales, schedRoles, actualJobs, upcoming, weekdaySales, sync] = res.map((r) => r.results);
  return {
    query: q,
    today,
    upcomingEnd: upEnd,
    scheduled,
    actual,
    sales,
    schedRoles,
    actualJobs,
    upcoming,
    weekdaySales,
    sync,
  };
}
