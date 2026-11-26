// 🐝 Plan Bee: the database part (a Cloudflare Worker with a D1 database)
//
// Setup, all in the Cloudflare dashboard:
//   1. Create a D1 database (any name).
//   2. Paste this whole file into your Worker and deploy it.
//   3. In the Worker's Bindings tab, add a "D1 database" binding with the variable name  DB
//   4. Open your Worker's link. You should see "Plan Bee is buzzing!"
// The tables are created automatically, so there's no SQL to run.

const LIMITS = {
  title: 80,      // characters in a plan name
  name: 40,       // characters in a person's name
  comment: 200,   // characters in a comment
  pin: 12,        // characters in a PIN
  rangeDays: 62,  // longest date range a plan can cover
  people: 60,     // most people on one plan
  keepDays: 30,   // plans are deleted this many days after their last date
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS plans (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS people (
     plan_id TEXT NOT NULL,
     name_key TEXT NOT NULL,
     name TEXT NOT NULL,
     days TEXT NOT NULL DEFAULT '[]',
     comment TEXT NOT NULL DEFAULT '',
     pin_hash TEXT,
     seq INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (plan_id, name_key)
   )`,
  `CREATE INDEX IF NOT EXISTS plans_by_expiry ON plans (expires_at)`,
];

// Columns added after Plan Bee launched. Older tables get them here; tables that already have them are left alone.
const ADDED_COLUMNS = [
  "ALTER TABLE plans ADD COLUMN owner_hash TEXT", // proves who made a plan, so only they can change it
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/o, 1/l/i look-alikes
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

class Oops extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const method = request.method;

    if (!env.DB) {
      const msg = "The Worker is running, but no database is connected yet. In this Worker's Bindings tab, add a D1 database binding with the variable name DB.";
      return parts.length === 0 ? text("⚠️ " + msg, 500) : json({ error: msg }, 500);
    }

    try {
      await ensureSchema(env.DB);
      const db = env.DB;

      if (parts.length === 0 && method === "GET") {
        return text("🐝 Plan Bee is buzzing! The database is connected. Paste this page's link into index.html.");
      }
      if (parts[0] === "plans") {
        const id = (parts[1] || "").toLowerCase();
        if (parts.length === 1 && method === "POST") return json(await createPlan(db, await readBody(request)), 201);
        if (parts.length === 2 && method === "GET") return json(await getPlan(db, id));
        if (parts.length === 2 && method === "PUT") return json(await editPlan(db, id, await readBody(request)));
        if (parts.length === 3 && parts[2] === "people" && method === "PUT") return json(await savePerson(db, id, await readBody(request)));
        if (parts.length === 3 && parts[2] === "remove" && method === "POST") return json(await removePerson(db, id, await readBody(request)));
      }
      throw new Oops(404, "Not found.");
    } catch (err) {
      if (err instanceof Oops) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on our end. Try again in a moment." }, 500);
    }
  },
};

// ───────── Actions ─────────

async function createPlan(db, body) {
  const { title, start, end } = readPlanFields(body);

  // Tidy up while we're here: delete plans whose keep-until date has passed.
  const cutoff = toDateString(today());
  await db.batch([
    db.prepare("DELETE FROM people WHERE plan_id IN (SELECT id FROM plans WHERE expires_at < ?)").bind(cutoff),
    db.prepare("DELETE FROM plans WHERE expires_at < ?").bind(cutoff),
  ]);

  // The owner key goes back to the browser that made the plan and stays there. Only a hash of it is saved here.
  const ownerKey = newId(24);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId(10);
    try {
      await db.prepare("INSERT INTO plans (id, title, start_date, end_date, expires_at, owner_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, title, toDateString(start), toDateString(end), toDateString(end + LIMITS.keepDays), await ownerHash(id, ownerKey))
        .run();
      return { id, owner_key: ownerKey };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
    }
  }
  throw new Oops(500, "Couldn't make a link just now. Try again.");
}

async function getPlan(db, id) {
  const plan = await findPlan(db, id);
  if (!plan) throw new Oops(404, "This plan isn't here. The link may be mistyped, or the plan expired.");
  const { results } = await db
    .prepare("SELECT name, days, comment, pin_hash IS NOT NULL AS locked, seq FROM people WHERE plan_id = ? ORDER BY seq")
    .bind(plan.id)
    .all();
  // If the plan's dates change, days picked outside the new dates stay saved but aren't shown or counted.
  const inRange = d => d >= plan.start_date && d <= plan.end_date;
  const { owner_hash, ...shown } = plan;
  return {
    ...shown,
    has_owner: !!owner_hash,
    people: results.map(r => ({ name: r.name, days: parseDays(r.days).filter(inRange), comment: r.comment, locked: !!r.locked, seq: r.seq })),
  };
}

async function editPlan(db, planId, body) {
  const notOwner = "Only the person who made this plan can change it.";
  const plan = await findPlan(db, planId);
  if (!plan) throw new Oops(404, "This plan no longer exists.");

  // Only the browser that made a plan has its owner key. Plans made before owner keys existed
  // have none, so whoever changes one of those first becomes its owner.
  let ownerKey = typeof body.owner_key === "string" ? body.owner_key : "";
  if (!plan.owner_hash) ownerKey = newId(24);
  else if (!ownerKey || await ownerHash(plan.id, ownerKey) !== plan.owner_hash) throw new Oops(403, notOwner);

  const { title, start, end } = readPlanFields(body);
  const hash = await ownerHash(plan.id, ownerKey);

  // The WHERE re-checks the owner inside the same statement, in case two edits race.
  const result = await db.prepare(
    `UPDATE plans SET title = ?1, start_date = ?2, end_date = ?3, expires_at = ?4, owner_hash = ?5
     WHERE id = ?6 AND (owner_hash IS NULL OR owner_hash = ?5)`
  ).bind(title, toDateString(start), toDateString(end), toDateString(end + LIMITS.keepDays), hash, plan.id).run();

  if (result.meta && result.meta.changes === 0) throw new Oops(403, notOwner);
  return { ...(await getPlan(db, plan.id)), owner_key: ownerKey };
}

async function savePerson(db, planId, body) {
  const plan = await findPlan(db, planId);
  if (!plan) throw new Oops(404, "This plan no longer exists.");

  const name = cleanText(body.name);
  if (!name) throw new Oops(400, "Add your name first.");
  if (length(name) > LIMITS.name) throw new Oops(400, `Keep your name to ${LIMITS.name} characters.`);
  const comment = cleanText(body.comment);
  if (length(comment) > LIMITS.comment) throw new Oops(400, `Keep the comment to ${LIMITS.comment} characters.`);
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (length(pin) > LIMITS.pin) throw new Oops(400, `Keep the PIN to ${LIMITS.pin} characters.`);

  const key = name.toLowerCase();
  const first = toDayNumber(plan.start_date), last = toDayNumber(plan.end_date);
  const days = [...new Set((Array.isArray(body.days) ? body.days : [])
      .map(d => toDayNumber(d))
      .filter(n => n !== null && n >= first && n <= last))]
    .sort((a, b) => a - b)
    .map(toDateString);
  const pinHash = pin ? await sha256(`${plan.id}:${key}:${pin}`) : null;

  const existing = await db.prepare("SELECT pin_hash FROM people WHERE plan_id = ? AND name_key = ?").bind(plan.id, key).first();
  if (existing && existing.pin_hash && existing.pin_hash !== pinHash) {
    throw new Oops(403, pin ? "That PIN doesn't match. Try again?" : "This name is locked with a PIN. Enter the PIN to change it.");
  }
  if (!existing) {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM people WHERE plan_id = ?").bind(plan.id).first();
    if (row && row.n >= LIMITS.people) throw new Oops(409, `This plan is full (${LIMITS.people} people).`);
  }

  // The WHERE on the update re-checks the PIN inside the same statement, in case two saves race.
  const result = await db.prepare(
    `INSERT INTO people (plan_id, name_key, name, days, comment, pin_hash, seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM people WHERE plan_id = ?1))
     ON CONFLICT (plan_id, name_key) DO UPDATE SET
       name = excluded.name,
       days = excluded.days,
       comment = excluded.comment,
       pin_hash = COALESCE(people.pin_hash, excluded.pin_hash),
       updated_at = datetime('now')
     WHERE people.pin_hash IS NULL OR people.pin_hash = excluded.pin_hash`
  ).bind(plan.id, key, name, JSON.stringify(days), comment, pinHash).run();

  if (result.meta && result.meta.changes === 0) {
    throw new Oops(403, "This name is locked with a PIN. Enter the PIN to change it.");
  }
  return getPlan(db, plan.id);
}

async function removePerson(db, planId, body) {
  const plan = await findPlan(db, planId);
  if (!plan) throw new Oops(404, "This plan no longer exists.");
  const key = cleanText(body.name).toLowerCase();
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  const existing = await db.prepare("SELECT pin_hash FROM people WHERE plan_id = ? AND name_key = ?").bind(plan.id, key).first();
  if (existing) {
    const pinHash = pin ? await sha256(`${plan.id}:${key}:${pin}`) : null;
    if (existing.pin_hash && existing.pin_hash !== pinHash) {
      throw new Oops(403, pin ? "That PIN doesn't match. Try again?" : "This name is locked with a PIN. Enter the PIN to remove it.");
    }
    await db.prepare("DELETE FROM people WHERE plan_id = ? AND name_key = ?").bind(plan.id, key).run();
  }
  return getPlan(db, plan.id);
}

// ───────── Helpers ─────────

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = setUpTables(db).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function setUpTables(db) {
  await db.batch(SCHEMA.map(sql => db.prepare(sql)));
  for (const sql of ADDED_COLUMNS) {
    try { await db.prepare(sql).run(); }
    catch (err) { if (!/duplicate column/i.test(String(err && err.message))) throw err; } // already added
  }
}

// The same rules apply when a plan is made and when it's changed.
function readPlanFields(body) {
  const title = cleanText(body.title);
  if (!title) throw new Oops(400, "Give your plan a name.");
  if (length(title) > LIMITS.title) throw new Oops(400, `Keep the plan name to ${LIMITS.title} characters.`);

  const start = toDayNumber(body.start), end = toDayNumber(body.end);
  if (start === null || end === null) throw new Oops(400, "Pick a start date and an end date.");
  if (end < start) throw new Oops(400, "The end date needs to be on or after the start date.");
  if (end - start + 1 > LIMITS.rangeDays) throw new Oops(400, "Keep the dates within about two months.");
  if (end < today() - 1) throw new Oops(400, "Those dates are already in the past.");
  if (start > today() + 366) throw new Oops(400, "Pick dates within the next year.");
  return { title, start, end };
}

async function findPlan(db, id) {
  if (!/^[a-z0-9]{6,20}$/.test(id)) return null;
  const plan = await db.prepare("SELECT id, title, start_date, end_date, expires_at, owner_hash FROM plans WHERE id = ?").bind(id).first();
  if (!plan || plan.expires_at < toDateString(today())) return null;
  return plan;
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 10000) throw new Oops(413, "That request is too big.");
  try {
    const body = JSON.parse(raw || "{}");
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new Oops(400, "Couldn't read that request.");
}

function cleanText(value) {
  return (typeof value === "string" ? value : "").normalize("NFC").replace(/\s+/g, " ").trim();
}
const length = s => [...s].length;

function toDayNumber(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.getTime() / DAY_MS;
}
const toDateString = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / DAY_MS);

function parseDays(value) {
  try { const a = JSON.parse(value); return Array.isArray(a) ? a : []; } catch { return []; }
}

function newId(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

async function sha256(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const ownerHash = (planId, key) => sha256(`${planId}:owner:${key}`);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
}
