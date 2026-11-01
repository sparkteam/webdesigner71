/**
 * WebDesigner71 admin API (Cloudflare Worker)
 * Google sign-in  ->  email approval by ADMIN_EMAIL  ->  session token.
 *
 * Bindings (see wrangler.jsonc):
 *   KV:      USERS, CONTENT (homepage CMS: sections + settings; Phase 3 pages), MEDIA (uploaded images; KV until R2 is enabled)
 *   vars:    ADMIN_EMAIL, GOOGLE_CLIENT_ID, EMAIL_FROM, ALLOWED_ORIGINS
 *   secrets: SESSION_SECRET, APPROVAL_SECRET, RESEND_API_KEY (optional: logs instead of sending)
 */

import * as CMS from "./cms-model.js";
import * as PG from "./cms-pages.js";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const SESSION_TTL = 12 * 60 * 60; // 12h
const APPROVAL_TTL = 7 * 24 * 60 * 60; // 7 days
const RENOTIFY_AFTER = 60 * 60; // 1h
const CLOCK_SKEW = 60;
const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    try {
      const res = await route(request, env, ctx, url);
      if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(JSON.stringify({ msg: "unhandled", error: String(err && err.stack || err) }));
      const res = json({ error: err instanceof HttpError ? err.message : "server_error", ...(err && err.field ? { field: err.field } : {}), ...(err && err.reason ? { reason: err.reason } : {}) }, status);
      if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (p === "/" && m === "GET") return json({ ok: true, service: "wd71-admin-api" });
  if (p === "/auth/google" && m === "POST") return authGoogle(request, env, url);
  if ((p === "/approve" || p === "/reject") && (m === "GET" || m === "POST")) {
    return approvalLink(request, env, url, p.slice(1));
  }
  if (p === "/me" && m === "GET") {
    const user = await requireSession(request, env);
    return json({ user: publicUser(user, env) });
  }
  if (p === "/admin/users" && m === "GET") {
    await requireSession(request, env);
    return json({ users: (await listUsers(env)).map((u) => publicUser(u, env)) });
  }
  const am = p.match(/^\/admin\/users\/([^/]+)\/(approve|reject|delete)$/);
  if (am && m === "POST") {
    const me = await requireSession(request, env);
    if (!isAdmin(me.email, env)) throw new HttpError(403, "admin_only");
    const email = normEmail(decodeURIComponent(am[1]));
    if (isAdmin(email, env)) throw new HttpError(400, "cannot_modify_admin");
    const user = await getUser(env, email);
    if (!user) throw new HttpError(404, "not_found");
    if (am[2] === "delete") {
      await env.USERS.delete(userKey(email));
      log("user_deleted", { email, by: me.email });
      return json({ ok: true, deleted: email });
    }
    user.status = am[2] === "approve" ? "approved" : "rejected";
    user.decidedAt = new Date().toISOString();
    user.decidedBy = me.email;
    await putUser(env, user);
    log("user_" + user.status, { email, by: me.email, via: "panel" });
    return json({ ok: true, user: publicUser(user, env) });
  }

  /* ---------- CMS (Phase 2) ---------- */
  if (p === "/content" && m === "GET") return getContentV1(request, env); // Phase 1 read, derived from v2
  if ((p === "/admin/content" && m === "PUT") || (p === "/admin/content/undo" && m === "POST")) {
    // Phase 1 writes are superseded by per-section endpoints (hero = sections/hero; accent colour = settings).
    return json({ error: "superseded", use: p.endsWith("/undo") ? "POST /admin/content/homepage/sections/hero/undo" : "PUT /admin/content/homepage/sections/hero" }, 410);
  }
  if (p === "/content/homepage" && m === "GET") return getHomepage(request, env);
  const sm = p.match(/^\/admin\/content\/homepage\/sections\/([a-z]+)(\/undo)?$/);
  if (sm && ((m === "PUT" && !sm[2]) || (m === "POST" && sm[2]))) {
    const me = await requireAdmin(request, env);
    return sm[2] ? undoSection(request, env, me, sm[1]) : putSection(request, env, me, sm[1]);
  }
  if (p === "/admin/settings" && m === "GET") {
    await requireSession(request, env);
    return json({ settings: (await loadHomepage(env)).settings });
  }
  if (p === "/admin/settings" && m === "PUT") return putSettings(request, env, await requireAdmin(request, env));
  if (p === "/admin/settings/undo" && m === "POST") return undoSettings(request, env, await requireAdmin(request, env));
  if (p === "/admin/media" && m === "GET") return listMedia(request, env);
  if (p === "/admin/media" && m === "POST") return uploadMedia(request, env, await requireAdmin(request, env));
  const mm = p.match(/^\/admin\/media\/([^/]+)$/);
  if (mm && (m === "DELETE" || m === "PUT")) {
    const me = await requireAdmin(request, env);
    let key;
    try { key = decodeURIComponent(mm[1]); } catch { throw new HttpError(404, "not_found"); }
    if (!CMS.MEDIA_KEY_RE.test(key)) throw new HttpError(404, "not_found");
    return m === "DELETE" ? deleteMedia(request, env, me, key, url) : updateMedia(request, env, me, key);
  }

  /* ---------- Pages (Phase 3, docs/cms-phase3.md) ---------- */
  if (p === "/admin/pages" && m === "GET") { await requireSession(request, env); return listPages(env); }
  if (p === "/admin/pages" && m === "POST") return createPage(request, env, await requireAdmin(request, env));
  const pm = p.match(/^\/admin\/pages\/([^/]+)(?:\/(publish|unpublish|duplicate|undo))?$/);
  if (pm) {
    if (!PG.PAGE_ID_RE.test(pm[1])) throw new HttpError(404, "not_found");
    const id = pm[1], act = pm[2];
    if (!act && m === "GET") { await requireSession(request, env); return json({ page: await loadPage(env, id) }); }
    if (!act && m === "PUT") return putPage(request, env, await requireAdmin(request, env), id);
    if (!act && m === "DELETE") return deletePage(request, env, await requireAdmin(request, env), id);
    if (act && m === "POST") {
      const me = await requireAdmin(request, env);
      if (act === "publish") return publishPage(request, env, me, id);
      if (act === "unpublish") return unpublishPage(request, env, me, id);
      if (act === "duplicate") return duplicatePage(request, env, me, id);
      return undoPage(request, env, me, id);
    }
    throw new HttpError(405, "method_not_allowed");
  }
  const ps = p.match(/^\/pages\/([^/]+)$/);
  if (ps && m === "GET") return publicPage(env, ps[1]);
  throw new HttpError(404, "not_found");
}

