#!/usr/bin/env node
// Read-only probe: how 7shifts log book attachment links behave. Prints hosts,
// path shapes and HTTP results only (never full URLs or file contents).
import { SevenShiftsClient } from './sevenshifts.js';

const token = process.env.SEVENSHIFTS_ACCESS_TOKEN;
const client = new SevenShiftsClient({ token, log: () => {} });
const company = await client.company();
const locs = await client.locations(company.id);
const posts = await client.allLogBookPosts(company.id, locs[0].id);
const withAtt = posts.filter((p) => Array.isArray(p.attachments) && p.attachments.length).slice(-3);
console.log(`${withAtt.length} recent posts with attachments at ${locs[0].name}`);
const mask = (s) => String(s).replace(/[A-Za-z0-9]/g, (c) => (/[0-9]/.test(c) ? '9' : 'x'));
for (const p of withAtt) {
  for (const a of p.attachments) {
    const ext = (a.file_name.split('.').pop() || '').toLowerCase();
    let u;
    try { u = new URL(a.full_path); } catch { u = null; }
    console.log(`- ext=${ext} full_path: ${u ? `${u.protocol}//${u.host} path-shape=${mask(u.pathname).slice(0, 60)} query-keys=${[...u.searchParams.keys()].join(',') || 'none'}` : `not a URL, shape=${mask(a.full_path).slice(0, 80)}`}`);
    console.log(`  file_id shape=${mask(a.file_id).slice(0, 80)}`);
    const tries = u ? [['no auth', a.full_path, {}], ['bearer', a.full_path, { Authorization: `Bearer ${token}` }]] : [];
    tries.push(['api by file_id', `https://api.7shifts.com/v2/company/${company.id}/files/${encodeURIComponent(a.file_id)}`, { Authorization: `Bearer ${token}` }]);
    tries.push(['api attachments', `https://api.7shifts.com/v2/company/${company.id}/log_book_posts/${p.id}/attachments`, { Authorization: `Bearer ${token}` }]);
    if (!u) tries.push(['cdn guess', `https://assets.7shifts.com/${a.full_path.replace(/^\//, '')}`, {}]);
    for (const [label, url, headers] of tries) {
      try {
        const r = await fetch(url, { headers, redirect: 'manual' });
        const loc = r.headers.get('location');
        console.log(`  ${label}: ${r.status} ${r.headers.get('content-type') || ''} ${r.headers.get('content-length') || ''}${loc ? ` -> ${new URL(loc, url).host}` : ''} cache=${r.headers.get('cache-control') || ''}`);
      } catch (e) {
        console.log(`  ${label}: ERR ${e.message}`);
      }
    }
  }
}
