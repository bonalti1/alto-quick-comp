/*
 * ALTO Pro storage layer.
 *
 * Uses Postgres (Supabase) when DATABASE_URL is set; otherwise falls back to
 * a JSON file on disk so local development and demos work with zero setup.
 * Same functions either way — the rest of the server never knows which.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "store.json");
let pool = null; // Postgres when configured
let mem = null;  // JSON fallback
let saveTimer = null;
let dbError = null; // last Postgres connection error, if any

export const dbKind = () => (pool ? "postgres" : "file");
export const dbErrorMsg = () => dbError;

const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString("base64url");

function persistMem() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(mem));
    } catch (e) { console.error("store write failed:", e.message); }
  }, 300);
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
   try {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contractors (
        id UUID PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT DEFAULT '',
        data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        contractor_id UUID REFERENCES contractors(id),
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        contractor_id UUID REFERENCES contractors(id),
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS app_state (
        contractor_id UUID PRIMARY KEY REFERENCES contractors(id),
        state JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS metrics (
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        n INTEGER DEFAULT 0,
        PRIMARY KEY (day, event)
      );
      CREATE TABLE IF NOT EXISTS meetings (
        id UUID PRIMARY KEY,
        name TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        outcome TEXT DEFAULT 'scheduled',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY,
        contractor_id UUID REFERENCES contractors(id),
        name TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        info JSONB DEFAULT '{}',
        status TEXT DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        slug TEXT DEFAULT '',
        title TEXT NOT NULL,
        note TEXT DEFAULT '',
        status TEXT DEFAULT 'open',
        created_at TIMESTAMPTZ DEFAULT now(),
        done_at TIMESTAMPTZ
      );
    `);
    console.log("db: postgres ready");
    return;
   } catch (e) {
    dbError = e.message;
    console.error("db: POSTGRES CONNECTION FAILED. Reason:", e.message);
    try { await pool?.end(); } catch { /* ignore */ }
    pool = null;
    // In production a silent fallback to the file store means every new
    // account, lead and payment writes to EPHEMERAL disk and evaporates on
    // the next restart — while everything looks fine. Fail fast instead so
    // the deploy goes red and someone looks.
    if (process.env.RENDER || process.env.NODE_ENV === "production") {
      console.error("db: DATABASE_URL is set but unreachable in production — refusing to start on ephemeral file storage.");
      process.exit(1);
    }
   }
  }
  // File fallback (no DATABASE_URL, or Postgres failed to connect)
  try { mem = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { mem = { contractors: [], sessions: {}, invites: {}, states: {}, leads: [], metrics: {}, meetings: [], tasks: [] }; }
  mem.meetings = mem.meetings || [];
  mem.tasks = mem.tasks || [];
  console.log(dbError ? `db: json file (postgres failed: ${dbError})` : "db: json file (set DATABASE_URL for Supabase/Postgres)");
}

export async function createContractor({ name, phone = "", slug }) {
  const id = newId();
  slug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || id.slice(0, 8);
  if (pool) {
    // add a suffix if the slug is taken
    const taken = await pool.query("SELECT 1 FROM contractors WHERE slug=$1", [slug]);
    if (taken.rowCount) slug = `${slug}-${id.slice(0, 4)}`;
    await pool.query("INSERT INTO contractors (id, slug, name, phone) VALUES ($1,$2,$3,$4)", [id, slug, name, phone]);
    return { id, slug, name, phone, data: {} };
  }
  if (mem.contractors.some(c => c.slug === slug)) slug = `${slug}-${id.slice(0, 4)}`;
  const c = { id, slug, name, phone, data: {}, created_at: new Date().toISOString() };
  mem.contractors.push(c);
  persistMem();
  return c;
}

export async function listContractors() {
  if (pool) return (await pool.query("SELECT id, slug, name, phone, data, created_at FROM contractors ORDER BY created_at DESC")).rows;
  return mem.contractors.map(({ id, slug, name, phone, data, created_at }) => ({ id, slug, name, phone, data, created_at }));
}

