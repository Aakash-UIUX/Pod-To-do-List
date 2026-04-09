const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'mindmap_secret_aakash_rc_2026';

// Turso DB — set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel env vars
const dbUrl = process.env.TURSO_DATABASE_URL || (process.env.VERCEL ? 'file:/tmp/mindmap.db' : 'file:mindmap-local.db');
let db = null;

function getDB() {
  if (!db) {
    db = createClient({
      url: dbUrl,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined
    });
  }
  return db;
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ══════════════════════════════════════
// DB INIT (runs once on cold start)
// ══════════════════════════════════════

let dbReady = false;

async function ensureDB() {
  if (dbReady) return;
  await getDB().execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await getDB().execute(`CREATE TABLE IF NOT EXISTS pods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await getDB().execute(`CREATE TABLE IF NOT EXISTS pod_members (
    pod_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(pod_id, user_id)
  )`);
  await getDB().execute(`CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    UNIQUE(pod_id, name)
  )`);
  await getDB().execute(`CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id INTEGER NOT NULL DEFAULT 0,
    module TEXT NOT NULL DEFAULT 'default',
    date TEXT NOT NULL,
    root_title TEXT NOT NULL DEFAULT 'My Project',
    data TEXT NOT NULL DEFAULT '[]',
    saved_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pod_id, module, date)
  )`);
  dbReady = true;
}

// ══════════════════════════════════════
// AUTH HELPERS
// ══════════════════════════════════════

function hashPass(p) {
  return crypto.createHash('sha256').update(p).digest('hex');
}

function signToken(u) {
  return jwt.sign({ id: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '30d' });
}

async function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function podAccess(req, res, next) {
  const podId = parseInt(req.params.podId);
  if (!podId) return res.status(400).json({ error: 'Invalid pod' });
  const r = await getDB().execute({ sql: 'SELECT user_id FROM pod_members WHERE pod_id=? AND user_id=?', args: [podId, req.user.id] });
  if (r.rows.length === 0) return res.status(403).json({ error: 'Not a member of this pod' });
  req.podId = podId;
  next();
}

// Middleware to ensure DB is ready
app.use(async (req, res, next) => {
  try { await ensureDB(); next(); }
  catch (e) { console.error('DB init error:', e); res.status(500).json({ error: 'DB init failed: ' + e.message, stack: e.stack }); }
});

// ══════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const existing = await getDB().execute({ sql: 'SELECT id FROM users WHERE email=?', args: [email.toLowerCase()] });
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

    await getDB().execute({ sql: 'INSERT INTO users(name, email, password_hash) VALUES(?,?,?)', args: [name.trim(), email.toLowerCase().trim(), hashPass(password)] });
    const userR = await getDB().execute({ sql: 'SELECT id, name, email FROM users WHERE email=?', args: [email.toLowerCase()] });
    const user = userR.rows[0];
    const token = signToken(user);

    // Create default pod
    const podInsert = await getDB().execute({ sql: 'INSERT INTO pods(name, created_by) VALUES(?,?)', args: ['My Pod', user.id] });
    const podId = Number(podInsert.lastInsertRowid);
    await getDB().execute({ sql: 'INSERT INTO pod_members(pod_id, user_id, role) VALUES(?,?,?)', args: [podId, user.id, 'owner'] });
    await getDB().execute({ sql: 'INSERT OR IGNORE INTO modules(pod_id, name) VALUES(?,?)', args: [podId, 'default'] });

    // Claim orphaned data
    const orphan = await getDB().execute('SELECT COUNT(*) as c FROM snapshots WHERE pod_id=0');
    if (orphan.rows[0].c > 0) {
      const mods = await getDB().execute('SELECT DISTINCT module FROM snapshots WHERE pod_id=0');
      for (const row of mods.rows) {
        await getDB().execute({ sql: 'INSERT OR IGNORE INTO modules(pod_id, name) VALUES(?,?)', args: [podId, row.module] });
      }
      await getDB().execute({ sql: 'UPDATE snapshots SET pod_id=? WHERE pod_id=0', args: [podId] });
    }

    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await getDB().execute({ sql: 'SELECT id, name, email, password_hash FROM users WHERE email=?', args: [email.toLowerCase()] });
    if (r.rows.length === 0 || r.rows[0].password_hash !== hashPass(password))
      return res.status(401).json({ error: 'Invalid email or password' });
    const user = r.rows[0];
    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 1: Check if email exists
app.post('/api/auth/check-email', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const r = await getDB().execute({ sql: 'SELECT id FROM users WHERE email=?', args: [email] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'No account found with that email' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Verify identity (name match)
app.post('/api/auth/verify-identity', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'Email and name required' });
    const r = await getDB().execute({ sql: 'SELECT name FROM users WHERE email=?', args: [email.toLowerCase()] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    if (r.rows[0].name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(403).json({ error: 'Name does not match. Please enter the exact name you registered with.' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 3: Reset password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const r = await getDB().execute({ sql: 'SELECT id, name FROM users WHERE email=?', args: [email.toLowerCase()] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'No account found with that email' });

    // Verify name matches (case-insensitive)
    if (r.rows[0].name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(403).json({ error: 'Name does not match the registered account' });
    }

    await getDB().execute({ sql: 'UPDATE users SET password_hash=? WHERE id=?', args: [hashPass(password), r.rows[0].id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const r = await getDB().execute({ sql: 'SELECT id, name, email FROM users WHERE id=?', args: [req.user.id] });
  if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const u = r.rows[0];
  res.json({ id: u.id, name: u.name, email: u.email });
});

// ══════════════════════════════════════
// POD ROUTES
// ══════════════════════════════════════

app.get('/api/pods', auth, async (req, res) => {
  const r = await getDB().execute({
    sql: `SELECT p.id, p.name, p.created_by,
      (SELECT COUNT(*) FROM pod_members WHERE pod_id=p.id) as member_count
      FROM pods p JOIN pod_members pm ON pm.pod_id=p.id
      WHERE pm.user_id=? ORDER BY p.name`,
    args: [req.user.id]
  });
  res.json(r.rows);
});

app.post('/api/pods', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const podInsert = await getDB().execute({ sql: 'INSERT INTO pods(name, created_by) VALUES(?,?)', args: [name, req.user.id] });
    const podId = Number(podInsert.lastInsertRowid);
    await getDB().execute({ sql: 'INSERT INTO pod_members(pod_id, user_id, role) VALUES(?,?,?)', args: [podId, req.user.id, 'owner'] });
    await getDB().execute({ sql: 'INSERT OR IGNORE INTO modules(pod_id, name) VALUES(?,?)', args: [podId, 'default'] });
    res.json({ ok: true, id: podId, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pods/:podId', auth, podAccess, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  await getDB().execute({ sql: 'UPDATE pods SET name=? WHERE id=?', args: [name, req.podId] });
  res.json({ ok: true });
});

app.delete('/api/pods/:podId', auth, podAccess, async (req, res) => {
  const r = await getDB().execute({ sql: 'SELECT created_by FROM pods WHERE id=?', args: [req.podId] });
  if (r.rows.length === 0 || r.rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can delete' });
  await getDB().execute({ sql: 'DELETE FROM snapshots WHERE pod_id=?', args: [req.podId] });
  await getDB().execute({ sql: 'DELETE FROM modules WHERE pod_id=?', args: [req.podId] });
  await getDB().execute({ sql: 'DELETE FROM pod_members WHERE pod_id=?', args: [req.podId] });
  await getDB().execute({ sql: 'DELETE FROM pods WHERE id=?', args: [req.podId] });
  res.json({ ok: true });
});

// ── Pod Members ──

app.get('/api/pods/:podId/members', auth, podAccess, async (req, res) => {
  const r = await getDB().execute({
    sql: `SELECT u.id, u.name, u.email, pm.role, pm.joined_at
      FROM pod_members pm JOIN users u ON u.id=pm.user_id
      WHERE pm.pod_id=? ORDER BY pm.role DESC, u.name`,
    args: [req.podId]
  });
  res.json(r.rows);
});

app.post('/api/pods/:podId/invite', auth, podAccess, async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const u = await getDB().execute({ sql: 'SELECT id FROM users WHERE email=?', args: [email] });
    if (u.rows.length === 0) return res.status(404).json({ error: 'No user found with that email. They need to sign up first.' });
    const existing = await getDB().execute({ sql: 'SELECT user_id FROM pod_members WHERE pod_id=? AND user_id=?', args: [req.podId, u.rows[0].id] });
    if (existing.rows.length > 0) return res.status(400).json({ error: 'User is already a member' });
    await getDB().execute({ sql: 'INSERT INTO pod_members(pod_id, user_id, role) VALUES(?,?,?)', args: [req.podId, u.rows[0].id, 'member'] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pods/:podId/members/:userId', auth, podAccess, async (req, res) => {
  const userId = parseInt(req.params.userId);
  const r = await getDB().execute({ sql: 'SELECT created_by FROM pods WHERE id=?', args: [req.podId] });
  if (r.rows.length > 0 && r.rows[0].created_by === userId) return res.status(400).json({ error: "Can't remove the pod owner" });
  await getDB().execute({ sql: 'DELETE FROM pod_members WHERE pod_id=? AND user_id=?', args: [req.podId, userId] });
  res.json({ ok: true });
});

// ── Modules ──

app.get('/api/pods/:podId/modules', auth, podAccess, async (req, res) => {
  const r = await getDB().execute({ sql: 'SELECT name FROM modules WHERE pod_id=? ORDER BY name', args: [req.podId] });
  res.json(r.rows.map(m => m.name));
});

app.post('/api/pods/:podId/modules', auth, podAccess, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  await getDB().execute({ sql: 'INSERT OR IGNORE INTO modules(pod_id, name) VALUES(?,?)', args: [req.podId, name] });
  res.json({ ok: true });
});

app.put('/api/pods/:podId/modules/:name', auth, podAccess, async (req, res) => {
  const newName = (req.body.name || '').trim();
  if (!newName) return res.status(400).json({ error: 'Name required' });
  await getDB().execute({ sql: 'UPDATE modules SET name=? WHERE pod_id=? AND name=?', args: [newName, req.podId, req.params.name] });
  await getDB().execute({ sql: 'UPDATE snapshots SET module=? WHERE pod_id=? AND module=?', args: [newName, req.podId, req.params.name] });
  res.json({ ok: true });
});

app.delete('/api/pods/:podId/modules/:name', auth, podAccess, async (req, res) => {
  await getDB().execute({ sql: 'DELETE FROM snapshots WHERE pod_id=? AND module=?', args: [req.podId, req.params.name] });
  await getDB().execute({ sql: 'DELETE FROM modules WHERE pod_id=? AND name=?', args: [req.podId, req.params.name] });
  res.json({ ok: true });
});

// ── Data ──

app.get('/api/pods/:podId/data/:module/dates', auth, podAccess, async (req, res) => {
  const r = await getDB().execute({ sql: 'SELECT date FROM snapshots WHERE pod_id=? AND module=? ORDER BY date DESC', args: [req.podId, req.params.module] });
  res.json(r.rows.map(r => r.date));
});

app.get('/api/pods/:podId/data/:module/:date', auth, podAccess, async (req, res) => {
  const { module, date } = req.params;
  const exact = await getDB().execute({ sql: 'SELECT root_title, data FROM snapshots WHERE pod_id=? AND module=? AND date=?', args: [req.podId, module, date] });
  if (exact.rows.length > 0) {
    const r = exact.rows[0];
    return res.json({ rootTitle: r.root_title, modules: JSON.parse(r.data), _saved: true, _from: null });
  }
  const prev = await getDB().execute({ sql: 'SELECT root_title, data, date FROM snapshots WHERE pod_id=? AND module=? AND date<=? ORDER BY date DESC LIMIT 1', args: [req.podId, module, date] });
  if (prev.rows.length > 0) {
    const r = prev.rows[0];
    return res.json({ rootTitle: r.root_title, modules: JSON.parse(r.data), _saved: false, _from: r.date });
  }
  res.json({ rootTitle: 'My Project', modules: [], _saved: false, _from: null });
});

app.post('/api/pods/:podId/data/:module/:date', auth, podAccess, async (req, res) => {
  const rootTitle = req.body.rootTitle || 'My Project';
  const data = JSON.stringify(req.body.modules || []);
  await getDB().execute({ sql: 'INSERT OR IGNORE INTO modules(pod_id, name) VALUES(?,?)', args: [req.podId, req.params.module] });
  await getDB().execute({
    sql: `INSERT OR REPLACE INTO snapshots(pod_id, module, date, root_title, data, saved_at) VALUES(?,?,?,?,?,datetime('now'))`,
    args: [req.podId, req.params.module, req.params.date, rootTitle, data]
  });
  res.json({ ok: true });
});

app.delete('/api/pods/:podId/data/:module/:date', auth, podAccess, async (req, res) => {
  await getDB().execute({ sql: 'DELETE FROM snapshots WHERE pod_id=? AND module=? AND date=?', args: [req.podId, req.params.module, req.params.date] });
  res.json({ ok: true });
});

// ── Debug/Health ──
app.get('/api/health', async (req, res) => {
  try {
    await ensureDB();
    const r = await getDB().execute('SELECT 1 as ok');
    res.json({
      status: 'ok',
      db: dbUrl.startsWith('libsql://') ? 'turso' : 'local',
      dbUrl: dbUrl.replace(/\/\/.*@/, '//***@'),
      hasTursoUrl: !!process.env.TURSO_DATABASE_URL,
      hasTursoToken: !!process.env.TURSO_AUTH_TOKEN,
      vercel: !!process.env.VERCEL,
      result: r.rows[0]
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message, stack: e.stack });
  }
});

app.get('/api/public-url', (req, res) => {
  res.json({ url: null });
});

// ══════════════════════════════════════
// EXPORT FOR VERCEL + LOCAL DEV
// ══════════════════════════════════════

module.exports = app;

// Exported for both Vercel serverless and local server.js
