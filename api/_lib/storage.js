// _lib/storage.js — Upstash Redis wrapper with in-memory fallback for dev.
//
// Redis key schema:
//   lead:{id}              → full lead object (JSON)
//   lead_email:{email}     → lead id          (O(1) lookup)
//   lead_code:{code}       → lead id          (O(1) lookup)
//   leads:index            → sorted set (score=created_at ms, member=lead id)
//   leads:count            → JSON { total, admitted, capacity: 100 }
//   stats_cache            → cached public stats (TTL 120s)
//   ratelimit:submit:{ip}  → INCR counter for submit rate limiting (TTL 3600s)
//   admin_session:{token}  → admin email (for server-side session invalidation, optional)

const KV_URL = () => process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL  || '';
const KV_TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

// ── In-memory fallback (dev / no-Redis) ──────────────────────────────────────

let _mem = null;
function memStore() {
  if (_mem) return _mem;
  _mem = { kv: new Map(), zsets: new Map(), ttls: new Map() };
  return _mem;
}

let _warnedNoKv = false;
function warnNoKv() {
  if (_warnedNoKv) return;
  _warnedNoKv = true;
  console.warn(
    '[aurum] KV_REST_API_URL / KV_REST_API_TOKEN not set — in-memory store. ' +
    'Data lost on cold start. Connect Upstash before production.'
  );
}

function memCall(cmd) {
  const s = memStore();
  const [op, ...a] = cmd;
  switch (op.toUpperCase()) {
    case 'SET': {
      s.kv.set(a[0], a[1]);
      // Handle EX option: ['SET', key, value, 'EX', seconds]
      const exIdx = a.indexOf('EX');
      if (exIdx >= 0 && a[exIdx + 1]) {
        s.ttls.set(a[0], Date.now() + Number(a[exIdx + 1]) * 1000);
      }
      return 'OK';
    }
    case 'GET': {
      const ttl = s.ttls.get(a[0]);
      if (ttl && Date.now() > ttl) { s.kv.delete(a[0]); s.ttls.delete(a[0]); return null; }
      return s.kv.get(a[0]) ?? null;
    }
    case 'DEL': { const had = s.kv.delete(a[0]); s.ttls.delete(a[0]); return had ? 1 : 0; }
    case 'EXISTS': {
      const ttl = s.ttls.get(a[0]);
      if (ttl && Date.now() > ttl) { s.kv.delete(a[0]); s.ttls.delete(a[0]); return 0; }
      return s.kv.has(a[0]) ? 1 : 0;
    }
    case 'INCR': {
      const ttl = s.ttls.get(a[0]);
      if (ttl && Date.now() > ttl) { s.kv.delete(a[0]); s.ttls.delete(a[0]); }
      const v = (parseInt(s.kv.get(a[0]) || '0', 10) || 0) + 1;
      s.kv.set(a[0], String(v));
      return v;
    }
    case 'EXPIRE': {
      if (s.kv.has(a[0])) s.ttls.set(a[0], Date.now() + Number(a[1]) * 1000);
      return 1;
    }
    case 'TTL': {
      const ttl = s.ttls.get(a[0]);
      if (!ttl) return s.kv.has(a[0]) ? -1 : -2;
      const rem = Math.ceil((ttl - Date.now()) / 1000);
      return rem > 0 ? rem : -2;
    }
    case 'SETEX': {
      // SETEX key seconds value
      s.kv.set(a[0], a[2]);
      s.ttls.set(a[0], Date.now() + Number(a[1]) * 1000);
      return 'OK';
    }
    case 'ZADD': {
      const k = a[0], score = Number(a[1]), member = a[2];
      const z = s.zsets.get(k) || new Map();
      z.set(member, score);
      s.zsets.set(k, z);
      return 1;
    }
    case 'ZRANGE': {
      const k = a[0], start = parseInt(a[1], 10), stop = parseInt(a[2], 10);
      const z = s.zsets.get(k) || new Map();
      const arr = [...z.entries()].sort((x, y) => x[1] - y[1]);
      const sliced = arr.slice(start, stop === -1 ? undefined : stop + 1);
      return sliced.map(([m]) => m);
    }
    case 'ZREVRANGE': {
      const k = a[0], start = parseInt(a[1], 10), stop = parseInt(a[2], 10);
      const z = s.zsets.get(k) || new Map();
      const arr = [...z.entries()].sort((x, y) => y[1] - x[1]);
      const sliced = arr.slice(start, stop === -1 ? undefined : stop + 1);
      return sliced.map(([m]) => m);
    }
    case 'ZCARD': {
      const z = s.zsets.get(a[0]) || new Map();
      return z.size;
    }
    case 'ZREM': {
      const z = s.zsets.get(a[0]) || new Map();
      z.delete(a[1]);
      return 1;
    }
    default: throw new Error(`memCall: unsupported op ${op}`);
  }
}

// ── Upstash REST caller ───────────────────────────────────────────────────────