/* Per-contractor lead counts for the admin dashboard. */
export async function leadStats() {
  if (pool) {
    const r = await pool.query(
      `SELECT contractor_id, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7,
              MAX(created_at) AS last_at
       FROM leads GROUP BY contractor_id`
    );
    return r.rows;
  }
  const by = {};
  const now = Date.now();
  (mem.leads || []).forEach((l) => {
    const b = by[l.contractor_id] = by[l.contractor_id] || { contractor_id: l.contractor_id, total: 0, last7: 0, last_at: null };
    b.total += 1;
    if (now - new Date(l.created_at).getTime() < 7 * 864e5) b.last7 += 1;
    if (!b.last_at || l.created_at > b.last_at) b.last_at = l.created_at;
  });
  return Object.values(by);
}

/* Closer meetings — logged by the closer, visible to admin. Outcomes:
 * scheduled → no_show / showed / closed. */
export async function addMeeting({ name = "", phone = "", note = "" }) {
  const id = newId();
  if (pool) { await pool.query("INSERT INTO meetings (id, name, phone, note) VALUES ($1,$2,$3,$4)", [id, name, phone, note]); return id; }
  mem.meetings = mem.meetings || [];
  mem.meetings.push({ id, name, phone, note, outcome: "scheduled", created_at: new Date().toISOString() });
  persistMem();
  return id;
}
export async function setMeetingOutcome(id, outcome) {
  if (pool) { await pool.query("UPDATE meetings SET outcome=$2 WHERE id=$1", [id, outcome]); return; }
  const m = (mem.meetings || []).find((x) => x.id === id);
  if (m) { m.outcome = outcome; persistMem(); }
}
export async function setMeetingNote(id, note) {
  if (pool) { await pool.query("UPDATE meetings SET note=$2 WHERE id=$1", [id, note]); return; }
  const m = (mem.meetings || []).find((x) => x.id === id);
  if (m) { m.note = note; persistMem(); }
}

/* Customer-service tasks — assign work tied to a client, track open→done. */
export async function addTask({ slug = "", title = "", note = "" }) {
  const id = newId();
  if (pool) { await pool.query("INSERT INTO tasks (id, slug, title, note) VALUES ($1,$2,$3,$4)", [id, slug, title, note]); return id; }
  mem.tasks = mem.tasks || [];
  mem.tasks.push({ id, slug, title, note, status: "open", created_at: new Date().toISOString(), done_at: null });
  persistMem();
  return id;
}
export async function setTaskStatus(id, status) {
  const done = status === "done";
  if (pool) { await pool.query("UPDATE tasks SET status=$2, done_at=$3 WHERE id=$1", [id, status, done ? new Date().toISOString() : null]); return; }
  const t = (mem.tasks || []).find((x) => x.id === id);
  if (t) { t.status = status; t.done_at = done ? new Date().toISOString() : null; persistMem(); }
}
export async function deleteTask(id) {
  if (pool) { await pool.query("DELETE FROM tasks WHERE id=$1", [id]); return; }
  mem.tasks = (mem.tasks || []).filter((x) => x.id !== id);
  persistMem();
}
export async function listTasks(limit = 200) {
  if (pool) return (await pool.query("SELECT * FROM tasks ORDER BY (status='done'), created_at DESC LIMIT $1", [limit])).rows;
  return (mem.tasks || []).slice().sort((a, b) => (a.status === "done") - (b.status === "done") || (b.created_at > a.created_at ? 1 : -1)).slice(0, limit);
}
function rangeWhere(range, startIdx = 1) {
  const cond = [], args = [];
  const f = range && range.from, t = range && range.to;
  if (f) { args.push(f); cond.push(`created_at >= $${startIdx + args.length - 1}`); }
  if (t) { args.push(t); cond.push(`created_at < $${startIdx + args.length - 1}`); }
  return { where: cond.length ? `WHERE ${cond.join(" AND ")}` : "", args };
}
function memInRange(arr, range) {
  const f = range && range.from, t = range && range.to;
  return arr.filter((m) => (!f || m.created_at >= f) && (!t || m.created_at < t));
}
export async function listMeetings(limit = 60, range = null) {
  if (pool) {
    const { where, args } = rangeWhere(range);
    args.push(limit);
    return (await pool.query(`SELECT * FROM meetings ${where} ORDER BY created_at DESC LIMIT $${args.length}`, args)).rows;
  }
  return memInRange((mem.meetings || []).slice().reverse(), range).slice(0, limit);
}
export async function meetingStats(range = null) {
  let all;
  if (pool) {
    const { where, args } = rangeWhere(range);
    all = (await pool.query(`SELECT outcome FROM meetings ${where}`, args)).rows;
  } else {
    all = memInRange(mem.meetings || [], range);
  }
  const n = (o) => all.filter((m) => m.outcome === o).length;
  const closed = n("closed");
  return { total: all.length, scheduled: n("scheduled"), noShow: n("no_show"), showed: n("showed") + closed, closed };
}

