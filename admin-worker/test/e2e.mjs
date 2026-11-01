// End-to-end test: runs `wrangler dev --local` with a test-only JWKS (TEST_MODE, localhost only),
// signs fake Google ID tokens with a locally generated RSA key, and exercises the full flow.
import { spawn } from "node:child_process";
import { generateKeyPairSync, createSign, randomBytes, createHmac } from "node:crypto";
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const ADMIN = "sohelhoo@gmail.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: evilKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
const SESSION_SECRET = randomBytes(32).toString("hex");

writeFileSync(".dev.vars", [
  `TEST_MODE=1`,
  `TEST_JWKS=${JSON.stringify({ keys: [jwk] })}`,
  `GOOGLE_CLIENT_ID=${CLIENT_ID}`,
  `SESSION_SECRET=${SESSION_SECRET}`,
  `APPROVAL_SECRET=${randomBytes(32).toString("hex")}`,
].join("\n"));

const b64u = (b) => Buffer.from(b).toString("base64url");
function googleToken(claims, { key = privateKey, kid = "test-kid" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, iat: now, exp: now + 3600, email_verified: true, ...claims }));
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${b64u(s)}`;
}

// Test config = wrangler.jsonc minus the custom-domain route: with a route, `wrangler dev` rewrites
// request.url to the route host (api.webdesigner71.com), so the localhost-only TEST_MODE would never apply.
const TEST_CONFIG = ".wrangler.e2e.json";
const cfg = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
delete cfg.routes; delete cfg.$schema;
writeFileSync(TEST_CONFIG, JSON.stringify(cfg, null, 2));

const persist = mkdtempSync(join(tmpdir(), "wd71kv-"));
let logs = "";
const dev = spawn("npx", ["wrangler", "dev", "--config", TEST_CONFIG, "--local", "--port", String(PORT), "--persist-to", persist, "--ip", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
dev.stdout.on("data", (d) => (logs += d));
dev.stderr.on("data", (d) => (logs += d));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };
const ORIGIN = "https://webdesigner71.com";
const api = (path, { method = "GET", body, token, origin = ORIGIN, form } = {}) =>
  fetch(BASE + path, {
    method, redirect: "manual",
    headers: { ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined,
  });
const login = (claims, opt) => api("/auth/google", { method: "POST", body: { credential: googleToken(claims, opt) } });

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

  // --- token verification
  let r = await login({ email: "x@gmail.com" }, { key: evilKey });
  check("forged signature rejected (401)", r.status === 401, r.status);
  r = await login({ email: "x@gmail.com", aud: "other.apps.googleusercontent.com" });
  { const jj = await r.json(); check("wrong aud rejected", r.status === 401 && jj.error === "bad_audience", JSON.stringify(jj)); }
  r = await login({ email: "x@gmail.com", iss: "evil.com" });
  check("wrong iss rejected", r.status === 401 && (await r.json()).error === "bad_issuer");
  r = await login({ email: "x@gmail.com", exp: Math.floor(Date.now() / 1000) - 3600 });
  check("expired token rejected", r.status === 401 && (await r.json()).error === "token_expired");
  r = await login({ email: "x@gmail.com", email_verified: false });
  check("unverified email rejected", r.status === 401 && (await r.json()).error === "email_not_verified");
  r = await login({ email: "x@gmail.com" }, { kid: "unknown" });
  check("unknown kid rejected", r.status === 401);

  // --- CORS
  r = await api("/auth/google", { method: "OPTIONS", origin: "https://www.webdesigner71.com" });
  check("CORS preflight allowed for www", r.status === 204 && r.headers.get("access-control-allow-origin") === "https://www.webdesigner71.com");
  r = await api("/auth/google", { method: "OPTIONS", origin: "https://evil.example" });
  check("CORS preflight refused for evil origin", r.status === 403 && !r.headers.get("access-control-allow-origin"));
  r = await api("/", { origin: "http://localhost:5500" });
  check("CORS allows http://localhost:*", r.headers.get("access-control-allow-origin") === "http://localhost:5500");

  // --- admin auto-approved
  r = await login({ email: ADMIN, name: "Admin" });
  let j = await r.json();
  check("ADMIN_EMAIL auto-approved + token", j.status === "approved" && !!j.token && j.user.isAdmin);
  const adminToken = j.token;

  // --- new user -> pending + email logged
  logs = "";
  r = await login({ email: "Rahim@Gmail.com", name: "রহিম <b>", picture: "https://lh3.googleusercontent.com/a/x" });
  j = await r.json();
  check("new user -> pending", j.status === "pending" && !j.token);
  await new Promise((x) => setTimeout(x, 800));
  const m = logs.match(/"approveUrl":"([^"]+)","rejectUrl":"([^"]+)"/);
  check("approval email logged (no RESEND_API_KEY)", !!m, logs.slice(-500));
  const approveUrl = m && m[1], rejectUrl = m && m[2];

  logs = "";
  r = await login({ email: "rahim@gmail.com", name: "রহিম <b>" });
  check("pending again -> pending", (await r.json()).status === "pending");
  await new Promise((x) => setTimeout(x, 500));
  check("no re-send within 1 hour", !/email_not_sent_no_api_key/.test(logs));

  // --- pending can't use API
  r = await api("/me", { token: "garbage" });
  check("/me with bad token -> 401", r.status === 401);

  // --- approval link: GET shows confirm page, does NOT approve
  const u = new URL(approveUrl);
  r = await fetch(BASE + u.pathname + u.search);
  const html = await r.text();
  check("GET /approve shows confirm form", r.status === 200 && html.includes('method="POST"') && html.includes("অনুমোদন"));
  check("HTML escaped in confirm page", html.includes("রহিম &lt;b&gt;") && !html.includes("রহিম <b>"));
  r = await login({ email: "rahim@gmail.com" });
  check("still pending after GET (scanner-safe)", (await r.json()).status === "pending");

  // tampered sig
  const params = Object.fromEntries(u.searchParams);
  r = await api("/approve", { method: "POST", origin: null, form: { ...params, email: "other@gmail.com" } });
  check("tampered approve link -> 400", r.status === 400);
  // approve-sig used on reject endpoint
  r = await api("/reject", { method: "POST", origin: null, form: params });
  check("approve sig not valid for /reject", r.status === 400);
  // expired
  r = await api("/approve", { method: "POST", origin: null, form: { ...params, exp: "1000" } });
  check("expired link -> 400", r.status === 400);

  r = await api("/approve", { method: "POST", origin: null, form: params });
  check("POST /approve -> 200", r.status === 200 && (await r.text()).includes("সম্পন্ন"));

  r = await login({ email: "rahim@gmail.com", name: "রহিম" });
  j = await r.json();
  check("approved user gets session token", j.status === "approved" && !!j.token && !j.user.isAdmin);
  const userToken = j.token;

  // session token: format, exp ~12h
  const payload = JSON.parse(Buffer.from(userToken.split(".")[1], "base64url").toString());
  check("session token exp = 12h", payload.exp - payload.iat === 43200);
  const [h, p] = userToken.split(".");
  const tamperedP = b64u(JSON.stringify({ ...payload, sub: ADMIN }));
  r = await api("/me", { token: `${h}.${tamperedP}.${userToken.split(".")[2]}` });
  check("tampered session token -> 401", r.status === 401);
  const forged = `${h}.${tamperedP}.${createHmac("sha256", "wrong-secret-wrong-secret-wrong-secret").update(`${h}.${tamperedP}`).digest("base64url")}`;
  r = await api("/me", { token: forged });
  check("session signed with wrong secret -> 401", r.status === 401);

  r = await api("/me", { token: userToken });
  j = await r.json();
  check("/me returns user", r.status === 200 && j.user.email === "rahim@gmail.com");

  r = await api("/admin/users", { token: userToken });
  check("approved user can list users", r.status === 200 && (await r.json()).users.length === 2);

  // --- CMS Phase 1: homepage content
  const C0 = { heroTitle: "আপনার ব্যবসার ওয়েবসাইট, মাত্র", heroHighlight: "৩৯০০ টাকায়", heroSub: "ডোমেইন, হোস্টিং, ডিজাইন — সব এক প্যাকেজে", accentColor: "#D4A017" };
  r = await api("/content", { origin: null });
  j = await r.json();
  check("public GET /content (empty) -> {content:null}", r.status === 200 && j.content === null, JSON.stringify(j));
  r = await api("/admin/content", { method: "OPTIONS" });
  check("CORS preflight allows PUT", r.status === 204 && /\bPUT\b/.test(r.headers.get("access-control-allow-methods") || ""));
  r = await api("/admin/content", { method: "PUT", body: { ...C0, version: 0 } });
  check("PUT /admin/content without token -> 401", r.status === 401);
  r = await api("/admin/content", { method: "PUT", token: userToken, body: { ...C0, version: 0 } });
  check("non-admin PUT /admin/content -> 403", r.status === 403 && (await r.json()).error === "admin_only");
  r = await api("/admin/content/undo", { method: "POST", token: userToken, body: {} });
  check("non-admin undo -> 403", r.status === 403);
  r = await api("/admin/content/undo", { method: "POST", token: adminToken, body: {} });
  check("undo with no previous -> 404", r.status === 404);
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...C0, version: 0 } });
  j = await r.json();
  check("admin save -> 200 version 1", r.status === 200 && j.ok && j.content.version === 1 && j.content.heroTitle === C0.heroTitle && j.content.updatedBy === ADMIN, JSON.stringify(j));
  r = await api("/content", { origin: null });
  j = await r.json();
  check("public GET /content returns saved content (no updatedBy)", j.content && j.content.version === 1 && j.content.heroSub === C0.heroSub && !("updatedBy" in j.content), JSON.stringify(j));
  r = await api("/content", { token: adminToken });
  check("GET /content with session includes updatedBy", (await r.json()).content.updatedBy === ADMIN);
  r = await api("/content", { token: "garbage" });
  check("GET /content with bad token still 200 (public)", r.status === 200);
  for (const [name, body, field] of [
    ["bad color -> 400 accentColor", { ...C0, accentColor: "red", version: 1 }, "accentColor"],
    ["short hex -> 400", { ...C0, accentColor: "#FFF", version: 1 }, "accentColor"],
    ["empty title -> 400 heroTitle", { ...C0, heroTitle: "   ", version: 1 }, "heroTitle"],
    ["title > 120 chars -> 400", { ...C0, heroTitle: "ক".repeat(121), version: 1 }, "heroTitle"],
    ["highlight > 40 chars -> 400", { ...C0, heroHighlight: "x".repeat(41), version: 1 }, "heroHighlight"],
    ["sub > 300 chars -> 400", { ...C0, heroSub: "x".repeat(301), version: 1 }, "heroSub"],
    ["non-string field -> 400", { ...C0, heroSub: 5, version: 1 }, "heroSub"],
    ["control chars -> 400", { ...C0, heroTitle: "a\nb", version: 1 }, "heroTitle"],
    ["missing version -> 400", { ...C0 }, "version"],
  ]) {
    r = await api("/admin/content", { method: "PUT", token: adminToken, body });
    j = await r.json();
    check(name, r.status === 400 && j.error === "invalid_field" && j.field === field, r.status + " " + JSON.stringify(j));
  }
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...C0, heroTitle: "x".repeat(120), heroHighlight: "", heroSub: "", accentColor: "#0b7a55", version: 1 } });
  j = await r.json();
  check("boundary values accepted (120 chars, empty optional), color upper-cased", r.status === 200 && j.content.version === 2 && j.content.accentColor === "#0B7A55" && j.content.heroHighlight === "", JSON.stringify(j));
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...C0, version: 1 } });
  j = await r.json();
  check("stale version -> 409 version_conflict", r.status === 409 && j.error === "version_conflict" && j.content.version === 2, JSON.stringify(j));
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...C0, heroTitle: "নতুন <b>শিরোনাম</b>", version: 2 } });
  j = await r.json();
  check("HTML-looking text stored as plain text", r.status === 200 && j.content.heroTitle === "নতুন <b>শিরোনাম</b>" && j.content.version === 3);
  r = await api("/admin/content/undo", { method: "POST", token: adminToken, body: { version: 2 } });
  check("undo with stale version -> 409", r.status === 409);
  r = await api("/admin/content/undo", { method: "POST", token: adminToken, body: { version: 3 } });
  j = await r.json();
  check("undo restores previous content (new version 4)", r.status === 200 && j.content.version === 4 && j.content.heroTitle === "x".repeat(120) && j.content.accentColor === "#0B7A55", JSON.stringify(j));
  r = await api("/admin/content/undo", { method: "POST", token: adminToken, body: {} });
  j = await r.json();
  check("undo again swaps back (redo)", r.status === 200 && j.content.version === 5 && j.content.heroTitle === "নতুন <b>শিরোনাম</b>");
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...C0, version: 5 } });
  check("save original values again", r.status === 200 && (await r.json()).content.version === 6);

  // --- admin-only management
  r = await api("/admin/users/" + encodeURIComponent(ADMIN) + "/reject", { method: "POST", token: userToken });
  check("non-admin manage -> 403", r.status === 403);

  // second user rejected via email link
  logs = "";
  await login({ email: "karim@gmail.com", name: "Karim" });
  await new Promise((x) => setTimeout(x, 800));
  const m2 = logs.match(/"rejectUrl":"([^"]+)"/);
  const ru = new URL(m2[1]);
  r = await api("/reject", { method: "POST", origin: null, form: Object.fromEntries(ru.searchParams) });
  check("POST /reject -> 200", r.status === 200);
  r = await login({ email: "karim@gmail.com" });
  check("rejected user -> rejected", (await r.json()).status === "rejected");

  r = await api("/admin/users/karim%40gmail.com/approve", { method: "POST", token: adminToken });
  check("admin approves from panel", r.status === 200 && (await r.json()).user.status === "approved");

  r = await api("/admin/users/rahim%40gmail.com/reject", { method: "POST", token: adminToken });
  check("admin rejects from panel", r.status === 200);
  r = await api("/me", { token: userToken });
  check("rejected user's existing token revoked", r.status === 401);

  r = await api("/admin/users/rahim%40gmail.com/delete", { method: "POST", token: adminToken });
  check("admin deletes user", r.status === 200);
  r = await api("/admin/users", { token: adminToken });
  j = await r.json();
  check("user list after delete", j.users.length === 2 && !j.users.find((x) => x.email === "rahim@gmail.com"));
  r = await api("/admin/users/" + encodeURIComponent(ADMIN) + "/delete", { method: "POST", token: adminToken });
  check("admin cannot delete self", r.status === 400);


  // --- TEST_MODE must not work for non-localhost hostnames (simulates production host)
  const prodStatus = await new Promise((resolve) => {
    const body = JSON.stringify({ credential: googleToken({ email: ADMIN }) });
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/auth/google", method: "POST",
      headers: { host: "api.webdesigner71.com", "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve([res.statusCode, d])); });
    req.end(body);
  });
  check("test JWKS ignored on non-localhost host", prodStatus[0] !== 200 || !prodStatus[1].includes("approved"), prodStatus.join(" "));
  console.log("      (prod-host response:", prodStatus.join(" ").slice(0, 80) + ")");
  r = await api("/admin/users");
  check("/admin/users without token -> 401", r.status === 401);
} catch (e) {
  fail++; console.error("ERROR", e);
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  rmSync(persist, { recursive: true, force: true });
  rmSync(".dev.vars", { force: true });
  rmSync(TEST_CONFIG, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 500);
}
