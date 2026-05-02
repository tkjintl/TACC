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
  await appendAudit(lead, {
    actor:  'system',
    action: 'tax_statement_generated',
    next:   { fiscal_year: fiscalYear, url },
  });
  await saveLead(lead);
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 4 — Audit, counters, compliance flags, idempotency, messages
// ────────────────────────────────────────────────────────────────────────────

// In-memory ZADD support for audit:global needs ZRANGEBYSCORE — extend memCall
async function _zAddRaw(key, score, member) {
  return call(['ZADD', key, String(score), member]);
}
async function _zRangeByScore(key, min, max, limit, offset) {
  const args = ['ZRANGEBYSCORE', key, String(min), String(max)];
  if (limit != null) args.push('LIMIT', String(offset || 0), String(limit));
  return callExt(args);
}
async function _zRevRangeByScore(key, max, min, limit, offset) {
  const args = ['ZREVRANGEBYSCORE', key, String(max), String(min)];
  if (limit != null) args.push('LIMIT', String(offset || 0), String(limit));
  return callExt(args);
}
async function _scan(pattern, count = 100) {
  // Upstash: SCAN cursor MATCH pattern COUNT n. Iterate till cursor=0.
  let cursor = '0';
  const keys = [];
  let safety = 0;
  do {
    const r = await callExt(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count)]);
    if (Array.isArray(r) && r.length === 2) {
      cursor = String(r[0]);
      if (Array.isArray(r[1])) keys.push(...r[1]);
    } else {
      break;
    }
    safety++;
    if (safety > 1000) break;
  } while (cursor !== '0');
  return keys;
}