export async function recentLeads(limit = 15) {
  if (pool) {
    return (await pool.query(
      `SELECT l.id, l.name, l.phone, l.address, l.info, l.status, l.created_at, c.slug, c.name AS contractor_name
       FROM leads l LEFT JOIN contractors c ON c.id = l.contractor_id
       ORDER BY l.created_at DESC LIMIT $1`, [limit]
    )).rows;
  }
  return (mem.leads || []).slice().reverse().slice(0, limit).map((l) => {
    const c = mem.contractors.find((x) => x.id === l.contractor_id) || {};
    return { ...l, slug: c.slug, contractor_name: c.name };
  });
}

export async function getContractor(id) {
  if (pool) return (await pool.query("SELECT * FROM contractors WHERE id=$1", [id])).rows[0] || null;
  return mem.contractors.find(c => c.id === id) || null;
}

export async function getContractorBySlug(slug) {
  if (pool) return (await pool.query("SELECT * FROM contractors WHERE slug=$1", [slug])).rows[0] || null;
  return mem.contractors.find(c => c.slug === slug) || null;
}

export async function saveContractorData(id, data) {
  if (pool) { await pool.query("UPDATE contractors SET data=$2 WHERE id=$1", [id, data]); return; }
  const c = mem.contractors.find(c => c.id === id);
  if (c) { c.data = data; persistMem(); }
}

/* Find a client by the custom domain they connected (host-based routing). */
export async function getContractorByDomain(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return null;
  if (pool) return (await pool.query("SELECT * FROM contractors WHERE lower(data->'site'->>'domain') = $1", [h])).rows[0] || null;
  return mem.contractors.find((c) => String(c.data?.site?.domain || "").toLowerCase() === h) || null;
}

export async function createInvite(contractorId) {
  const token = newToken();
  if (pool) await pool.query("INSERT INTO invites (token, contractor_id) VALUES ($1,$2)", [token, contractorId]);
  else { mem.invites[token] = { contractor_id: contractorId, used: false }; persistMem(); }
  return token;
}

/* Exchanging an invite creates a session. Invites stay reusable so the same
 * link works if the contractor gets a new phone — it's their key. */
export async function useInvite(token) {
  let contractorId = null;
  if (pool) {
    const r = await pool.query("SELECT contractor_id FROM invites WHERE token=$1", [token]);
    contractorId = r.rows[0]?.contractor_id || null;
  } else {
    contractorId = mem.invites[token]?.contractor_id || null;
  }
  if (!contractorId) return null;
  const session = newToken();
  if (pool) await pool.query("INSERT INTO sessions (token, contractor_id) VALUES ($1,$2)", [session, contractorId]);
  else { mem.sessions[session] = contractorId; persistMem(); }
  return session;
}

/* Kill every existing way into an account — all sessions (devices) and all
 * invite links. For leaked links, lost phones, ex-employees. Pair with
 * createInvite to hand the client a fresh key. */
export async function revokeAccess(contractorId) {
  if (pool) {
    await pool.query("DELETE FROM sessions WHERE contractor_id=$1", [contractorId]);
    await pool.query("DELETE FROM invites WHERE contractor_id=$1", [contractorId]);
    return;
  }
  mem.sessions = Object.fromEntries(Object.entries(mem.sessions || {}).filter(([, id]) => id !== contractorId));
  mem.invites = Object.fromEntries(Object.entries(mem.invites || {}).filter(([, v]) => v.contractor_id !== contractorId));
  persistMem();
}

export async function getSessionContractor(token) {
  if (!token) return null;
  let id = null;
  if (pool) id = (await pool.query("SELECT contractor_id FROM sessions WHERE token=$1", [token])).rows[0]?.contractor_id || null;
  else id = mem.sessions[token] || null;
  return id ? getContractor(id) : null;
}

/* How many sessions (≈ devices/installs) exist per contractor. A high count
 * flags possible link-sharing — surfaced on admin for an upsell conversation. */
