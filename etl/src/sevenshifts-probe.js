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
const base = `/v2/company/${cid}/log_book_posts`;
const paths = [
  [base, { location_id: lid, start_date: from, end_date: today }],
  [base, { location_id: lid, 'date[gte]': `${from}T00:00:00Z` }],
  [base, { location_id: lid, date: today }],
  [base, { location_id: lid, from, to: today }],
  [base, { location_id: lid, 'created[gte]': `${from}T00:00:00Z` }],
  [base, { location_id: lid, sort_by: 'date', sort_dir: 'desc' }],
];
console.log(`company ${cid}; probing with location ${lid} (${locs[0].name}); window ${from}..${today}`);
for (const [p, q] of paths) {
  try {
    const body = await client.get(p, q);
    const d = body.data || [];
    console.log(`200 ${JSON.stringify(q)} n=${d.length} dates=${d.map((x) => x.date).join(',')} next=${!!body.meta?.cursor?.next}`);
  } catch (e) {
    console.log(`${e.status ?? 'ERR'} ${JSON.stringify(q)} ${(e.message || '').replace(/.*failed: /, '').slice(0, 160)}`);
  }
}
const all = await client.list(base, { location_id: lid });
const dates = all.map((x) => x.date).sort();
console.log(`all pages: ${all.length} posts, dates ${dates[0]}..${dates.at(-1)}; first page order: ${all.slice(0, 5).map((x) => x.date).join(',')}`);
const withComments = all.find((x) => x.log_book_comment_count > 0);
const cats = await client.list(`/v2/company/${cid}/log_book_categories`, { location_id: lid });
console.log('categories: ' + cats.map((c) => `${c.name} [${c.field_type}]`).join('; '));
const byCat = {};
for (const x of all) byCat[x.log_book_category_id] = (byCat[x.log_book_category_id] || 0) + 1;
console.log('posts per category id: ' + JSON.stringify(byCat) + ' ids: ' + cats.map((c) => `${c.id}=${c.name}`).join(', '));
console.log('attachments shape: ' + shape(all.find((x) => x.attachments && Object.keys(x.attachments).length)?.attachments));
for (const [p, q] of [
  [`/v2/company/${cid}/log_book_comments`, { log_book_post_id: withComments?.id }],
  [`/v2/company/${cid}/log_book_comments`, { post_id: withComments?.id }],
  [`/v2/company/${cid}/log_book_posts/${withComments?.id}/comments`, {}],
  [`/v2/company/${cid}/log_book_posts/${withComments?.id}`, {}],
  [`/v2/company/${cid}/users`, { location_id: lid, limit: 2 }],
  [`/v2/company/${cid}/users/${all[0]?.user_id}`, {}],
]) {
  try {
    const body = await client.get(p, q);
    console.log(`200 ${p.replace(String(cid), 'C')} ${JSON.stringify(q)}\n    ${shape(body)}`);
  } catch (e) {
    console.log(`${e.status ?? 'ERR'} ${p.replace(String(cid), 'C')} ${JSON.stringify(q)} ${(e.message || '').replace(/.*failed: /, '').slice(0, 160)}`);
  }
}
