// Where generated SQL goes: straight into the remote D1 database through the
// Cloudflare REST API, or into a .sql file for `wrangler d1 execute --file`.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_REQUEST_BYTES = 90_000;

export class FileSink {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  async write(statements) {
    if (statements.length) appendFileSync(this.path, statements.join('\n') + '\n');
  }
  async close() {}
}

export class D1Sink {
  constructor({ accountId, databaseId, apiToken, log = console.error }) {
    if (!accountId || !databaseId || !apiToken) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required (or pass --out file.sql)');
    }
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken;
    this.log = log;
  }

  /** Statements for one location-day are sent together so a day is replaced as a unit. */
  async write(statements) {
    let chunk = [];
    let size = 0;
    for (const s of statements) {
      if (size + s.length > MAX_REQUEST_BYTES && chunk.length) {
        await this.send(chunk.join('\n'));
        chunk = [];
        size = 0;
      }
      chunk.push(s);
      size += s.length + 1;
    }
    if (chunk.length) await this.send(chunk.join('\n'));
  }

  async send(sql) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success !== false) return body;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`D1 query failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
    }
  }

  async close() {}
}