export async function sessionCounts() {
  if (pool) {
    const r = await pool.query("SELECT contractor_id, count(*)::int n FROM sessions GROUP BY contractor_id");
    const m = {}; r.rows.forEach((x) => { m[String(x.contractor_id)] = x.n; }); return m;
  }
  const m = {};
  Object.values(mem.sessions || {}).forEach((id) => { m[String(id)] = (m[String(id)] || 0) + 1; });
  return m;
}

export async function saveState(contractorId, state) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_state (contractor_id, state, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (contractor_id) DO UPDATE SET state=$2, updated_at=now()`,
      [contractorId, state]
    );
    return;
  }
  mem.states[contractorId] = state;
  persistMem();
}

export async function getState(contractorId) {
  if (pool) return (await pool.query("SELECT state FROM app_state WHERE contractor_id=$1", [contractorId])).rows[0]?.state || null;
  return mem.states[contractorId] || null;
}

export async function addLead(contractorId, { name = "", phone = "", address = "", info = {} }) {
  const id = newId();
  if (pool) await pool.query("INSERT INTO leads (id, contractor_id, name, phone, address, info) VALUES ($1,$2,$3,$4,$5,$6)", [id, contractorId, name, phone, address, info]);
  else { mem.leads.push({ id, contractor_id: contractorId, name, phone, address, info, status: "new", created_at: new Date().toISOString() }); persistMem(); }
  return id;
}

/* Tiny key-value store (e.g., remembering payments that arrived before
 * the account existed). */
export async function kvSet(key, value) {
  if (pool) {
    await pool.query(
      "INSERT INTO kv (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()",
      [key, value]
    );
    return;
  }
  mem.kv = mem.kv || {};
  mem.kv[key] = { value, at: new Date().toISOString() };
  persistMem();
}

export async function kvGet(key, maxAgeMs = Infinity) {
  if (pool) {
    const r = await pool.query("SELECT value, updated_at FROM kv WHERE key=$1", [key]);
    const row = r.rows[0];
    if (!row) return null;
    if (Date.now() - new Date(row.updated_at).getTime() > maxAgeMs) return null;
    return row.value;
  }
  const row = (mem.kv || {})[key];
  if (!row) return null;
  if (Date.now() - new Date(row.at).getTime() > maxAgeMs) return null;
  return row.value;
}

/* Lifetime counter (persists across deploys): increments and returns the new value. */
export async function incrCounter(key) {
  if (pool) {
    const r = await pool.query(
      "INSERT INTO metrics (day, event, n) VALUES ('all',$1,1) ON CONFLICT (day, event) DO UPDATE SET n = metrics.n + 1 RETURNING n",
      [key]
    );
    return Number(r.rows[0].n);
  }
  mem.metrics = mem.metrics || {};
  mem.metrics.all = mem.metrics.all || {};
  const n = (mem.metrics.all[key] || 0) + 1;
  mem.metrics.all[key] = n;
  persistMem();
  return n;
}

/* Funnel counters: one row per day per event, just incremented. */
export async function bumpMetric(event) {
  const day = new Date().toISOString().slice(0, 10);
  if (pool) {
    await pool.query(
      "INSERT INTO metrics (day, event, n) VALUES ($1,$2,1) ON CONFLICT (day, event) DO UPDATE SET n = metrics.n + 1",
      [day, event]
    );
    return;
  }
  mem.metrics = mem.metrics || {};
  mem.metrics[day] = mem.metrics[day] || {};
  mem.metrics[day][event] = (mem.metrics[day][event] || 0) + 1;
  persistMem();
}

export async function getMetrics(days = 14) {
  if (pool) {
    const r = await pool.query("SELECT day, event, n FROM metrics WHERE day != 'all' AND day >= to_char(now() - ($1 || ' days')::interval, 'YYYY-MM-DD') ORDER BY day DESC", [String(days)]);
    return r.rows;
  }
  const out = [];
  const m = mem.metrics || {};
  Object.keys(m).filter((d) => d !== "all").sort().reverse().slice(0, days).forEach((d) => {
    Object.entries(m[d]).forEach(([event, n]) => out.push({ day: d, event, n }));
  });
  return out;
}

/* Metrics inside an explicit date window — the admin period filter (ALTO). */
export async function getMetricsBetween(fromIso, toIso) {
  const fromD = fromIso ? String(fromIso).slice(0, 10) : null;
  const toD = toIso ? String(toIso).slice(0, 10) : null;
  if (pool) {
    const conds = ["day != 'all'"]; const args = [];
    if (fromD) { args.push(fromD); conds.push(`day >= $${args.length}`); }
    if (toD) { args.push(toD); conds.push(`day <= $${args.length}`); }
    const r = await pool.query(`SELECT day, event, n FROM metrics WHERE ${conds.join(" AND ")} ORDER BY day DESC`, args);
    return r.rows;
  }
  const out = []; const m = mem.metrics || {};
  Object.keys(m).filter((d) => d !== "all" && (!fromD || d >= fromD) && (!toD || d <= toD)).sort().reverse().forEach((d) => {
    Object.entries(m[d]).forEach(([event, n]) => out.push({ day: d, event, n }));
  });
  return out;
}

// Wipe all funnel/visit counters (the admin "fresh start" before ads).
export async function clearMetrics() {
  if (pool) { const r = await pool.query("DELETE FROM metrics WHERE day != 'all'"); return r.rowCount; }
  const keep = mem.metrics?.all; // 'all' holds quota/lifetime counters — not funnel data
  const n = Object.keys(mem.metrics || {}).length;
  mem.metrics = keep ? { all: keep } : {};
  persistMem();
  return n;
}

// Wipe the closer meeting log (fresh start) — admin only.
export async function clearMeetings() {
  if (pool) { const r = await pool.query("DELETE FROM meetings"); return r.rowCount; }
  const n = (mem.meetings || []).length;
  mem.meetings = [];
  persistMem();
  return n;
}

export async function updateLeadStatus(contractorId, leadId, status) {
  if (pool) { await pool.query("UPDATE leads SET status=$3 WHERE id=$1 AND contractor_id=$2", [leadId, contractorId, status]); return; }
  const l = mem.leads.find(x => x.id === leadId && x.contractor_id === contractorId);
  if (l) { l.status = status; persistMem(); }
}
// The agent's free-text note on a lead — stored inside the info jsonb, so no migration
export async function updateLeadNote(contractorId, leadId, note) {
  if (pool) { await pool.query("UPDATE leads SET info = COALESCE(info,'{}'::jsonb) || $3::jsonb WHERE id=$1 AND contractor_id=$2", [leadId, contractorId, JSON.stringify({ note })]); return; }
  const l = mem.leads.find(x => x.id === leadId && x.contractor_id === contractorId);
  if (l) { l.info = { ...(l.info || {}), note }; persistMem(); }
}
// Merge extra fields (e.g. the setter's crm_note) into a lead's info without
// overwriting what's already there.
export async function updateLeadInfo(contractorId, leadId, patch = {}) {
  if (pool) { await pool.query("UPDATE leads SET info = COALESCE(info,'{}'::jsonb) || $3::jsonb WHERE id=$1 AND contractor_id=$2", [leadId, contractorId, JSON.stringify(patch)]); return; }
  const l = mem.leads.find(x => x.id === leadId && x.contractor_id === contractorId);
  if (l) { l.info = { ...(l.info || {}), ...patch }; persistMem(); }
}
// Archive a client's leads (status='deleted' hides them everywhere) — the
// admin "fresh start before ads" button. Nothing is destroyed.
export async function clearLeads(contractorId) {
  if (pool) { const r = await pool.query("UPDATE leads SET status='deleted' WHERE contractor_id=$1 AND (status IS NULL OR status <> 'deleted')", [contractorId]); return r.rowCount; }
  let n = 0;
  for (const l of mem.leads || []) if (l.contractor_id === contractorId && l.status !== "deleted") { l.status = "deleted"; n++; }
  persistMem();
  return n;
}
// Leads received inside a date range (archived ones don't count).
export async function leadCountInRange(range = null) {
  if (pool) {
    const { where, args } = rangeWhere(range);
    const r = await pool.query(`SELECT COUNT(*)::int AS total FROM leads ${where ? where + " AND" : "WHERE"} (status IS NULL OR status <> 'deleted')`, args);
    return r.rows[0]?.total || 0;
  }
  return memInRange(mem.leads || [], range).filter((l) => l.status !== "deleted").length;
}

export async function listLeads(contractorId) {
  if (pool) return (await pool.query("SELECT * FROM leads WHERE contractor_id=$1 AND (status IS NULL OR status <> 'deleted') ORDER BY created_at DESC LIMIT 200", [contractorId])).rows;
  return mem.leads.filter(l => l.contractor_id === contractorId && l.status !== "deleted").slice().reverse();
}

/* Restore a Quick Comp backup file (the /api/admin/backup format: clients
 * carry their state + leads nested; ALTO's flat shape also accepted).
 * Upserts everything — never deletes what already exists. */
export async function importAll(dump) {
  if (!dump || typeof dump !== "object") throw new Error("empty or invalid backup");
  const arr = (x) => (Array.isArray(x) ? x : []);
  // Normalize: Quick Comp backups nest state+leads inside each client.
  const clients = arr(dump.clients);
  const contractors = clients.length
    ? clients.map((c) => ({ id: c.id, slug: c.slug, name: c.name, phone: c.phone, data: c.data || {}, created_at: c.created_at }))
    : arr(dump.contractors);
  const states = clients.length
    ? clients.filter((c) => c.state).map((c) => ({ contractor_id: c.id, state: c.state }))
    : arr(dump.states);
  const leads = clients.length
    ? clients.flatMap((c) => arr(c.leads).map((l) => ({ ...l, contractor_id: l.contractor_id || c.id })))
    : arr(dump.leads);
  const meetings = arr(dump.meetings), tasks = arr(dump.tasks);
  const n = { contractors: 0, states: 0, leads: 0, meetings: 0, tasks: 0 };

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of contractors) {
        if (!c?.id || !c?.slug) continue;
        await client.query(
          `INSERT INTO contractors (id, slug, name, phone, data, created_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()))
           ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, name=EXCLUDED.name, phone=EXCLUDED.phone, data=EXCLUDED.data`,
          [c.id, c.slug, c.name || "", c.phone || "", c.data || {}, c.created_at || null]);
        n.contractors++;
      }
      for (const s of states) {
        if (!s?.contractor_id) continue;
        await client.query(
          `INSERT INTO app_state (contractor_id, state) VALUES ($1,$2)
           ON CONFLICT (contractor_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
          [s.contractor_id, s.state || {}]);
        n.states++;
      }
      for (const l of leads) {
        if (!l?.id) continue;
        await client.query(
          `INSERT INTO leads (id, contractor_id, name, phone, address, info, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()))
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, address=EXCLUDED.address, info=EXCLUDED.info, status=EXCLUDED.status`,
          [l.id, l.contractor_id || null, l.name || "", l.phone || "", l.address || "", l.info || {}, l.status || "new", l.created_at || null]);
        n.leads++;
      }
      for (const m of meetings) {
        if (!m?.id) continue;
        await client.query(
          `INSERT INTO meetings (id, name, phone, outcome, note, created_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()))
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, outcome=EXCLUDED.outcome, note=EXCLUDED.note`,
          [m.id, m.name || "", m.phone || "", m.outcome || "scheduled", m.note || "", m.created_at || null]);
        n.meetings++;
      }
      for (const t of tasks) {
        if (!t?.id) continue;
        await client.query(
          `INSERT INTO tasks (id, slug, title, note, status, created_at, done_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()),$7)
           ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, title=EXCLUDED.title, note=EXCLUDED.note, status=EXCLUDED.status, done_at=EXCLUDED.done_at`,
          [t.id, t.slug || "", t.title || "", t.note || "", t.status || "open", t.created_at || null, t.done_at || null]);
        n.tasks++;
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
    return n;
  }

  // JSON file store
  mem.contractors = mem.contractors || []; mem.states = mem.states || {};
  mem.leads = mem.leads || []; mem.meetings = mem.meetings || []; mem.tasks = mem.tasks || [];
  const upsertById = (list, rec) => { const i = list.findIndex((x) => x.id === rec.id); if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec); };
  for (const c of contractors) { if (!c?.id || !c?.slug) continue; upsertById(mem.contractors, c); n.contractors++; }
  for (const s of states) { if (!s?.contractor_id) continue; mem.states[s.contractor_id] = s.state || {}; n.states++; }
  for (const l of leads) { if (!l?.id) continue; upsertById(mem.leads, l); n.leads++; }
  for (const m of meetings) { if (!m?.id) continue; upsertById(mem.meetings, m); n.meetings++; }
  for (const t of tasks) { if (!t?.id) continue; upsertById(mem.tasks, t); n.tasks++; }
  persistMem();
  return n;
}