/* ---------------- Google sign-in ---------------- */

async function authGoogle(request, env, url) {
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, "invalid_json"); }
  const credential = body && typeof body.credential === "string" ? body.credential : "";
  if (!credential || credential.length > 8192) throw new HttpError(400, "missing_credential");

  const claims = await verifyGoogleIdToken(credential, env, url);
  const email = normEmail(claims.email);
  const now = new Date();
  let user = await getUser(env, email);

  if (!user) {
    user = {
      email,
      name: String(claims.name || "").slice(0, 200),
      picture: safeUrl(claims.picture),
      status: isAdmin(email, env) ? "approved" : "pending",
      createdAt: now.toISOString(),
    };
    if (user.status === "pending") {
      await notifyAdmin(env, url, user);
      user.lastNotifiedAt = now.toISOString();
    }
    await putUser(env, user);
    log("user_signup", { email, status: user.status });
  } else {
    // keep profile fresh
    user.name = String(claims.name || user.name || "").slice(0, 200);
    user.picture = safeUrl(claims.picture) || user.picture || "";
    if (isAdmin(email, env) && user.status !== "approved") user.status = "approved";
    if (user.status === "pending") {
      const last = Date.parse(user.lastNotifiedAt || 0) || 0;
      if (now.getTime() - last > RENOTIFY_AFTER * 1000) {
        await notifyAdmin(env, url, user);
        user.lastNotifiedAt = now.toISOString();
      }
    }
    await putUser(env, user);
  }

  if (user.status === "pending") return json({ status: "pending" });
  if (user.status === "rejected") return json({ status: "rejected" });

  user.lastLoginAt = now.toISOString();
  await putUser(env, user);
  const token = await signSession(env, email);
  log("login", { email });
  return json({ status: "approved", token, user: publicUser(user, env) });
}

let jwksCache = null; // { keys: Map(kid -> CryptoKey), exp: ms } — process-level cache of public keys only

async function getGoogleKey(kid, env, url) {
  // Test-only: local JWKS override. Honoured ONLY when TEST_MODE=1 AND the request is to localhost,
  // so it can never take effect on a deployed Worker (deployed hostnames are never localhost).
  if (testModeActive(env, url) && env.TEST_JWKS) {
    const jwks = JSON.parse(env.TEST_JWKS);
    const jwk = jwks.keys.find((k) => k.kid === kid);
    return jwk ? importRsa(jwk) : null;
  }
  if (!jwksCache || jwksCache.exp < Date.now() || !jwksCache.keys.has(kid)) {
    const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, "jwks_unavailable");
    const data = await res.json();
    const keys = new Map();
    for (const jwk of data.keys || []) {
      if (jwk.kty === "RSA" && jwk.kid) keys.set(jwk.kid, await importRsa(jwk));
    }
    const maxAge = Number((res.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
    jwksCache = { keys, exp: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  }
  return jwksCache.keys.get(kid) || null;
}

function importRsa(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyGoogleIdToken(token, env, url) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "invalid_token");
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch { throw new HttpError(401, "invalid_token"); }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "invalid_token_alg");
  const key = await getGoogleKey(header.kid, env, url);
  if (!key) throw new HttpError(401, "unknown_key");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]),
  );
  if (!ok) throw new HttpError(401, "bad_signature");
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new HttpError(401, "bad_issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!env.GOOGLE_CLIENT_ID || !aud.includes(env.GOOGLE_CLIENT_ID)) throw new HttpError(401, "bad_audience");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW < now) throw new HttpError(401, "token_expired");
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW > now) throw new HttpError(401, "token_from_future");
  if (!payload.email || payload.email_verified !== true && payload.email_verified !== "true") {
    throw new HttpError(401, "email_not_verified");
  }
  return payload;
}

function testModeActive(env, url) {
  const host = url.hostname;
  return env.TEST_MODE === "1" && (host === "localhost" || host === "127.0.0.1");
}

/* ---------------- Session tokens (HS256 JWT) ---------------- */

async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new HttpError(500, "secret_not_configured");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(env, email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64urlEncode(enc.encode(JSON.stringify({ sub: email, iat: now, exp: now + SESSION_TTL, typ: "wd71-session" })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), enc.encode(h + "." + p));
  return h + "." + p + "." + b64urlEncode(new Uint8Array(sig));
}

async function verifySession(env, token) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  let sig;
  try { sig = b64urlDecode(parts[2]); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), sig, enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  try {
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    if (header.alg !== "HS256" || payload.typ !== "wd71-session") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function requireSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verifySession(env, token);
  if (!payload) throw new HttpError(401, "unauthorized");
  const user = await getUser(env, payload.sub);
  // Re-check status on every request so rejecting/deleting a user revokes access immediately.
  if (!user || user.status !== "approved") throw new HttpError(401, "not_approved");
  return user;
}

