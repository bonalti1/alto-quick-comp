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

export async function listLeads(contractorId) {
  if (pool) return (await pool.query("SELECT * FROM leads WHERE contractor_id=$1 ORDER BY created_at DESC LIMIT 200", [contractorId])).rows;
  return mem.leads.filter(l => l.contractor_id === contractorId).slice().reverse();
}
