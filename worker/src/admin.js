// User management for admins: who can see which locations and sections.

import { HttpError, requireAdmin, SECTIONS } from './auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listUsers(env, user) {
  requireAdmin(user);
  const [{ results: users }, { results: links }, { results: locations }] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM users ORDER BY role, email'),
    env.DB.prepare('SELECT email, location_id FROM user_locations'),
    env.DB.prepare('SELECT id, name FROM locations ORDER BY sort_order, name'),
  ]);
  const byEmail = new Map();
  for (const l of links) {
    const key = l.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(l.location_id);
  }
  return {
    users: users.map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      active: !!u.active,
      allLocations: !!u.all_locations,
      locations: byEmail.get(u.email.toLowerCase()) || [],
      sections: Object.fromEntries(SECTIONS.map((s) => [s, !!u[`can_${s}`]])),
      updatedAt: u.updated_at,
    })),
    locations,
    bootstrapAdmins: String(env.BOOTSTRAP_ADMINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export async function saveUser(env, user, body) {
  requireAdmin(user);
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');
  const role = body.role === 'admin' ? 'admin' : 'viewer';
  const active = body.active !== false;
  if (email === user.email && (role !== 'admin' || !active)) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  const name = String(body.name || '').slice(0, 100);
  const allLocations = !!body.allLocations;
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, !!body.sections?.[s]]));

  const { results: known } = await env.DB.prepare('SELECT id FROM locations').all();
  const knownIds = new Set(known.map((l) => l.id));
  const locs = [...new Set(Array.isArray(body.locations) ? body.locations : [])].filter((l) => knownIds.has(l));

  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (email, name, role, all_locations, can_sales, can_discounts, can_labor, can_items, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, all_locations=excluded.all_locations,
         can_sales=excluded.can_sales, can_discounts=excluded.can_discounts, can_labor=excluded.can_labor,
         can_items=excluded.can_items, active=excluded.active, updated_at=excluded.updated_at`,
    ).bind(
      email,
      name,
      role,
      allLocations ? 1 : 0,
      sections.sales ? 1 : 0,
      sections.discounts ? 1 : 0,
      sections.labor ? 1 : 0,
      sections.items ? 1 : 0,
      active ? 1 : 0,
    ),
    env.DB.prepare('DELETE FROM user_locations WHERE email = ?').bind(email),
    ...locs.map((l) => env.DB.prepare('INSERT INTO user_locations (email, location_id) VALUES (?, ?)').bind(email, l)),
    env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').bind(
      user.email,
      'save_user',
      JSON.stringify({ email, role, active, allLocations, locations: locs, sections }),
    ),
  ];
  await env.DB.batch(stmts);
  return { ok: true };
}

export async function deleteUser(env, user, email) {
  requireAdmin(user);
  email = String(email || '').trim().toLowerCase();
  if (email === user.email) throw new HttpError(400, 'You cannot delete yourself');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_locations WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email),
    env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').bind(user.email, 'delete_user', email),
  ]);
  return { ok: true };
}

export async function auditLog(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 200').all();
  return { entries: results };
}