async function call(cmd) {
  const url = KV_URL();
  const tok = KV_TOK();
  if (!url || !tok) {
    warnNoKv();
    return memCall(cmd);
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Upstash ${r.status}: ${text}`);
  }
  const j = await r.json();
  return j.result;
}

// ── Primitive helpers ─────────────────────────────────────────────────────────

async function setJSON(key, obj) {
  return call(['SET', key, JSON.stringify(obj)]);
}
async function getJSON(key) {
  const v = await call(['GET', key]);
  if (v == null) return null;
  if (typeof v === 'object') return v; // Upstash may auto-parse
  try { return JSON.parse(v); } catch { return null; }
}
async function setex(key, seconds, value) {
  return call(['SETEX', key, String(seconds), value]);
}
async function incr(key) { return call(['INCR', key]); }
async function expire(key, seconds) { return call(['EXPIRE', key, String(seconds)]); }
async function zAdd(key, score, member) { return call(['ZADD', key, String(score), member]); }
async function zRevRange(key, start = 0, stop = -1) {
  return call(['ZREVRANGE', key, String(start), String(stop)]);
}
async function zCard(key) { return call(['ZCARD', key]); }

// ── Lead helpers ──────────────────────────────────────────────────────────────

const LEAD_KEY       = (id)    => `lead:${id}`;
const EMAIL_KEY      = (email) => `lead_email:${email.toLowerCase().trim()}`;
const CODE_KEY       = (code)  => `lead_code:${code.toUpperCase()}`;
const LEADS_INDEX    = 'leads:index';

export async function saveLead(lead) {
  const id = lead.id;
  if (!id) throw new Error('saveLead: lead.id is required');
  await setJSON(LEAD_KEY(id), lead);
  // Maintain secondary indexes
  if (lead.email) {
    await call(['SET', EMAIL_KEY(lead.email), id]);
  }
  // Sorted set by creation time
  const score = lead.created_at || Date.now();
  await zAdd(LEADS_INDEX, typeof score === 'number' ? score : new Date(score).getTime(), id);
}

export async function getLead(id) {
  if (!id) return null;
  return getJSON(LEAD_KEY(id));
}

export async function findLeadByEmail(email) {
  if (!email) return null;
  const id = await call(['GET', EMAIL_KEY(email)]);
  if (!id) return null;
  return getLead(id);
}

export async function leadIdForCode(code) {
  if (!code) return null;
  const v = await call(['GET', CODE_KEY(code)]);
  return v || null;
}

export async function bindCode(leadId, code) {
  return call(['SET', CODE_KEY(code.toUpperCase()), leadId]);
}

export async function listLeads(opts = {}) {
  const { status, limit = 200, offset = 0 } = opts;
  const ids = await zRevRange(LEADS_INDEX, offset, offset + limit - 1);
  if (!ids || !ids.length) return [];
  const leads = [];
  for (const id of ids) {
    const l = await getLead(id);
    if (!l) continue;
    if (status && l.status !== status) continue;
    leads.push(l);
  }
  return leads;
}

export async function leadsCount() {
  // Count wire-cleared (admitted) members vs total inquiries
  const total    = await zCard(LEADS_INDEX);
  const all      = await listLeads({ limit: 500 });
  const admitted = all.filter(l => l.status === 'funded' || (l.wire && l.wire.cleared_at)).length;
  return { total, admitted, capacity: 100 };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Returns true if the IP is over the limit (max 3 per hour).
export async function isRateLimited(ip, max = 3, windowSecs = 3600) {
  if (!ip) return false;
  const key = `ratelimit:submit:${ip.replace(/[^\w.:-]/g, '_')}`;
  let count;
  try { count = await incr(key); } catch { return false; }
  if (count === 1) {
    // First hit in window — set TTL
    try { await expire(key, windowSecs); } catch {}
  }
  return count > max;
}

// ── Stats cache ───────────────────────────────────────────────────────────────
const STATS_CACHE_KEY = 'stats_cache';
const STATS_CACHE_TTL = 120; // seconds

export async function getCachedStats() {
  return getJSON(STATS_CACHE_KEY);
}

export async function setCachedStats(stats) {
  await setex(STATS_CACHE_KEY, STATS_CACHE_TTL, JSON.stringify(stats));
}

// ── Admin session (optional server-side token store) ─────────────────────────
export async function saveAdminSession(token, email) {
  const key = `admin_session:${token.slice(-16)}`;
  await setex(key, 60 * 60 * 12, JSON.stringify({ email, created_at: Date.now() }));
}

// ── Phase 2 extensions ────────────────────────────────────────────────────────
// All mutations go through saveLead() so the lead object is always the single
// source of truth. Sub-arrays (messages, capital_calls, bars) live on the lead.

// ── Capital calls ─────────────────────────────────────────────────────────────

export async function addCapitalCall(leadId, capitalCall) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addCapitalCall: lead ${leadId} not found`);
  lead.capital_calls = lead.capital_calls || [];
  lead.capital_calls.push(capitalCall);
  await saveLead(lead);
}

export async function updateCapitalCall(leadId, capitalCallId, updates) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`updateCapitalCall: lead ${leadId} not found`);
  lead.capital_calls = lead.capital_calls || [];
  const idx = lead.capital_calls.findIndex((c) => c.id === capitalCallId);
  if (idx === -1) throw new Error(`updateCapitalCall: capital call ${capitalCallId} not found`);
  lead.capital_calls[idx] = { ...lead.capital_calls[idx], ...updates };
  await saveLead(lead);
  return lead.capital_calls[idx];
}