// Augment in-memory store to support new commands used above.
const _origMemCall = memCall;
function memCallExt(cmd) {
  const s = memStore();
  const op = String(cmd[0]).toUpperCase();
  const a = cmd.slice(1);
  // Initialise lists map lazily
  if (!s.lists) s.lists = new Map();
  switch (op) {
    case 'RPUSH': {
      const k = a[0];
      const list = s.lists.get(k) || [];
      for (let i = 1; i < a.length; i++) list.push(a[i]);
      s.lists.set(k, list);
      return list.length;
    }
    case 'LPUSH': {
      const k = a[0];
      const list = s.lists.get(k) || [];
      for (let i = 1; i < a.length; i++) list.unshift(a[i]);
      s.lists.set(k, list);
      return list.length;
    }
    case 'LRANGE': {
      const k = a[0];
      const start = parseInt(a[1], 10);
      const stop  = parseInt(a[2], 10);
      const list = s.lists.get(k) || [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    }
    case 'LLEN': {
      const list = s.lists.get(a[0]) || [];
      return list.length;
    }
    case 'DECR': {
      const v = (parseInt(s.kv.get(a[0]) || '0', 10) || 0) - 1;
      s.kv.set(a[0], String(v));
      return v;
    }
    case 'SET': {
      // Support EX option used by addComplianceFlag/withIdempotency
      s.kv.set(a[0], a[1]);
      const exIdx = a.indexOf('EX');
      if (exIdx >= 0 && a[exIdx + 1]) {
        s.ttls.set(a[0], Date.now() + Number(a[exIdx + 1]) * 1000);
      } else {
        s.ttls.delete(a[0]);
      }
      return 'OK';
    }
    case 'ZRANGEBYSCORE':
    case 'ZREVRANGEBYSCORE': {
      const k = a[0];
      const parseB = (v) => {
        if (v === '-inf') return -Infinity;
        if (v === '+inf') return Infinity;
        return Number(v);
      };
      // For ZRANGEBYSCORE: a[1]=min, a[2]=max
      // For ZREVRANGEBYSCORE: a[1]=max, a[2]=min
      const lo = op === 'ZRANGEBYSCORE' ? parseB(a[1]) : parseB(a[2]);
      const hi = op === 'ZRANGEBYSCORE' ? parseB(a[2]) : parseB(a[1]);
      let limit = null, offset = 0;
      const li = a.findIndex((x) => String(x).toUpperCase() === 'LIMIT');
      if (li >= 0) { offset = parseInt(a[li + 1], 10); limit = parseInt(a[li + 2], 10); }
      const z = s.zsets.get(k) || new Map();
      let arr = [...z.entries()].filter(([, sc]) => sc >= lo && sc <= hi);
      arr.sort((x, y) => op === 'ZREVRANGEBYSCORE' ? y[1] - x[1] : x[1] - y[1]);
      if (limit != null) arr = arr.slice(offset, offset + limit);
      return arr.map(([m]) => m);
    }
    case 'SCAN': {
      // Returns ['0', [matchingKeys]]
      let pattern = '*';
      const mi = a.findIndex((x) => String(x).toUpperCase() === 'MATCH');
      if (mi >= 0) pattern = a[mi + 1];
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const allKeys = [...s.kv.keys()].filter((k) => {
        const ttl = s.ttls.get(k);
        if (ttl && Date.now() > ttl) { s.kv.delete(k); s.ttls.delete(k); return false; }
        return re.test(k);
      });
      return ['0', allKeys];
    }
    case 'ZRANGEBYSCORE_': // unreachable, here for future proofing
      return [];
    case 'ZREMRANGEBYSCORE': {
      const k = a[0];
      const parseB = (v) => {
        if (v === '-inf') return -Infinity;
        if (v === '+inf') return Infinity;
        return Number(v);
      };
      const lo = parseB(a[1]);
      const hi = parseB(a[2]);
      const z = s.zsets.get(k) || new Map();
      let removed = 0;
      for (const [m, sc] of [...z.entries()]) {
        if (sc >= lo && sc <= hi) { z.delete(m); removed++; }
      }
      s.zsets.set(k, z);
      return removed;
    }
    default:
      return _origMemCall(cmd);
  }
}
// Re-route call() through extended memCall when no KV.
const _origCall = call;
async function callExt(cmd) {
  const url = KV_URL();
  const tok = KV_TOK();
  if (!url || !tok) {
    warnNoKv();
    return memCallExt(cmd);
  }
  return _origCall(cmd);
}
// Replace local helpers' use of `call` with `callExt`. We can't reassign `call`
// (it's a const function), so we route the new helpers through callExt directly.
// (Existing code still uses `call` which uses the old memCall — unchanged.)

// ── Audit (per-lead + global stream) ──────────────────────────────────────────

const AUDIT_GLOBAL_KEY = 'audit:global';

/**
 * appendAudit(lead, entry)
 * Mutates lead.audit IN PLACE (push) and writes a copy to global stream.
 * Caller is responsible for calling saveLead(lead) afterwards (so we can batch).
 * Entry shape: { actor, action, prev?, next?, memo?, ip?, target_type?, target_id? }
 */
export async function appendAudit(lead, entry) {
  const at = entry.at || Date.now();
  const e = {
    at,
    actor:  entry.actor || 'system',
    action: entry.action,
    prev:   entry.prev != null ? entry.prev : undefined,
    next:   entry.next != null ? entry.next : undefined,
    memo:   entry.memo || undefined,
    ip:     entry.ip   || undefined,
  };
  lead.audit = lead.audit || [];
  lead.audit.push(e);

  // Global stream
  const globalEntry = {
    ...e,
    leadId:      lead.id,
    target_type: entry.target_type || 'lead',
    target_id:   entry.target_id   || lead.id,
    target_name: lead.name || lead.email || lead.id,
  };
  try {
    // Score = at (ms). Member must be unique, so we suffix with leadId+random.
    const member = JSON.stringify(globalEntry);
    await callExt(['ZADD', AUDIT_GLOBAL_KEY, String(at), member]);
  } catch (err) {
    console.warn('[appendAudit] global stream write failed:', err && err.message);
  }
  return e;
}

export async function globalAuditAppend(entry) {
  const at = entry.at || Date.now();
  const e = { at, ...entry };
  await callExt(['ZADD', AUDIT_GLOBAL_KEY, String(at), JSON.stringify(e)]);
  return e;
}

export async function globalAuditList({ limit = 50, offset = 0, since, until, actor, action } = {}) {
  const max = until ? String(until) : '+inf';
  const min = since ? String(since) : '-inf';
  const raw = await _zRevRangeByScore(AUDIT_GLOBAL_KEY, max, min, Math.min(500, limit + offset + 200), 0);
  const entries = [];
  for (const m of (raw || [])) {
    try {
      const parsed = typeof m === 'string' ? JSON.parse(m) : m;
      if (actor && parsed.actor !== actor) continue;
      if (action && parsed.action !== action) continue;
      entries.push(parsed);
    } catch {}
  }
  return entries.slice(offset, offset + limit);
}

export async function getActivityFeed({ limit = 50 } = {}) {
  return globalAuditList({ limit, offset: 0 });
}

// ── Stage counters ────────────────────────────────────────────────────────────

const STAGE_KEY = (stage) => `counter:stage:${stage}`;
const STAGES = ['inquiry', 'invited', 'nda_pending', 'subscribed', 'wire_issued', 'wire_received', 'funded'];

export async function getStageCounts() {
  const out = {};
  let total = 0;
  for (const s of STAGES) {
    const v = await callExt(['GET', STAGE_KEY(s)]);
    const n = Math.max(0, parseInt(v || '0', 10) || 0);
    out[s] = n;
    total += n;
  }
  out.total = total;
  return out;
}

async function _stageIncr(stage, delta) {
  if (!stage || !STAGES.includes(stage)) return;
  // Read-modify-write to avoid going negative
  const cur = parseInt((await callExt(['GET', STAGE_KEY(stage)])) || '0', 10) || 0;
  const next = Math.max(0, cur + delta);
  await callExt(['SET', STAGE_KEY(stage), String(next)]);
}

/**
 * transitionStage(lead, fromStage, toStage)
 * Updates per-stage counters atomically (best-effort) + records audit.
 * Caller must saveLead() afterwards (to persist any other lead mutations).
 */
export async function transitionStage(lead, fromStage, toStage) {
  if (fromStage === toStage) return;
  if (fromStage) await _stageIncr(fromStage, -1);
  if (toStage)   await _stageIncr(toStage,   +1);
  await appendAudit(lead, {
    actor:  'system',
    action: 'stage_transition',
    prev:   fromStage,
    next:   toStage,
  });
}

/**
 * recountStages()
 * Recomputes counters from scratch by scanning all leads. Use sparingly.
 */
export async function recountStages() {
  // Resolve current stage of every lead
  const all = await listLeads({ limit: 1000 });
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const l of all) {
    const stage = _resolveStage(l);
    if (counts[stage] != null) counts[stage]++;
  }
  for (const s of STAGES) {
    await callExt(['SET', STAGE_KEY(s), String(counts[s])]);
  }
  return counts;
}

