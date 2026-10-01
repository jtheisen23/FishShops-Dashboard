#!/usr/bin/env node
// Read-only probe of 7shifts log book endpoints. Prints HTTP status, record
// counts and field names only (no note text), to find which paths exist.
import { addDays, todayIn } from './dates.js';
import { SevenShiftsClient } from './sevenshifts.js';

const client = new SevenShiftsClient({ token: process.env.SEVENSHIFTS_ACCESS_TOKEN, log: () => {} });
const company = await client.company();
const cid = company.id;
const locs = await client.locations(cid);
const lid = locs[0].id;
const today = todayIn('America/Los_Angeles');
const from = addDays(today, -14);
const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return `[${v.length}]${v.length && depth < 2 ? ' of ' + shape(v[0], depth + 1) : ''}`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${depth < 2 ? shape(x, depth + 1) : typeof x}`).join(', ')}}`;
  return typeof v === 'string' ? `string(${v.length})` : typeof v;
};
const paths = [
  [`/v2/company/${cid}/log_book_posts`, { location_id: lid }],
  [`/v2/company/${cid}/log_book_posts`, { location_id: lid, 'date[gte]': from, 'date[lte]': today }],
  [`/v2/company/${cid}/log_book/posts`, { location_id: lid }],
  [`/v2/company/${cid}/location/${lid}/log_book_posts`, {}],
  [`/v2/company/${cid}/locations/${lid}/log_book_posts`, {}],
  [`/v2/company/${cid}/log_book_categories`, { location_id: lid }],
  [`/v2/company/${cid}/location/${lid}/log_book_categories`, {}],
  [`/v2/company/${cid}/log_book_comments`, { location_id: lid }],
  [`/v2/company/${cid}/log_books`, { location_id: lid }],
  [`/v2/company/${cid}/logbook`, { location_id: lid }],
  [`/v1/log_book_posts`, { location_id: lid }],
  [`/v1/logbook`, { location_id: lid }],
];
console.log(`company ${cid}; probing with location ${lid} (${locs[0].name}); window ${from}..${today}`);
for (const [p, q] of paths) {
  try {
    const body = await client.get(p, q);
    console.log(`200 ${p} ${JSON.stringify(q)}\n    ${shape(body)}`);
  } catch (e) {
    console.log(`${e.status ?? 'ERR'} ${p} ${JSON.stringify(q)} ${e.status ? '' : e.message.slice(0, 120)}`);
  }
}