/* ---------------- Approval links ---------------- */

async function approvalSig(env, action, email, exp) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.APPROVAL_SECRET), enc.encode(`${action}|${email}|${exp}`));
  return b64urlEncode(new Uint8Array(sig));
}

async function approvalLinkUrl(env, origin, action, email) {
  const exp = Math.floor(Date.now() / 1000) + APPROVAL_TTL;
  const sig = await approvalSig(env, action, email, exp);
  return `${origin}/${action}?email=${encodeURIComponent(email)}&exp=${exp}&sig=${sig}`;
}

async function checkApprovalSig(env, action, email, exp, sig) {
  if (!email || !/^\d+$/.test(exp || "") || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  let given;
  try { given = b64urlDecode(sig); } catch { return false; }
  // crypto.subtle.verify does a constant-time comparison
  return crypto.subtle.verify("HMAC", await hmacKey(env.APPROVAL_SECRET), given, enc.encode(`${action}|${email}|${exp}`));
}

async function approvalLink(request, env, url, action) {
  let email, exp, sig;
  if (request.method === "POST") {
    const form = await request.formData();
    email = normEmail(String(form.get("email") || ""));
    exp = String(form.get("exp") || "");
    sig = String(form.get("sig") || "");
  } else {
    email = normEmail(url.searchParams.get("email") || "");
    exp = url.searchParams.get("exp") || "";
    sig = url.searchParams.get("sig") || "";
  }
  const valid = await checkApprovalSig(env, action, email, exp, sig);
  const bn = action === "approve" ? "অনুমোদন" : "প্রত্যাখ্যান";
  if (!valid) {
    return page("লিংকটি অকার্যকর", `<p>এই লিংকটি অকার্যকর বা মেয়াদোত্তীর্ণ (৭ দিন)।</p><p class="en">This link is invalid or has expired.</p>`, 400);
  }
  const user = await getUser(env, email);
  if (!user) return page("ইউজার পাওয়া যায়নি", `<p>${esc(email)} — এই ইউজার আর নেই।</p><p class="en">User not found.</p>`, 404);

  if (request.method === "GET") {
    // Never change state on GET: email link scanners pre-fetch links.
    const color = action === "approve" ? "#0B3D2E" : "#a11d1d";
    return page(`ইউজার ${bn} করবেন?`, `
      ${user.picture ? `<img class="av" src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
      <p><b>${esc(user.name || "—")}</b><br>${esc(user.email)}</p>
      <p>বর্তমান অবস্থা: <b>${statusBn(user.status)}</b></p>
      <form method="POST" action="/${action}">
        <input type="hidden" name="email" value="${esc(email)}">
        <input type="hidden" name="exp" value="${esc(exp)}">
        <input type="hidden" name="sig" value="${esc(sig)}">
        <button style="background:${color}">হ্যাঁ, ${bn} করুন</button>
      </form>
      <p class="en">Confirm to ${action} this user.</p>`);
  }

  user.status = action === "approve" ? "approved" : "rejected";
  user.decidedAt = new Date().toISOString();
  user.decidedBy = "email-link";
  await putUser(env, user);
  log("user_" + user.status, { email, via: "email" });
  return page(`${bn} সম্পন্ন ✓`, `<p><b>${esc(user.email)}</b> ${action === "approve" ? "এখন অ্যাডমিন প্যানেলে লগইন করতে পারবেন।" : "লগইন করতে পারবেন না।"}</p><p class="en">User ${user.status}.</p>`);
}

/* ---------------- CMS (Phase 2): homepage sections, settings, media ---------------- */
// Model, validation and defaults live in ./cms-model.js — a byte-identical copy of public/cms/model.js,
// which the site Worker renders with and the admin panel previews with.

function contentKV(env) {
  if (!env.CONTENT) throw new HttpError(500, "content_not_configured");
  return env.CONTENT;
}
function fieldError(field, reason) {
  const e = new HttpError(400, "invalid_field");
  e.field = field;
  if (reason) e.reason = reason;
  return e;
}
async function readJsonBody(request, limit = 16384) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new HttpError(413, "too_large");
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "too_large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "invalid_json"); }
}
async function hasSession(request, env) {
  if (!(request.headers.get("authorization") || "").startsWith("Bearer ")) return false;
  try { await requireSession(request, env); return true; } catch { return false; }
}
async function requireAdmin(request, env) {
  const me = await requireSession(request, env);
  if (!isAdmin(me.email, env)) throw new HttpError(403, "admin_only");
  return me;
}

/** Current homepage doc + settings: v2 key, else migrated Phase 1 key, else defaults (version 0). */
async function loadHomepage(env) {
  const kv = contentKV(env);
  const [rawDoc, rawSettings] = await Promise.all([kv.get(CMS.KEYS.doc, "json"), kv.get(CMS.KEYS.settings, "json")]);
  let doc, settings = null, source = "v2";
  if (rawDoc) doc = CMS.cleanDoc(rawDoc);
  else {
    const v1 = await kv.get(CMS.KEYS.v1, "json");
    if (v1) { ({ doc, settings } = CMS.migrateV1(v1)); source = "v1"; }
    else { doc = CMS.cleanDoc({ schema: CMS.SCHEMA, sections: [] }); source = "defaults"; }
  }
  const s = rawSettings ? { ...CMS.cleanSettings(rawSettings), version: rawSettings.version || 0, updatedAt: rawSettings.updatedAt || null, updatedBy: rawSettings.updatedBy || null }
    : { ...(settings || CMS.DEFAULT_SETTINGS), version: 0, updatedAt: null, updatedBy: null };
  return { doc, settings: s, source };
}
const stripMeta = (o, withMeta) => { if (withMeta) return o; const { updatedBy, ...rest } = o; return rest; };

async function getHomepage(request, env) {
  const { doc, settings, source } = await loadHomepage(env);
  const withMeta = await hasSession(request, env);
  return json({ schema: CMS.SCHEMA, source, sections: doc.sections.map((s) => stripMeta(s, withMeta)), settings: stripMeta(settings, withMeta) });
}

/** Phase 1 read endpoint, kept working: the hero title/sub + accent colour derived from the v2 model. */
async function getContentV1(request, env) {
  const kv = contentKV(env);
  const [d, s, v1] = await Promise.all([kv.get(CMS.KEYS.doc), kv.get(CMS.KEYS.settings), kv.get(CMS.KEYS.v1)]);
  if (!d && !s && !v1) return json({ content: null });
  const { doc, settings } = await loadHomepage(env);
  const hero = doc.sections.find((x) => x.id === "hero");
  const c = {
    heroTitle: hero.fields.title.text, heroHighlight: hero.fields.title.highlight, heroSub: hero.fields.sub.text,
    accentColor: settings.accentColor, version: hero.version, updatedAt: hero.updatedAt,
  };
  if (await hasSession(request, env)) c.updatedBy = hero.updatedBy;
  return json({ content: c });
}

async function writeDoc(env, doc) {
  const out = { schema: CMS.SCHEMA, sections: doc.sections, updatedAt: new Date().toISOString() };
  await contentKV(env).put(CMS.KEYS.doc, JSON.stringify(out));
}
const sectionPayload = (s) => ({ id: s.id, hidden: s.hidden, fields: s.fields, extra: s.extra });

async function putSection(request, env, me, id) {
  if (!CMS.sectionDef(id)) throw new HttpError(404, "unknown_section");
  const body = await readJsonBody(request, 65536);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json");
  if (!Number.isInteger(body.version) || body.version < 0) throw fieldError("version");
  let clean;
  try { clean = CMS.cleanSection(id, body); } catch (e) { if (e instanceof CMS.CmsError) throw fieldError(e.field); throw e; }
  const { doc } = await loadHomepage(env);
  const i = doc.sections.findIndex((s) => s.id === id);
  const cur = doc.sections[i];
  if (body.version !== cur.version) return json({ error: "version_conflict", section: cur }, 409);
  const next = { ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await contentKV(env).put(CMS.KEYS.prev(id), JSON.stringify(cur));
  doc.sections[i] = next;
  await writeDoc(env, doc);
  log("section_saved", { section: id, by: me.email, version: next.version });
  return json({ ok: true, section: next });
}

async function undoSection(request, env, me, id) {
  if (!CMS.sectionDef(id)) throw new HttpError(404, "unknown_section");
  const body = await readJsonBody(request);
  const kv = contentKV(env);
  const [{ doc }, prev] = await Promise.all([loadHomepage(env), kv.get(CMS.KEYS.prev(id), "json")]);
  if (!prev) throw new HttpError(404, "no_previous");
  const i = doc.sections.findIndex((s) => s.id === id);
  const cur = doc.sections[i];
  if (body.version !== undefined && body.version !== cur.version) return json({ error: "version_conflict", section: cur }, 409);
  let clean;
  try { clean = CMS.cleanSection(id, prev); } catch { throw new HttpError(409, "previous_invalid"); }
  // Swap: previous becomes live (with a new, higher version so open editors get a 409), live becomes previous.
  const next = { ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await kv.put(CMS.KEYS.prev(id), JSON.stringify(cur));
  doc.sections[i] = next;
  await writeDoc(env, doc);
  log("section_undo", { section: id, by: me.email, version: next.version });
  return json({ ok: true, section: next });
}

async function putSettings(request, env, me) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json");
  if (!Number.isInteger(body.version) || body.version < 0) throw fieldError("version");
  let clean;
  try { clean = CMS.cleanSettings(body); } catch (e) { if (e instanceof CMS.CmsError) throw fieldError(e.field); throw e; }
  const { settings: cur } = await loadHomepage(env);
  if (body.version !== cur.version) return json({ error: "version_conflict", settings: cur }, 409);
  const next = { ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  const kv = contentKV(env);
  await kv.put(CMS.KEYS.settingsPrev, JSON.stringify(cur));
  await kv.put(CMS.KEYS.settings, JSON.stringify(next));
  log("settings_saved", { by: me.email, version: next.version });
  return json({ ok: true, settings: next });
}
async function undoSettings(request, env, me) {
  const body = await readJsonBody(request);
  const kv = contentKV(env);
  const [{ settings: cur }, prev] = await Promise.all([loadHomepage(env), kv.get(CMS.KEYS.settingsPrev, "json")]);
  if (!prev) throw new HttpError(404, "no_previous");
  if (body.version !== undefined && body.version !== cur.version) return json({ error: "version_conflict", settings: cur }, 409);
  let clean;
  try { clean = CMS.cleanSettings(prev); } catch { throw new HttpError(409, "previous_invalid"); }
  const next = { ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await kv.put(CMS.KEYS.settingsPrev, JSON.stringify(cur));
  await kv.put(CMS.KEYS.settings, JSON.stringify(next));
  log("settings_undo", { by: me.email, version: next.version });
  return json({ ok: true, settings: next });
}

/* ----- media: MEDIA binding = Workers KV today (R2 not enabled); an R2 bucket binding also works ----- */
function mediaStore(env) {
  const b = env.MEDIA;
  if (!b) throw new HttpError(503, "media_not_configured");
  const r2 = typeof b.head === "function";
  return {
    kind: r2 ? "r2" : "kv",
    async list() {
      const out = [];
      let cursor;
      do {
        if (r2) {
          const res = await b.list({ cursor, include: ["customMetadata", "httpMetadata"], limit: 1000 });
          for (const o of res.objects) out.push({ key: o.key, meta: { ...(o.customMetadata || {}), contentType: o.httpMetadata && o.httpMetadata.contentType, size: o.size } });
          cursor = res.truncated ? res.cursor : null;
        } else {
          const res = await b.list({ cursor, limit: 1000 });
          for (const k of res.keys) out.push({ key: k.name, meta: k.metadata || {} });
          cursor = res.list_complete ? null : res.cursor;
        }
      } while (cursor);
      return out;
    },
    async get(key) {
      if (r2) { const o = await b.get(key); return o ? { bytes: await o.arrayBuffer(), meta: { ...(o.customMetadata || {}), contentType: o.httpMetadata.contentType, size: o.size } } : null; }
      const { value, metadata } = await b.getWithMetadata(key, { type: "arrayBuffer" });
      return value ? { bytes: value, meta: metadata || {} } : null;
    },
    async put(key, bytes, meta) {
      if (r2) { const { contentType, ...custom } = meta; await b.put(key, bytes, { httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, String(v)])) }); }
      else await b.put(key, bytes, { metadata: meta });
    },
    delete: (key) => b.delete(key),
  };
}
function sniffImage(u8) {
  const at = (i, ...b) => b.every((x, j) => u8[i + j] === x);
  if (u8.length > 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (u8.length > 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (u8.length > 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (u8.length > 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}
const cut = (s, n) => [...String(s || "")].slice(0, n).join("").replace(/[\u0000-\u001f\u007f]/g, "").trim();
/** Where a /media/<key> URL is used in the homepage doc (field paths), so delete can warn. */
function mediaUsage(doc, url) {
  const used = [];
  const walk = (v, path) => {
    if (typeof v === "string") { if (v === url) used.push(path); return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + "." + (x && x.id ? x.id : i)));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? path + "." + k : k);
  };
  for (const s of doc.sections) { walk(s.fields, s.id); walk(s.extra, s.id + ".extra"); }
  return used;
}
function publicMedia(key, meta, doc) {
  const url = "/media/" + key;
  return { key, url, contentType: meta.contentType || "", size: Number(meta.size) || 0, alt: meta.alt || "", name: meta.name || "", uploadedAt: meta.uploadedAt || null, uploadedBy: meta.uploadedBy || null, usedIn: mediaUsage(doc, url) };
}
async function listMedia(request, env) {
  await requireSession(request, env);
  const store = mediaStore(env);
  const [{ doc }, items] = await Promise.all([loadHomepage(env), store.list()]);
  const media = items.map((i) => publicMedia(i.key, i.meta, doc)).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return json({ storage: store.kind, maxBytes: CMS.MEDIA_MAX_BYTES, types: Object.keys(CMS.MEDIA_TYPES), items: media, builtin: CMS.BUILTIN_MEDIA });
}
async function uploadMedia(request, env, me) {
  const store = mediaStore(env);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > CMS.MEDIA_MAX_BYTES + 64 * 1024) throw new HttpError(413, "too_large");
  if (!(request.headers.get("content-type") || "").startsWith("multipart/form-data")) throw new HttpError(415, "multipart_required");
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, "invalid_form"); }
  const file = form.get("file");
  if (!file || typeof file === "string") throw fieldError("file");
  if (file.size > CMS.MEDIA_MAX_BYTES) throw new HttpError(413, "too_large");
  if (file.size === 0) throw fieldError("file");
  const bytes = await file.arrayBuffer();
  const type = sniffImage(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)));
  if (!type) throw new HttpError(415, "unsupported_type");
  const alt = form.get("alt");
  if (alt !== null && (typeof alt !== "string" || [...alt].length > 150)) throw fieldError("alt");
  const now = new Date();
  const rand = b64urlEncode(crypto.getRandomValues(new Uint8Array(9))).replace(/[^A-Za-z0-9]/g, "x");
  const key = now.toISOString().slice(0, 7) + "-" + rand + "." + CMS.MEDIA_TYPES[type];
  const meta = { contentType: type, size: bytes.byteLength, alt: cut(alt, 150), name: cut(file.name, 60), uploadedAt: now.toISOString(), uploadedBy: me.email };
  await store.put(key, bytes, meta);
  log("media_uploaded", { key, type, size: bytes.byteLength, by: me.email });
  return json({ ok: true, item: publicMedia(key, meta, { sections: [] }) }, 201);
}
async function updateMedia(request, env, me, key) {
  const body = await readJsonBody(request);
  if (typeof body.alt !== "string" || [...body.alt].length > 150 || /[\u0000-\u001f\u007f]/.test(body.alt)) throw fieldError("alt");
  const store = mediaStore(env);
  const cur = await store.get(key);
  if (!cur) throw new HttpError(404, "not_found");
  const meta = { ...cur.meta, alt: cut(body.alt, 150) };
  await store.put(key, cur.bytes, meta);
  const { doc } = await loadHomepage(env);
  return json({ ok: true, item: publicMedia(key, meta, doc) });
}
async function deleteMedia(request, env, me, key, url) {
  const store = mediaStore(env);
  const cur = await store.get(key);
  if (!cur) throw new HttpError(404, "not_found");
  const { doc } = await loadHomepage(env);
  const usedIn = mediaUsage(doc, "/media/" + key);
  if (usedIn.length && url.searchParams.get("force") !== "1") return json({ error: "in_use", usedIn }, 409);
  await store.delete(key);
  log("media_deleted", { key, by: me.email, forced: usedIn.length > 0 });
  return json({ ok: true, deleted: key });
}

/* ---------------- Email (Resend) ---------------- */

async function notifyAdmin(env, url, user) {
  const origin = url.origin;
  const approveUrl = await approvalLinkUrl(env, origin, "approve", user.email);
  const rejectUrl = await approvalLinkUrl(env, origin, "reject", user.email);
  const subject = `নতুন অ্যাডমিন অনুরোধ / New admin sign-up: ${user.email}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1e8;font-family:'Hind Siliguri',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0B3D2E;color:#fff;padding:18px 24px;font-size:20px;font-weight:700">WebDesigner<span style="color:#D4A017">71</span> অ্যাডমিন</td></tr>
<tr><td style="padding:24px;color:#1d2b26;font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">একজন নতুন ইউজার অ্যাডমিন প্যানেলে সাইন আপ করেছেন।<br><span style="color:#667">A new user signed up for the admin panel.</span></p>
<table cellpadding="0" cellspacing="0" style="margin:16px 0"><tr>
${user.picture ? `<td style="padding-right:12px"><img src="${esc(user.picture)}" width="56" height="56" style="border-radius:50%" alt=""></td>` : ""}
<td><b>${esc(user.name || "—")}</b><br><span style="color:#445">${esc(user.email)}</span></td></tr></table>
<p style="margin:20px 0">
<a href="${esc(approveUrl)}" style="display:inline-block;background:#0B3D2E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;margin-right:8px">✓ অনুমোদন / Approve</a>
<a href="${esc(rejectUrl)}" style="display:inline-block;background:#fff;color:#a11d1d;border:2px solid #a11d1d;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:700">✕ প্রত্যাখ্যান / Reject</a>
</p>
<p style="font-size:13px;color:#778;margin:0">লিংক ৭ দিন কার্যকর থাকবে। লিংকে ক্লিক করার পর একটি নিশ্চিতকরণ বাটন চাপতে হবে।<br>Links expire in 7 days. You'll be asked to confirm on the next page.</p>
</td></tr></table></td></tr></table></body></html>`;

  if (!env.RESEND_API_KEY) {
    console.log(JSON.stringify({ msg: "email_not_sent_no_api_key", to: env.ADMIN_EMAIL, subject, approveUrl, rejectUrl }));
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "WebDesigner71 Admin <onboarding@resend.dev>",
      to: [env.ADMIN_EMAIL],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error(JSON.stringify({ msg: "resend_failed", status: res.status, body: (await res.text()).slice(0, 500) }));
  } else {
    log("approval_email_sent", { to: env.ADMIN_EMAIL, user: user.email });
  }
}

/* ---------------- KV helpers ---------------- */

const userKey = (email) => "user:" + email;
const normEmail = (e) => String(e || "").trim().toLowerCase();
const isAdmin = (email, env) => normEmail(email) === normEmail(env.ADMIN_EMAIL);

async function getUser(env, email) {
  return env.USERS.get(userKey(normEmail(email)), "json");
}
async function putUser(env, user) {
  await env.USERS.put(userKey(user.email), JSON.stringify(user), { metadata: { status: user.status } });
}
async function listUsers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.USERS.list({ prefix: "user:", cursor });
    const batch = await Promise.all(page.keys.map((k) => env.USERS.get(k.name, "json")));
    out.push(...batch.filter(Boolean));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function publicUser(u, env) {
  return {
    email: u.email, name: u.name || "", picture: u.picture || "", status: u.status,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, decidedAt: u.decidedAt || null,
    isAdmin: isAdmin(u.email, env),
  };
}

/* ---------------- HTTP helpers ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
  if (!ok) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — WebDesigner71</title>
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1e8;font-family:'Hind Siliguri',sans-serif;color:#1d2b26}
.c{background:#fff;max-width:420px;width:calc(100% - 32px);border-radius:16px;box-shadow:0 10px 40px rgba(11,61,46,.12);overflow:hidden;text-align:center}
.h{background:#0B3D2E;color:#fff;padding:16px;font-weight:700;font-size:18px}.h span{color:#D4A017}
.b{padding:24px}h1{font-size:22px;margin:0 0 12px;color:#0B3D2E}.en{color:#889;font-size:13px}
.av{width:72px;height:72px;border-radius:50%;border:3px solid #D4A017}
button{border:0;color:#fff;font:700 16px 'Hind Siliguri',sans-serif;padding:12px 26px;border-radius:10px;cursor:pointer}</style></head>
<body><div class="c"><div class="h">WebDesigner<span>71</span> অ্যাডমিন</div><div class="b"><h1>${esc(title)}</h1>${body}</div></div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https:; form-action 'self'; frame-ancestors 'none'",
      "x-robots-tag": "noindex",
    },
  });
}

const statusBn = (s) => ({ pending: "অপেক্ষমাণ", approved: "অনুমোদিত", rejected: "প্রত্যাখ্যাত" })[s] || s;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u.slice(0, 1000) : "");
const log = (msg, data) => console.log(JSON.stringify({ msg, ...data }));

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* ---------------- Pages (Phase 3) ----------------
 * KV (CONTENT):  page:<id>        full doc (draft + publish metadata)        page:<id>:prev  previous editable state (undo)
 *                pages:index      { pages: [indexEntry…] } for the list screen + sitemap
 *                pub:<slug>       published snapshot the site renders        redirect:<slug> { to, page } (301 after a slug move)
 * Writes are not transactional (KV has none): order is chosen so a failure leaves the site serving the old state. */
const PAGE_BODY_LIMIT = PG.LIMITS.bytes + 32 * 1024;
const pageEditable = (d) => ({ title: d.title, slug: d.slug, seo: d.seo, blocks: d.blocks, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy });
const PAGE_INPUT_KEYS = new Set(["title", "slug", "seo", "blocks"]);
function pageInput(body) {
  for (const k of Object.keys(body)) if (!PAGE_INPUT_KEYS.has(k)) throw fieldError(k, "unknown");
  try { return PG.cleanPageInput(body); }
  catch (e) { if (e instanceof PG.PageError) throw fieldError(e.field, e.reason); throw e; }
}
function requireBodyObject(body) { if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json"); return body; }
function requireVersion(body) { if (!Number.isInteger(body.version) || body.version < 0) throw fieldError("version", "required"); }
async function readIndex(env) {
  const raw = await contentKV(env).get(PG.PKEYS.index, "json");
  return raw && Array.isArray(raw.pages) ? raw.pages.filter((x) => x && PG.PAGE_ID_RE.test(x.id)) : [];
}
async function writeIndex(env, pages) {
  pages.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!pages.length) await contentKV(env).delete(PG.PKEYS.index); // production ends with no pages → no index key either
  else await contentKV(env).put(PG.PKEYS.index, JSON.stringify({ pages, updatedAt: new Date().toISOString() }));
}
async function syncIndex(env, doc, removeId) {
  const pages = (await readIndex(env)).filter((x) => x.id !== (removeId || doc.id));
  if (doc) pages.push(PG.indexEntry(doc));
  await writeIndex(env, pages);
}
async function loadPage(env, id) {
  const d = await contentKV(env).get(PG.PKEYS.page(id), "json");
  if (!d || d.id !== id) throw new HttpError(404, "not_found");
  return d;
}
async function writePage(env, doc) { await contentKV(env).put(PG.PKEYS.page(doc.id), JSON.stringify(doc)); }
/** A slug is taken if another page uses it as its draft slug or its live URL. Old (redirect) slugs can be reused. */
function slugTaken(index, slug, selfId) { return index.some((x) => x.id !== selfId && (x.slug === slug || x.publishedSlug === slug)); }
function uniqueSlug(index, base) {
  for (let i = 1; i < 100; i++) {
    const tail = i === 1 ? "-copy" : "-copy-" + i;
    const s = base.slice(0, PG.SLUG_MAX - tail.length).replace(/-+$/, "") + tail;
    if (!slugTaken(index, s, null) && !PG.slugProblem(s)) return s;
  }
  throw new HttpError(409, "slug_exhausted");
}
function versionConflict(doc) { return json({ error: "version_conflict", page: doc }, 409); }

async function listPages(env) {
  return json({ pages: await readIndex(env), limits: PG.LIMITS, reserved: PG.RESERVED_SLUGS });
}
async function createPage(request, env, me) {
  const body = requireBodyObject(await readJsonBody(request, PAGE_BODY_LIMIT));
  let raw = body;
  if (body.template !== undefined) {
    if (typeof body.template !== "string" || !Object.prototype.hasOwnProperty.call(PG.TEMPLATES, body.template)) throw fieldError("template", "enum");
    raw = { ...body, blocks: body.blocks !== undefined ? body.blocks : PG.TEMPLATES[body.template].build(typeof body.title === "string" ? body.title.trim() : "") };
    delete raw.template;
  }
  const clean = pageInput(raw);
  const index = await readIndex(env);
  if (index.length >= PG.LIMITS.pages) throw new HttpError(409, "too_many_pages");
  if (slugTaken(index, clean.slug, null)) throw fieldError("slug", "taken");
  const now = new Date().toISOString();
  let id; do { id = PG.newPageId(); } while (index.some((x) => x.id === id));
  const doc = { schema: PG.PAGE_SCHEMA, id, ...clean, status: "draft", version: 1, createdAt: now, updatedAt: now, updatedBy: me.email,
    publishedAt: null, publishedVersion: 0, publishedSlug: "", redirects: [] };
  await writePage(env, doc);
  await syncIndex(env, doc);
  log("page_created", { page: id, slug: doc.slug, by: me.email });
  return json({ ok: true, page: doc }, 201);
}
async function putPage(request, env, me, id) {
  const body = requireBodyObject(await readJsonBody(request, PAGE_BODY_LIMIT));
  requireVersion(body);
  const { version, ...rest } = body;
  const clean = pageInput(rest);
  const cur = await loadPage(env, id);
  if (version !== cur.version) return versionConflict(cur);
  if (clean.slug !== cur.slug && slugTaken(await readIndex(env), clean.slug, id)) throw fieldError("slug", "taken");
  const next = { ...cur, ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await contentKV(env).put(PG.PKEYS.prev(id), JSON.stringify(pageEditable(cur)));
  await writePage(env, next);
  await syncIndex(env, next);
  log("page_saved", { page: id, by: me.email, version: next.version });
  return json({ ok: true, page: next });
}
async function undoPage(request, env, me, id) {
  const body = await readJsonBody(request);
  const kv = contentKV(env);
  const [cur, prev] = await Promise.all([loadPage(env, id), kv.get(PG.PKEYS.prev(id), "json")]);
  if (!prev) throw new HttpError(404, "no_previous");
  if (body.version !== undefined && body.version !== cur.version) return versionConflict(cur);
  let clean;
  try { clean = PG.cleanPageInput(prev); } catch { throw new HttpError(409, "previous_invalid"); }
  if (clean.slug !== cur.slug && slugTaken(await readIndex(env), clean.slug, id)) throw fieldError("slug", "taken");
  const next = { ...cur, ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await kv.put(PG.PKEYS.prev(id), JSON.stringify(pageEditable(cur)));
  await writePage(env, next);
  await syncIndex(env, next);
  log("page_undo", { page: id, by: me.email, version: next.version });
  return json({ ok: true, page: next });
}
async function ownedRedirect(env, slug, id) {
  const r = await contentKV(env).get(PG.PKEYS.redirect(slug), "json");
  return !!(r && r.page === id);
}
async function publishPage(request, env, me, id) {
  const body = requireBodyObject(await readJsonBody(request));
  requireVersion(body);
  const kv = contentKV(env);
  const cur = await loadPage(env, id);
  if (body.version !== cur.version) return versionConflict(cur);
  let clean;
  try { clean = PG.cleanPageInput(cur); } catch (e) { if (e instanceof PG.PageError) throw fieldError(e.field, e.reason); throw e; }
  const index = await readIndex(env);
  if (slugTaken(index, clean.slug, id)) throw fieldError("slug", "taken");
  const now = new Date().toISOString();
  const next = { ...cur, ...clean, status: "published", version: cur.version + 1, updatedAt: now, updatedBy: me.email, publishedAt: now, publishedSlug: clean.slug };
  next.publishedVersion = next.version;
  let redirects = (cur.redirects || []).filter((s) => s !== clean.slug);
  const old = cur.status === "published" && cur.publishedSlug && cur.publishedSlug !== clean.slug ? cur.publishedSlug : "";
  if (old) redirects = [old, ...redirects.filter((s) => s !== old)];
  const dropped = redirects.slice(PG.LIMITS.redirects);
  next.redirects = redirects.slice(0, PG.LIMITS.redirects);
  // 1) the new URL goes live, 2) old URLs 301 to it, 3) the old snapshot goes away, 4) doc + index
  await kv.put(PG.PKEYS.pub(clean.slug), JSON.stringify(PG.publishedSnapshot(next, now)));
  await kv.delete(PG.PKEYS.redirect(clean.slug));
  for (const s of next.redirects) await kv.put(PG.PKEYS.redirect(s), JSON.stringify({ to: clean.slug, page: id }));
  if (old) { const snap = await kv.get(PG.PKEYS.pub(old), "json"); if (snap && snap.id === id) await kv.delete(PG.PKEYS.pub(old)); }
  for (const s of dropped) if (await ownedRedirect(env, s, id)) await kv.delete(PG.PKEYS.redirect(s));
  await writePage(env, next);
  await syncIndex(env, next);
  log("page_published", { page: id, slug: clean.slug, by: me.email, version: next.version, movedFrom: old || undefined });
  return json({ ok: true, page: next });
}
async function takeDown(env, doc) {
  const kv = contentKV(env);
  if (doc.publishedSlug) { const snap = await kv.get(PG.PKEYS.pub(doc.publishedSlug), "json"); if (snap && snap.id === doc.id) await kv.delete(PG.PKEYS.pub(doc.publishedSlug)); }
  for (const s of doc.redirects || []) if (await ownedRedirect(env, s, doc.id)) await kv.delete(PG.PKEYS.redirect(s));
}
async function unpublishPage(request, env, me, id) {
  const body = requireBodyObject(await readJsonBody(request));
  requireVersion(body);
  const cur = await loadPage(env, id);
  if (body.version !== cur.version) return versionConflict(cur);
  if (cur.status !== "published") throw new HttpError(409, "not_published");
  await takeDown(env, cur);
  const next = { ...cur, status: "draft", version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: me.email, publishedSlug: "", redirects: [] };
  await writePage(env, next);
  await syncIndex(env, next);
  log("page_unpublished", { page: id, by: me.email, version: next.version });
  return json({ ok: true, page: next });
}
async function deletePage(request, env, me, id) {
  const cur = await loadPage(env, id);
  const v = new URL(request.url).searchParams.get("version");
  if (v !== null && Number(v) !== cur.version) return versionConflict(cur);
  await takeDown(env, cur);
  await syncIndex(env, null, id);
  const kv = contentKV(env);
  await kv.delete(PG.PKEYS.prev(id));
  await kv.delete(PG.PKEYS.page(id));
  log("page_deleted", { page: id, slug: cur.slug, by: me.email });
  return json({ ok: true, deleted: id });
}
async function duplicatePage(request, env, me, id) {
  const cur = await loadPage(env, id);
  const index = await readIndex(env);
  if (index.length >= PG.LIMITS.pages) throw new HttpError(409, "too_many_pages");
  const title = [...(cur.title + " (কপি)")].slice(0, 120).join("");
  const clean = pageInput({ title, slug: uniqueSlug(index, cur.slug), seo: { ...cur.seo, noindex: cur.seo ? cur.seo.noindex : false }, blocks: cur.blocks.map(PG.cloneBlock) });
  const now = new Date().toISOString();
  let nid; do { nid = PG.newPageId(); } while (index.some((x) => x.id === nid));
  const doc = { schema: PG.PAGE_SCHEMA, id: nid, ...clean, status: "draft", version: 1, createdAt: now, updatedAt: now, updatedBy: me.email,
    publishedAt: null, publishedVersion: 0, publishedSlug: "", redirects: [] };
  await writePage(env, doc);
  await syncIndex(env, doc);
  log("page_duplicated", { page: nid, from: id, by: me.email });
  return json({ ok: true, page: doc }, 201);
}
/** Public read of a published page (JSON; drafts and unknown slugs are 404). */
async function publicPage(env, slug) {
  if (PG.slugProblem(slug)) throw new HttpError(404, "not_found");
  const snap = await contentKV(env).get(PG.PKEYS.pub(slug), "json");
  if (!snap) throw new HttpError(404, "not_found");
  let clean;
  try { clean = { title: snap.title, slug: PG.cleanSlug(snap.slug), seo: PG.cleanSeo(snap.seo), blocks: PG.cleanBlocks(snap.blocks) }; } catch { throw new HttpError(404, "not_found"); }
  return json({ page: { ...clean, publishedAt: snap.publishedAt || null, version: snap.version } });
}