function _resolveStage(lead) {
  if (lead.deleted_at) return null;
  if (lead.status === 'funded') return 'funded';
  const wire = lead.wire || {};
  if (wire.reference && wire.received_at && !wire.cleared_at) return 'wire_received';
  if (wire.reference && !wire.received_at) return 'wire_issued';
  if (lead.status === 'subscribed') return 'subscribed';
  if (lead.nda_state === 'uploaded') return 'nda_pending';
  if (lead.status === 'invited' || lead.code) return 'invited';
  return 'inquiry';
}

export { _resolveStage as resolveLeadStage };

// ── Compliance flags ──────────────────────────────────────────────────────────

const FLAG_KEY  = (leadId, type) => `flag:${leadId}:${type}`;
const MUTE_KEY  = (leadId, type) => `flag:muted:${leadId}:${type}`;
const FLAG_SCAN = 'flag:*';

const SEVERITY_BY_TYPE = {
  'kyc-expiring':              'warning',
  'nda-missing':               'critical',
  'code-expiring':             'warning',
  'ltv-approaching':           'warning',
  'ltv-near-ceiling':          'critical',
  'capital-call-overdue':      'critical',
  'member-inactive':           'info',
  'wire-pending-stale':        'warning',
  'vault-verification-overdue':'warning',
};

