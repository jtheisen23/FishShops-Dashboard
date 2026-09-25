// Read-only data endpoints. Every query is scoped to the locations the
// signed-in user is allowed to see, and each section checks its permission.

import { HttpError, requireSection } from './auth.js';

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
           FROM labor_daily WHERE ${RANGE} GROUP BY location_id`,
      ),
      bothPeriods(
        env,
        q,
        `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
                SUM(regular_cost + overtime_cost) AS cost
           FROM labor_daily WHERE ${RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
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

const MIX_DIMENSIONS = new Set(['dining_option', 'revenue_center', 'sales_category']);

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
  const r = await bothPeriods(
    env,
    q,
    `SELECT location_id, label, SUM(orders) AS orders, SUM(quantity) AS quantity, SUM(net_sales) AS net_sales
       FROM sales_mix WHERE ${RANGE} AND dimension = ? GROUP BY location_id, label ORDER BY net_sales DESC`,
    [dimension],
  );
  return { query: q, dimension, ...r };
}

export async function discounts(env, url, user) {
  requireSection(user, 'discounts');
  const q = readQuery(url, user);
  const [byName, byLocation, byApprover, daily] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT discount_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales WHERE ${RANGE} GROUP BY discount_name ORDER BY amount DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, discount_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales WHERE ${RANGE} GROUP BY location_id, discount_name`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT approver, discount_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales WHERE ${RANGE} AND approver <> '' GROUP BY approver, discount_name ORDER BY amount DESC`,
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
         FROM labor_daily WHERE ${RANGE} GROUP BY job_title ORDER BY SUM(regular_cost + overtime_cost) DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, job_title, SUM(regular_hours + overtime_hours) AS hours, SUM(overtime_hours) AS overtime_hours,
              SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily WHERE ${RANGE} GROUP BY location_id, job_title`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
              SUM(overtime_hours) AS overtime_hours, SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily WHERE ${RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
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
    `SELECT item_name, sales_category, SUM(quantity) AS quantity, SUM(gross_sales) AS gross_sales, SUM(net_sales) AS net_sales
       FROM item_sales WHERE ${RANGE} GROUP BY item_name, sales_category ORDER BY net_sales DESC LIMIT ?`,
    [limit],
  );
  return { query: q, limit, ...r };
}

export async function locations(env, user) {
  if (!user.locations.length) return { locations: [] };
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.timezone,
            (SELECT MAX(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS last_business_date,
            (SELECT MIN(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS first_business_date,
            (SELECT MAX(synced_at) FROM sync_log s WHERE s.location_id = l.id) AS last_synced_at
       FROM locations l
      WHERE l.id IN (${user.locations.map(() => '?').join(',')})
      ORDER BY l.sort_order, l.name`,
  )
    .bind(...user.locations)
    .all();
  return { locations: results };
}
