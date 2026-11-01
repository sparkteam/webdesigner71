/**
 * WebDesigner71 admin API (Cloudflare Worker)
 * Google sign-in  ->  email approval by ADMIN_EMAIL  ->  session token.
 *
 * Bindings (see wrangler.jsonc):
 *   KV:      USERS
 *   vars:    ADMIN_EMAIL, GOOGLE_CLIENT_ID, EMAIL_FROM, ALLOWED_ORIGINS
 *   secrets: SESSION_SECRET, APPROVAL_SECRET, RESEND_API_KEY (optional: logs instead of sending)
 */

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
      const res = json({ error: err instanceof HttpError ? err.message : "server_error" }, status);
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