export async function addComplianceFlag(leadId, type, reason, ttlSeconds = 32 * 86400) {
  // Skip if muted
  const muted = await callExt(['EXISTS', MUTE_KEY(leadId, type)]);
  if (muted === 1) return { skipped: 'muted' };

  const now = Date.now();
  const flag = {
    leadId,
    type,
    severity: SEVERITY_BY_TYPE[type] || 'info',
    reason,
    created_at: now,
  };
  await callExt(['SET', FLAG_KEY(leadId, type), JSON.stringify(flag), 'EX', String(ttlSeconds)]);
  return flag;
}

export async function listComplianceFlags() {
  const keys = await _scan(FLAG_SCAN, 200);
  const flags = [];
  for (const k of keys) {
    if (k.startsWith('flag:muted:')) continue;
    const v = await callExt(['GET', k]);
    if (!v) continue;
    let parsed;
    try { parsed = typeof v === 'object' ? v : JSON.parse(v); } catch { continue; }
    // Hydrate lead name (best-effort)
    const lead = parsed.leadId ? await getLead(parsed.leadId) : null;
    flags.push({
      ...parsed,
      leadName: lead ? (lead.name || lead.email) : null,
      age_seconds: Math.floor((Date.now() - (parsed.created_at || Date.now())) / 1000),
      action_url: lead ? `/admin#lead-${parsed.leadId}` : null,
    });
  }
  flags.sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    const sa = sevOrder[a.severity] ?? 3;
    const sb = sevOrder[b.severity] ?? 3;
    if (sa !== sb) return sa - sb;
    return (b.created_at || 0) - (a.created_at || 0);
  });
  return flags;
}

export async function muteFlag(leadId, type, duration) {
  const ttl = _parseDuration(duration);
  await callExt(['SET', MUTE_KEY(leadId, type), '1', 'EX', String(ttl)]);
  // Also remove the active flag
  await callExt(['DEL', FLAG_KEY(leadId, type)]);
  return { muted: true, ttl };
}

function _parseDuration(d) {
  if (d === 'forever') return 60 * 60 * 24 * 365 * 10; // 10y ~= forever
  if (d === '90d') return 60 * 60 * 24 * 90;
  if (d === '30d') return 60 * 60 * 24 * 30;
  if (typeof d === 'number') return d;
  return 60 * 60 * 24 * 30;
}

// ── External messages history ─────────────────────────────────────────────────

const MSG_HIST_KEY = (leadId) => `messages:${leadId}`;

export async function appendMessageHistory(leadId, message) {
  await callExt(['RPUSH', MSG_HIST_KEY(leadId), JSON.stringify(message)]);
}

export async function getMessageHistory(leadId, { limit = 50, offset = 0 } = {}) {
  const start = offset;
  const stop  = offset + limit - 1;
  const raw = await callExt(['LRANGE', MSG_HIST_KEY(leadId), String(start), String(stop)]);
  const out = [];
  for (const m of (raw || [])) {
    try { out.push(typeof m === 'object' ? m : JSON.parse(m)); } catch {}
  }
  return out;
}

// ── Idempotency ──────────────────────────────────────────────────────────────

const IDEM_KEY = (k) => `idem:${k}`;

export async function withIdempotency(key, ttlSeconds, fn) {
  if (!key) return fn();
  const existing = await callExt(['GET', IDEM_KEY(key)]);
  if (existing) {
    try { return typeof existing === 'object' ? existing : JSON.parse(existing); } catch { return existing; }
  }
  const result = await fn();
  try {
    await callExt(['SET', IDEM_KEY(key), JSON.stringify(result), 'EX', String(ttlSeconds || 60)]);
  } catch {}
  return result;
}

// ── Vault verification: global state ──────────────────────────────────────────

const VAULT_LAST_KEY = 'vault:last_verification';