export async function getCapitalCalls(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return [];
  return lead.capital_calls || [];
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function addMessage(leadId, message) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addMessage: lead ${leadId} not found`);
  lead.messages = lead.messages || [];
  lead.messages.push(message);
  await saveLead(lead);
}

export async function getMessages(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return [];
  return (lead.messages || []).slice().sort((a, b) => {
    const ta = new Date(a.sent_at).getTime();
    const tb = new Date(b.sent_at).getTime();
    return tb - ta; // descending
  });
}

export async function markMessageRead(leadId, messageId) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`markMessageRead: lead ${leadId} not found`);
  lead.messages = lead.messages || [];
  const msg = lead.messages.find((m) => m.id === messageId);
  if (!msg) throw new Error(`markMessageRead: message ${messageId} not found`);
  if (!msg.read_at) {
    msg.read_at = new Date().toISOString();
    await saveLead(lead);
  }
  return msg;
}

// ── Bars ──────────────────────────────────────────────────────────────────────

export async function addBar(leadId, bar) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addBar: lead ${leadId} not found`);
  lead.bars = lead.bars || [];
  lead.bars.push(bar);
  await saveLead(lead);
}

export async function getBars(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return [];
  return lead.bars || [];
}

// ── Member funded flow ────────────────────────────────────────────────────────

/**
 * markMemberFunded(leadId, memberNumber)
 * Sets status=funded, assigns member_number, records wire.cleared_at, appends audit.
 * Certificate generation is handled by the caller (v2.js wire-cleared handler).
 */
export async function markMemberFunded(leadId, memberNumber) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`markMemberFunded: lead ${leadId} not found`);

  const now = Date.now();
  lead.status        = 'funded';
  lead.member_number = memberNumber;
  lead.wire          = lead.wire || {};
  lead.wire.cleared_at = lead.wire.cleared_at || now;
  lead.funded_at     = now;

  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     now,
    actor:  'system',
    action: 'member_funded',
    meta:   { member_number: memberNumber },
  });

  await saveLead(lead);
  return lead;
}

/**
 * isMemberNumberTaken(number)
 * Scans all funded leads to check if number is already assigned.
 */
export async function isMemberNumberTaken(number) {
  const funded = await listLeads({ status: 'funded', limit: 200 });
  return funded.some((l) => l.member_number === number || String(l.member_number) === String(number));
}

/**
 * listFundedMembers()
 * Returns all leads with status=funded.
 */
export async function listFundedMembers() {
  return listLeads({ status: 'funded', limit: 200 });
}

// ── Phase 3 extensions ────────────────────────────────────────────────────────

// ── Quarterly letters ─────────────────────────────────────────────────────────

export async function addQuarterlyLetter(leadId, letter) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addQuarterlyLetter: lead ${leadId} not found`);
  lead.quarterly_letters = lead.quarterly_letters || [];
  lead.quarterly_letters.push(letter);
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     Date.now(),
    actor:  'system',
    action: 'quarterly_letter_issued',
    meta:   { letter_id: letter.id, quarter: letter.quarter, year: letter.year },
  });
  await saveLead(lead);
}

export async function markLetterRead(leadId, letterId) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`markLetterRead: lead ${leadId} not found`);
  lead.quarterly_letters = lead.quarterly_letters || [];
  const letter = lead.quarterly_letters.find((l) => l.id === letterId);
  if (!letter) throw new Error(`markLetterRead: letter ${letterId} not found`);
  if (!letter.read_at) {
    letter.read_at = new Date().toISOString();
    await saveLead(lead);
  }
  return letter;
}

// ── Vault verifications ───────────────────────────────────────────────────────

export async function addVaultVerification(leadId, vv) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addVaultVerification: lead ${leadId} not found`);
  lead.vault_verifications = lead.vault_verifications || [];
  lead.vault_verifications.push(vv);
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     Date.now(),
    actor:  'system',
    action: 'vault_verification_published',
    meta:   { vv_id: vv.id, year: vv.year },
  });
  await saveLead(lead);
}

export async function broadcastVaultVerification(vv) {
  const funded = await listFundedMembers();
  const errors = [];
  for (const lead of funded) {
    try {
      await addVaultVerification(lead.id, { ...vv });
    } catch (e) {
      errors.push({ leadId: lead.id, error: e.message });
    }
  }
  return { sent_to: funded.length - errors.length, total: funded.length, errors };
}

// ── Tax statements ────────────────────────────────────────────────────────────

export async function saveTaxStatementUrl(leadId, fiscalYear, url) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`saveTaxStatementUrl: lead ${leadId} not found`);
  lead.tax_statements = lead.tax_statements || {};
  lead.tax_statements[String(fiscalYear)] = url;
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     Date.now(),
    actor:  'system',
    action: 'tax_statement_generated',
    meta:   { fiscal_year: fiscalYear, url },
  });
  await saveLead(lead);
}