export async function getLastVaultVerification() {
  return getJSON(VAULT_LAST_KEY);
}
export async function setLastVaultVerification(vv) {
  await setJSON(VAULT_LAST_KEY, vv);
}

// Patch broadcastVaultVerification by exposing a setter helper above.
// (broadcastVaultVerification itself is left untouched; exceptions.js reads the timestamp.)

// ── Soft delete ───────────────────────────────────────────────────────────────

export async function softDeleteLead(leadId, reason, actor) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`softDeleteLead: lead ${leadId} not found`);
  if (lead.deleted_at) return lead;
  const fromStage = _resolveStage(lead);
  lead.deleted_at = Date.now();
  lead.deleted_reason = reason || null;
  await appendAudit(lead, { actor: actor || 'admin', action: 'lead_soft_deleted', memo: reason });
  if (fromStage) await _stageIncr(fromStage, -1);
  await saveLead(lead);
  return lead;
}

// ── Member positions (deal allocations) ───────────────────────────────────────

export async function addPosition(leadId, position, actor) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`addPosition: lead ${leadId} not found`);
  lead.positions = lead.positions || [];
  if (!position.id) position.id = `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  lead.positions.push(position);
  await appendAudit(lead, { actor: actor || 'admin', action: 'position_added', next: { id: position.id, deal: position.deal_name || position.deal_id } });
  await saveLead(lead);
  return position;
}
export async function updatePosition(leadId, positionId, updates, actor) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`updatePosition: lead ${leadId} not found`);
  lead.positions = lead.positions || [];
  const idx = lead.positions.findIndex((p) => p.id === positionId);
  if (idx === -1) throw new Error(`updatePosition: position ${positionId} not found`);
  const prev = lead.positions[idx];
  lead.positions[idx] = { ...prev, ...updates };
  await appendAudit(lead, { actor: actor || 'admin', action: 'position_updated', prev, next: lead.positions[idx] });
  await saveLead(lead);
  return lead.positions[idx];
}
export async function removePosition(leadId, positionId, actor) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`removePosition: lead ${leadId} not found`);
  lead.positions = lead.positions || [];
  const idx = lead.positions.findIndex((p) => p.id === positionId);
  if (idx === -1) throw new Error(`removePosition: position ${positionId} not found`);
  const removed = lead.positions.splice(idx, 1)[0];
  await appendAudit(lead, { actor: actor || 'admin', action: 'position_removed', prev: removed });
  await saveLead(lead);
  return removed;
}

// ── Hard delete + bulk wipe helpers (for demo wipe) ───────────────────────────

/**
 * deleteLead(id)
 * Hard-removes a lead and every secondary index/array tied to it.
 * Use ONLY for demo data — production removals should call softDeleteLead().
 */
export async function deleteLead(id) {
  if (!id) return { removed: false };
  const lead = await getLead(id);
  // Remove sorted-set membership
  try { await callExt(['ZREM', LEADS_INDEX, id]); } catch {}
  // Remove email + code secondary indexes
  if (lead && lead.email) {
    try { await callExt(['DEL', EMAIL_KEY(lead.email)]); } catch {}
  }
  if (lead && lead.code) {
    try { await callExt(['DEL', CODE_KEY(lead.code)]); } catch {}
  }
  // Per-key arrays
  try { await callExt(['DEL', MSG_HIST_KEY(id)]); } catch {}
  // Remove any active flags scoped to this lead
  try {
    const keys = await _scan(`flag:${id}:*`, 100);
    for (const k of keys) { try { await callExt(['DEL', k]); } catch {} }
    const muted = await _scan(`flag:muted:${id}:*`, 100);
    for (const k of muted) { try { await callExt(['DEL', k]); } catch {} }
  } catch {}
  // Finally the lead itself
  try { await callExt(['DEL', LEAD_KEY(id)]); } catch {}
  return { removed: true, hadLead: !!lead };
}

/**
 * wipeGlobalAudit()
 * Clears the entire `audit:global` sorted set.
 */
export async function wipeGlobalAudit() {
  try { await callExt(['ZREMRANGEBYSCORE', AUDIT_GLOBAL_KEY, '-inf', '+inf']); return true; }
  catch (e) {
    // Fallback: re-create by deleting key
    try { await callExt(['DEL', AUDIT_GLOBAL_KEY]); return true; } catch {}
    return false;
  }
}

/**
 * wipeAllFlags()
 * Scans flag:* keys and deletes them. Skips muted entries by default.
 */
export async function wipeAllFlags({ includeMuted = false } = {}) {
  const keys = await _scan('flag:*', 200);
  let removed = 0;
  for (const k of keys) {
    if (!includeMuted && k.startsWith('flag:muted:')) continue;
    try { await callExt(['DEL', k]); removed++; } catch {}
  }
  return removed;
}

// ── Deal book ─────────────────────────────────────────────────────────────────
// deal:{id}      → JSON deal record
// deals:index    → ZADD score=created_at member=id

const DEAL_KEY    = (id) => `deal:${id}`;
const DEALS_INDEX = 'deals:index';

export async function saveDeal(deal) {
  if (!deal || !deal.id) throw new Error('saveDeal: deal.id required');
  const score = deal.created_at || Date.now();
  await setJSON(DEAL_KEY(deal.id), deal);
  await callExt(['ZADD', DEALS_INDEX, String(score), deal.id]);
  return deal;
}

export async function getDeal(id) {
  if (!id) return null;
  return getJSON(DEAL_KEY(id));
}

export async function listDeals({ status, stage, limit = 200, offset = 0 } = {}) {
  const ids = await callExt(['ZREVRANGE', DEALS_INDEX, String(offset), String(offset + limit - 1)]);
  if (!ids || !ids.length) return [];
  const out = [];
  for (const id of ids) {
    const d = await getDeal(id);
    if (!d) continue;
    if (stage && d.stage !== stage) continue;
    if (status && d.status !== status) continue;
    out.push(d);
  }
  return out;
}

export async function dealsCount() {
  const total = await callExt(['ZCARD', DEALS_INDEX]);
  const all = await listDeals({ limit: 500 });
  const by_stage = {};
  for (const d of all) {
    const s = d.stage || 'unknown';
    by_stage[s] = (by_stage[s] || 0) + 1;
  }
  return { total: total || 0, by_stage };
}

export async function deleteDeal(id) {
  if (!id) return;
  try { await callExt(['ZREM', DEALS_INDEX, id]); } catch {}
  try { await callExt(['DEL', DEAL_KEY(id)]); } catch {}
}

export async function listDealIdsByDemoFlag() {
  const ids = await callExt(['ZRANGE', DEALS_INDEX, '0', '-1']);
  const demoIds = [];
  for (const id of (ids || [])) {
    const d = await getDeal(id);
    if (d && d.demo === true) demoIds.push(id);
  }
  return demoIds;
}

// ── Letters index (global) ────────────────────────────────────────────────────
// letter:{id} → JSON letter record (broadcast metadata)
// letters:index → ZADD score=sent_at_ms member=id

const LETTER_KEY    = (id) => `letter:${id}`;
const LETTERS_INDEX = 'letters:index';

export async function saveLetterRecord(letter) {
  if (!letter || !letter.id) throw new Error('saveLetterRecord: letter.id required');
  const score = letter.sent_at_ms || (letter.sent_at ? new Date(letter.sent_at).getTime() : Date.now());
  await setJSON(LETTER_KEY(letter.id), letter);
  await callExt(['ZADD', LETTERS_INDEX, String(score), letter.id]);
  return letter;
}

export async function deleteLetterRecord(id) {
  if (!id) return;
  try { await callExt(['ZREM', LETTERS_INDEX, id]); } catch {}
  try { await callExt(['DEL', LETTER_KEY(id)]); } catch {}
}

export async function listLetterIds() {
  const ids = await callExt(['ZRANGE', LETTERS_INDEX, '0', '-1']);
  return ids || [];
}
