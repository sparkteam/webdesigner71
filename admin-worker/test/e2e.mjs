// End-to-end test (CMS Phase 2 included): runs `wrangler dev --local` with a test-only JWKS (TEST_MODE, localhost only),
// signs fake Google ID tokens with a locally generated RSA key, and exercises the full flow.
import { spawn } from "node:child_process";
import { generateKeyPairSync, createSign, randomBytes, createHmac } from "node:crypto";
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import * as M from "../src/cms-model.js";
import * as PG from "../src/cms-pages.js";
import * as PO from "../src/cms-posts.js";

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
// Write a key straight into the local (throwaway) KV store, e.g. to simulate the Phase 1 key in production.
const putLocalKV = (binding, key, obj) => {
  const f = join(tmpdir(), "wd71-e2e-kv-value.json");
  writeFileSync(f, JSON.stringify(obj));
  execFileSync("npx", ["wrangler", "kv", "key", "put", key, "--path", f, "--binding", binding, "--local", "--persist-to", persist, "--config", TEST_CONFIG], { stdio: "pipe" });
};
const listLocalKV = (binding, prefix = "") =>
  JSON.parse(execFileSync("npx", ["wrangler", "kv", "key", "list", "--binding", binding, "--local", "--persist-to", persist, "--config", TEST_CONFIG, ...(prefix ? ["--prefix", prefix] : [])], { stdio: "pipe" }).toString()).map((k) => k.name);
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

  // --- CMS Phase 2: homepage sections, settings, media
  r = await api("/content", { origin: null });
  j = await r.json();
  check("public GET /content (empty) -> {content:null}", r.status === 200 && j.content === null, JSON.stringify(j));
  r = await api("/content/homepage", { origin: null });
  j = await r.json();
  check("public GET /content/homepage (empty) -> defaults, version 0", r.status === 200 && j.source === "defaults" && j.sections.length === M.SECTION_IDS.length && j.sections.every((s) => s.version === 0) && j.settings.accentColor === "#D4A017", JSON.stringify(j).slice(0, 200));
  // Phase 1 key present (what production has) -> migrated read
  const V1 = { heroTitle: "আপনার ব্যবসার ওয়েবসাইট, মাত্র", heroHighlight: "৩৯০০ টাকায়", heroSub: "ডোমেইন, হোস্টিং, ডিজাইন — সব এক প্যাকেজে", accentColor: "#D4A017", version: 3, updatedBy: ADMIN, updatedAt: "2026-11-01T00:00:00.000Z" };
  putLocalKV("CONTENT", "content:homepage", V1);
  r = await api("/content/homepage", { origin: null });
  j = await r.json();
  const heroOf = (x) => x.sections.find((s) => s.id === "hero");
  check("Phase 1 key -> source v1, hero equals defaults", j.source === "v1" && JSON.stringify(heroOf(j).fields) === JSON.stringify(M.DEFAULTS.hero.fields), JSON.stringify(heroOf(j)).slice(0, 200));
  r = await api("/content", { origin: null });
  j = await r.json();
  check("Phase 1 GET /content still works (derived)", j.content && j.content.heroTitle === V1.heroTitle && j.content.accentColor === "#D4A017" && !("updatedBy" in j.content), JSON.stringify(j));
  r = await api("/admin/content", { method: "PUT", token: adminToken, body: { ...V1, version: 3 } });
  j = await r.json();
  check("Phase 1 PUT /admin/content -> 410 superseded", r.status === 410 && j.error === "superseded" && /sections\/hero/.test(j.use), JSON.stringify(j));
  r = await api("/admin/content/undo", { method: "POST", token: adminToken, body: {} });
  check("Phase 1 POST /admin/content/undo -> 410", r.status === 410);

  r = await api("/admin/content/homepage/sections/hero", { method: "OPTIONS" });
  const methods = r.headers.get("access-control-allow-methods") || "";
  check("CORS preflight allows PUT + DELETE", r.status === 204 && /\bPUT\b/.test(methods) && /\bDELETE\b/.test(methods), methods);
  const H = JSON.parse(JSON.stringify(M.DEFAULTS.hero));
  const sec = (id, body, token = adminToken) => api(`/admin/content/homepage/sections/${id}`, { method: "PUT", token, body });
  r = await sec("hero", { ...H, version: 1 }, null);
  check("section PUT without token -> 401", r.status === 401);
  r = await sec("hero", { ...H, version: 1 }, userToken);
  check("non-admin section PUT -> 403", r.status === 403 && (await r.json()).error === "admin_only");
  r = await sec("nope", { ...H, version: 1 });
  check("unknown section -> 404", r.status === 404);
  r = await api("/admin/content/homepage/sections/hero/undo", { method: "POST", token: adminToken, body: {} });
  check("undo with no previous -> 404", r.status === 404);
  r = await api("/admin/content/homepage/sections/hero/undo", { method: "POST", token: userToken, body: {} });
  check("non-admin undo -> 403", r.status === 403);
  const H1 = JSON.parse(JSON.stringify(H));
  H1.fields.title = { text: "নতুন <b>শিরোনাম</b>", highlight: "৪৯০০ টাকায়" };
  H1.fields.buttons.items.reverse();
  H1.fields.buttons.items.push({ id: "b3", label: "কল করুন", href: "tel:+8801700000000", style: "green", newTab: false, hidden: false });
  H1.fields.trust.items[1].hidden = true;
  H1.extra = [{ id: "e1", type: "heading", text: "নতুন শিরোনাম" }, { id: "e2", type: "button", label: "দেখুন", href: "#work", style: "ghost" }];
  r = await sec("hero", { ...H1, version: 1 });
  j = await r.json();
  check("admin saves hero -> version 2 (migrated v1 = 1), HTML kept as plain text", r.status === 200 && j.section.version === 2 && j.section.fields.title.text === "নতুন <b>শিরোনাম</b>" && j.section.fields.buttons.items[2].id === "b3" && j.section.extra.length === 2 && j.section.updatedBy === ADMIN, JSON.stringify(j).slice(0, 300));
  r = await api("/content/homepage", { origin: null });
  j = await r.json();
  check("public read: saved, no updatedBy, source v2", j.source === "v2" && heroOf(j).version === 2 && !("updatedBy" in heroOf(j)) && heroOf(j).fields.trust.items[1].hidden === true);
  r = await api("/content/homepage", { token: adminToken });
  check("read with session includes updatedBy", heroOf(await r.json()).updatedBy === ADMIN);
  r = await api("/content", { origin: null });
  check("Phase 1 GET /content follows v2 hero", (await r.json()).content.heroTitle === "নতুন <b>শিরোনাম</b>");
  r = await sec("hero", { ...H, version: 1 });
  j = await r.json();
  check("stale version -> 409 with current section", r.status === 409 && j.error === "version_conflict" && j.section.version === 2, JSON.stringify(j).slice(0, 200));
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(H1)); mut(x); return { ...x, version: 2 }; };
  for (const [name, body, field] of [
    ["empty title -> title.text", bad((x) => (x.fields.title.text = "  ")), "title.text"],
    ["title > 120 chars", bad((x) => (x.fields.title.text = "ক".repeat(121))), "title.text"],
    ["control chars", bad((x) => (x.fields.sub.text = "a\u0007b")), "sub.text"],
    ["javascript: href", bad((x) => (x.fields.buttons.items[0].href = "javascript:alert(1)")), "buttons.items.0.href"],
    ["protocol-relative href", bad((x) => (x.fields.buttons.items[0].href = "//evil.example")), "buttons.items.0.href"],
    ["data: href", bad((x) => (x.fields.buttons.items[0].href = "data:text/html,x")), "buttons.items.0.href"],
    ["unknown button style", bad((x) => (x.fields.buttons.items[0].style = "red")), "buttons.items.0.style"],
    ["duplicate item id", bad((x) => (x.fields.buttons.items[1].id = x.fields.buttons.items[0].id)), "buttons.items.1.id"],
    ["too many buttons", bad((x) => { for (let i = 0; i < 7; i++) x.fields.buttons.items.push({ id: "z" + i, label: "x", href: "#", style: "gold" }); }), "buttons.items"],
    ["external image", bad((x) => (x.fields.image = { src: "https://evil.example/a.png", alt: "" })), "image.src"],
    ["image path traversal", bad((x) => (x.fields.image = { src: "/assets/../wrangler.jsonc", alt: "" })), "image.src"],
    ["extra image must have src", bad((x) => x.extra.push({ id: "e9", type: "image", src: "" })), "extra.2.src"],
    ["unknown extra type", bad((x) => x.extra.push({ id: "e9", type: "script", text: "x" })), "extra.2.type"],
    ["missing version", (() => { const x = bad(() => {}); delete x.version; return x; })(), "version"],
  ]) {
    r = await sec("hero", body);
    j = await r.json();
    check("invalid: " + name, r.status === 400 && j.error === "invalid_field" && j.field === field, r.status + " " + JSON.stringify(j));
  }
  r = await sec("header", { ...JSON.parse(JSON.stringify(M.DEFAULTS.header)), extra: [{ id: "e1", type: "text", text: "x" }], version: 1 });
  check("extras not allowed in header", r.status === 400 && (await r.json()).field === "extra");
  r = await api("/admin/content/homepage/sections/hero", { method: "PUT", token: adminToken, body: { ...H1, version: 2, pad: "x".repeat(70000) } });
  check("body > 64KB -> 413", r.status === 413);
  // cards: reorder + hide + add on packages; another section keeps its own version
  const P = JSON.parse(JSON.stringify(M.DEFAULTS.packages));
  P.fields.cards.items.reverse(); P.fields.cards.items[0].hidden = true;
  P.fields.cards.items.push({ id: "c3", popular: false, name: "বেসিক", price: "৳২৯০০", features: { items: [{ id: "f1", text: "এক পাতা" }] }, buttonLabel: "নিন", buttonHref: "#contact", buttonStyle: "outline" });
  r = await sec("packages", { ...P, version: 1 });
  j = await r.json();
  check("packages cards reorder/hide/add saved independently (v2)", r.status === 200 && j.section.version === 2 && j.section.fields.cards.items.map((c) => c.id).join() === "c2,c1,c3" && j.section.fields.cards.items[2].priceNote === "", JSON.stringify(j).slice(0, 300));
  r = await api("/admin/content/homepage/sections/hero/undo", { method: "POST", token: adminToken, body: { version: 1 } });
  check("undo with stale version -> 409", r.status === 409);
  r = await api("/admin/content/homepage/sections/hero/undo", { method: "POST", token: adminToken, body: { version: 2 } });
  j = await r.json();
  check("undo restores previous hero (version 3) and leaves packages alone", r.status === 200 && j.section.version === 3 && JSON.stringify(j.section.fields) === JSON.stringify(M.DEFAULTS.hero.fields), JSON.stringify(j).slice(0, 200));
  r = await api("/admin/content/homepage/sections/hero/undo", { method: "POST", token: adminToken, body: {} });
  j = await r.json();
  check("undo again swaps back (redo, version 4)", r.status === 200 && j.section.version === 4 && j.section.fields.title.text === "নতুন <b>শিরোনাম</b>");
  r = await api("/content/homepage", { origin: null });
  j = await r.json();
  check("packages still at version 2 after hero undo", j.sections.find((s) => s.id === "packages").version === 2);

  // settings
  r = await api("/admin/settings");
  check("GET /admin/settings without token -> 401", r.status === 401);
  r = await api("/admin/settings", { token: userToken });
  j = await r.json();
  check("GET /admin/settings (session) -> defaults v0", r.status === 200 && j.settings.version === 0 && j.settings.siteTitle === M.DEFAULT_SETTINGS.siteTitle);
  r = await api("/admin/settings", { method: "PUT", token: userToken, body: { ...M.DEFAULT_SETTINGS, version: 0 } });
  check("non-admin PUT settings -> 403", r.status === 403);
  for (const [name, body, field] of [
    ["bad accent", { accentColor: "red" }, "accentColor"], ["short hex", { primaryColor: "#FFF" }, "primaryColor"],
    ["empty title", { siteTitle: " " }, "siteTitle"], ["bad email", { contactEmail: "nope" }, "contactEmail"], ["bad phone", { contactPhone: "call me" }, "contactPhone"],
  ]) {
    r = await api("/admin/settings", { method: "PUT", token: adminToken, body: { ...M.DEFAULT_SETTINGS, ...body, version: 0 } });
    j = await r.json();
    check("settings invalid: " + name, r.status === 400 && j.field === field, JSON.stringify(j));
  }
  r = await api("/admin/settings", { method: "PUT", token: adminToken, body: { ...M.DEFAULT_SETTINGS, accentColor: "#0b7a55", contactEmail: "hi@webdesigner71.com", version: 0 } });
  j = await r.json();
  check("settings saved, colour upper-cased, v1", r.status === 200 && j.settings.version === 1 && j.settings.accentColor === "#0B7A55" && j.settings.updatedBy === ADMIN, JSON.stringify(j));
  r = await api("/admin/settings", { method: "PUT", token: adminToken, body: { ...M.DEFAULT_SETTINGS, version: 0 } });
  check("settings stale version -> 409", r.status === 409 && (await r.json()).settings.version === 1);
  r = await api("/content", { origin: null });
  check("Phase 1 GET /content accent follows settings", (await r.json()).content.accentColor === "#0B7A55");
  r = await api("/admin/settings/undo", { method: "POST", token: adminToken, body: { version: 1 } });
  j = await r.json();
  check("settings undo -> v2 with previous values", r.status === 200 && j.settings.version === 2 && j.settings.accentColor === "#D4A017" && j.settings.contactEmail === "");

  // media
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const upload = (bytes, name, type, token = adminToken, alt = "পরীক্ষা ছবি") => {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), name);
    if (alt !== null) fd.append("alt", alt);
    return fetch(BASE + "/admin/media", { method: "POST", headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: fd });
  };
  r = await api("/admin/media");
  check("GET /admin/media without token -> 401", r.status === 401);
  r = await api("/admin/media", { token: userToken });
  j = await r.json();
  check("GET /admin/media (session) -> storage kv, builtin hero illustration", r.status === 200 && j.storage === "kv" && j.items.length === 0 && j.builtin[0].url === "/assets/hero-illustration.svg", JSON.stringify(j));
  r = await upload(PNG, "a.png", "image/png", null);
  check("upload without token -> 401", r.status === 401);
  r = await upload(PNG, "a.png", "image/png", userToken);
  check("non-admin upload -> 403", r.status === 403);
  r = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "x.svg", "image/svg+xml");
  check("SVG upload rejected -> 415", r.status === 415 && (await r.json()).error === "unsupported_type");
  r = await upload(Buffer.from("<html>not an image</html>"), "fake.png", "image/png");
  check("fake .png (bad magic bytes) -> 415", r.status === 415);
  r = await upload(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "big.png", "image/png");
  check("> 5 MB -> 413", r.status === 413, r.status);
  r = await api("/admin/media", { method: "POST", token: adminToken, body: { file: "x" } });
  check("JSON instead of multipart -> 415", r.status === 415);
  r = await upload(PNG, "লোগো.png", "application/octet-stream");
  j = await r.json();
  const media = j.item;
  check("PNG upload -> 201, key yyyy-mm-*.png, type sniffed", r.status === 201 && /^\d{4}-\d{2}-[A-Za-z0-9]+\.png$/.test(media.key) && media.contentType === "image/png" && media.alt === "পরীক্ষা ছবি" && media.url === "/media/" + media.key, JSON.stringify(j));
  r = await upload(Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex"), "a.gif", "image/gif", adminToken, null);
  const gif = (await r.json()).item;
  check("GIF upload -> 201", r.status === 201 && gif.contentType === "image/gif");
  r = await api("/admin/media", { token: adminToken });
  j = await r.json();
  check("library lists both uploads", j.items.length === 2 && j.items.some((x) => x.key === media.key));
  r = await api("/admin/media/" + media.key, { method: "PUT", token: adminToken, body: { alt: "নতুন বিবরণ" } });
  check("update alt text", r.status === 200 && (await r.json()).item.alt === "নতুন বিবরণ");
  // use it on the homepage -> delete is blocked unless forced
  const W = JSON.parse(JSON.stringify(M.DEFAULTS.work));
  W.fields.items.items[0].image = media.url;
  r = await sec("work", { ...W, version: 1 });
  check("image from library saved on a work card", r.status === 200);
  r = await api("/admin/media", { token: adminToken });
  check("library shows where it is used", (await r.json()).items.find((x) => x.key === media.key).usedIn.join() === "work.items.items.w1.image");
  r = await api("/admin/media/" + media.key, { method: "DELETE", token: userToken });
  check("non-admin delete -> 403", r.status === 403);
  r = await api("/admin/media/" + media.key, { method: "DELETE", token: adminToken });
  j = await r.json();
  check("delete in-use image -> 409 in_use", r.status === 409 && j.error === "in_use" && j.usedIn.length === 1, JSON.stringify(j));
  r = await api("/admin/media/" + gif.key, { method: "DELETE", token: adminToken });
  check("delete unused image -> 200", r.status === 200);
  r = await api("/admin/media/" + media.key + "?force=1", { method: "DELETE", token: adminToken });
  check("forced delete -> 200", r.status === 200);
  r = await api("/admin/media/" + media.key, { method: "DELETE", token: adminToken });
  check("delete missing -> 404", r.status === 404);
  r = await api("/admin/media/..%2Fx", { method: "DELETE", token: adminToken });
  check("bad media key -> 404", r.status === 404);
  r = await api("/admin/media", { token: adminToken });
  check("library empty again", (await r.json()).items.length === 0);

  // --- Pages (Phase 3)
  {
    const pg = (path, o = {}) => api("/admin/pages" + path, { token: adminToken, ...o });
    const B = (type, extra = {}) => ({ id: "b" + randomBytes(5).toString("hex"), type, ...extra });
    r = await api("/admin/pages");
    check("pages: list without token -> 401", r.status === 401);
    r = await api("/admin/pages", { token: userToken });
    check("pages: non-admin list -> 403 (drafts are admin-only)", r.status === 403);
    r = await pg("");
    j = await r.json();
    check("pages: admin can list (empty)", r.status === 200 && Array.isArray(j.pages) && j.pages.length === 0 && j.limits.blocks === 200, JSON.stringify(j).slice(0, 200));
    r = await api("/admin/pages", { method: "POST", token: userToken, body: { title: "x", slug: "x" } });
    check("pages: non-admin create -> 403", r.status === 403);
    const bad = async (body, field, reason, name) => {
      const rr = await pg("", { method: "POST", body }); const jj = await rr.json();
      check("pages: " + name + " -> 400 " + field + "/" + reason, rr.status === 400 && jj.field === field && jj.reason === reason, rr.status + " " + JSON.stringify(jj));
    };
    await bad({ title: "A", slug: "" }, "slug", "required", "empty slug");
    await bad({ title: "A", slug: "Hello" }, "slug", "format", "uppercase slug");
    await bad({ title: "A", slug: "a--b" }, "slug", "format", "double dash");
    await bad({ title: "A", slug: "-a" }, "slug", "format", "leading dash");
    await bad({ title: "A", slug: "a/b" }, "slug", "format", "slash");
    await bad({ title: "A", slug: "a".repeat(61) }, "slug", "too_long", "61 chars");
    for (const s of ["admin", "media", "cms", "old-homepage", "assets", "sitemap"]) await bad({ title: "A", slug: s }, "slug", "reserved", "reserved " + s);
    await bad({ title: "", slug: "ok" }, "title", "required", "empty title");
    await bad({ title: "A", slug: "ok", blocks: [B("nope")] }, "blocks.0.type", "enum", "unknown block type");
    await bad({ title: "A", slug: "ok", blocks: [B("section", { children: [B("section")] })] }, "blocks.0.children.0.type", "not_allowed", "section in section");
    await bad({ title: "A", slug: "ok", blocks: [B("buttons", { content: { buttons: [{ label: "x", href: "javascript:alert(1)" }] } })] }, "blocks.0.content.buttons.0.href", "url", "javascript: href");
    await bad({ title: "A", slug: "ok", blocks: [B("image", { content: { src: "https://evil.example/x.png" } })] }, "blocks.0.content.src", "image", "external image");
    await bad({ title: "A", slug: "ok", blocks: [B("heading", { content: { text: "t" }, style: { color: "red;}body{x" } })] }, "blocks.0.style.color", "color", "css injection in colour");
    await bad({ title: "A", slug: "ok", blocks: [B("heading", { content: { text: "t" }, style: { pt: "10px;x" } })] }, "blocks.0.style.pt", "range", "css injection in spacing");
    await bad({ title: "A", slug: "ok", blocks: [B("heading", { content: { text: "t" }, adv: { cls: "a\"><script>" } })] }, "blocks.0.adv.cls", "format", "class injection");
    await bad({ title: "A", slug: "ok", blocks: [B("video", { content: { url: "https://evil.example/v.mp4" } })] }, "blocks.0.content.url", "video", "non-allow-listed video");
    await bad({ title: "A", slug: "ok", blocks: Array.from({ length: 201 }, () => B("spacer")) }, "blocks", "too_many", "201 blocks");
    const big = Array.from({ length: 45 }, () => B("text", { content: { html: "<p>" + "ক".repeat(2000) + "</p>" } }));
    await bad({ title: "A", slug: "ok", blocks: big }, "blocks", "too_large", "over 256 KB");
    r = await pg("", { method: "POST", body: { title: "A", slug: "ok", blocks: "x".repeat(300 * 1024) } });
    check("pages: body over limit -> 413", r.status === 413, r.status);
    r = await pg("", { method: "POST", body: { title: "A", slug: "ok", template: "evil" } });
    check("pages: bad template -> 400", r.status === 400 && (await r.json()).field === "template");

    // create (XSS payloads are stored as text and escaped on render)
    const XSS = '<img src=x onerror=alert(1)>"\'</title><script>alert(1)</script>';
    r = await pg("", { method: "POST", body: { title: "আমাদের সম্পর্কে " + XSS, slug: "amader-somporke", template: "about", seo: { title: "About " + XSS, description: "d", noindex: false } } });
    j = await r.json();
    const p1 = j.page;
    check("pages: create from template -> 201 draft v1", r.status === 201 && p1.status === "draft" && p1.version === 1 && PG.PAGE_ID_RE.test(p1.id) && p1.blocks.length > 3, JSON.stringify(j).slice(0, 300));
    r = await pg("", { method: "POST", body: { title: "Other", slug: "amader-somporke" } });
    check("pages: duplicate slug -> 400 taken", r.status === 400 && (await r.json()).reason === "taken");
    r = await pg("/" + p1.id, { token: userToken });
    check("pages: non-admin get by id -> 403 (draft stays private)", r.status === 403);
    r = await pg("/" + p1.id);
    check("pages: admin get by id", r.status === 200 && (await r.json()).page.id === p1.id);
    r = await pg("/pxxxxxxxx");
    check("pages: unknown id -> 404", r.status === 404);
    r = await pg("/..%2Fusers");
    check("pages: bad id -> 404", r.status === 404);
    r = await api("/pages/amader-somporke");
    check("pages: draft not public (404)", r.status === 404);
    r = await pg("");
    j = await r.json();
    check("pages: index lists the page", j.pages.length === 1 && j.pages[0].slug === "amader-somporke" && j.pages[0].status === "draft" && j.pages[0].blocks === PG.countBlocks(p1.blocks));

    // update + version conflicts
    const edit = { title: p1.title, slug: p1.slug, seo: p1.seo, blocks: [B("heading", { content: { text: "Hello " + XSS, level: "h1" } }), ...p1.blocks] };
    r = await pg("/" + p1.id, { method: "PUT", token: userToken, body: { ...edit, version: 1 } });
    check("pages: non-admin PUT -> 403", r.status === 403);
    r = await pg("/" + p1.id, { method: "PUT", body: edit });
    check("pages: PUT without version -> 400", r.status === 400 && (await r.json()).field === "version");
    r = await pg("/" + p1.id, { method: "PUT", body: { ...edit, version: 1 } });
    j = await r.json();
    check("pages: PUT -> v2", r.status === 200 && j.page.version === 2 && j.page.blocks[0].type === "heading", JSON.stringify(j).slice(0, 200));
    r = await pg("/" + p1.id, { method: "PUT", body: { ...edit, version: 1 } });
    j = await r.json();
    check("pages: stale PUT -> 409 with current page", r.status === 409 && j.error === "version_conflict" && j.page.version === 2);
    r = await pg("/" + p1.id, { method: "PUT", body: { ...edit, extra: 1, version: 2 } });
    check("pages: unknown top-level key -> 400", r.status === 400);
    r = await pg("/" + p1.id + "/undo", { method: "POST", body: { version: 2 } });
    j = await r.json();
    check("pages: undo -> v3 restores previous blocks", r.status === 200 && j.page.version === 3 && j.page.blocks.length === p1.blocks.length);
    r = await pg("/" + p1.id + "/undo", { method: "POST", body: { version: 3 } });
    j = await r.json();
    check("pages: undo again = redo -> v4", r.status === 200 && j.page.version === 4 && j.page.blocks[0].type === "heading");

    // publish
    r = await pg("/" + p1.id + "/publish", { method: "POST", token: userToken, body: { version: 4 } });
    check("pages: non-admin publish -> 403", r.status === 403);
    r = await pg("/" + p1.id + "/publish", { method: "POST", body: { version: 3 } });
    check("pages: stale publish -> 409", r.status === 409);
    r = await pg("/" + p1.id + "/publish", { method: "POST", body: { version: 4 } });
    j = await r.json();
    check("pages: publish -> v5 published", r.status === 200 && j.page.status === "published" && j.page.version === 5 && j.page.publishedVersion === 5 && j.page.publishedSlug === "amader-somporke");
    r = await api("/pages/amader-somporke");
    j = await r.json();
    check("pages: public GET /pages/:slug", r.status === 200 && j.page.slug === "amader-somporke" && !("updatedBy" in j.page) && j.page.blocks[0].content.text.startsWith("Hello "));
    check("pages: pub key written", listLocalKV("CONTENT", "pub:").join() === "pub:amader-somporke");

    // edit after publish → "changed"; slug move → 301 redirect
    r = await pg("/" + p1.id, { method: "PUT", body: { ...edit, slug: "about-us", version: 5 } });
    j = await r.json();
    check("pages: draft slug change keeps live URL", r.status === 200 && j.page.slug === "about-us" && j.page.publishedSlug === "amader-somporke");
    r = await pg("");
    check("pages: index marks unpublished changes", (await r.json()).pages[0].changed === true);
    r = await api("/pages/about-us");
    check("pages: new slug not live before publish", r.status === 404);
    r = await pg("/" + p1.id + "/publish", { method: "POST", body: { version: 6 } });
    j = await r.json();
    check("pages: republish with new slug -> redirects recorded", r.status === 200 && j.page.publishedSlug === "about-us" && j.page.redirects.join() === "amader-somporke");
    check("pages: old pub key gone, redirect key set", listLocalKV("CONTENT", "pub:").join() === "pub:about-us" && listLocalKV("CONTENT", "redirect:").join() === "redirect:amader-somporke");
    r = await pg("", { method: "POST", body: { title: "Clash", slug: "about-us" } });
    check("pages: live slug of another page is taken", r.status === 400 && (await r.json()).reason === "taken");

    // duplicate
    r = await pg("/" + p1.id + "/duplicate", { method: "POST", body: {} });
    j = await r.json();
    const p2 = j.page;
    const ids1 = new Set(); const walk = (l, set) => (l || []).forEach((b) => { set.add(b.id); walk(b.children, set); });
    walk(edit.blocks, ids1); const ids2 = new Set(); walk(p2 && p2.blocks, ids2);
    check("pages: duplicate -> 201 draft with new slug + fresh block ids", r.status === 201 && p2.status === "draft" && p2.slug === "about-us-copy" && p2.title.endsWith("(কপি)") && ![...ids2].some((x) => ids1.has(x)), JSON.stringify(j).slice(0, 200));
    r = await pg("/" + p2.id + "/duplicate", { method: "POST", token: userToken, body: {} });
    check("pages: non-admin duplicate -> 403", r.status === 403);

    // unpublish / delete
    r = await pg("/" + p2.id + "/unpublish", { method: "POST", body: { version: 1 } });
    check("pages: unpublish a draft -> 409", r.status === 409);
    r = await pg("/" + p1.id + "/unpublish", { method: "POST", body: { version: 7 } });
    j = await r.json();
    check("pages: unpublish -> draft, keys removed", r.status === 200 && j.page.status === "draft" && listLocalKV("CONTENT", "pub:").length === 0 && listLocalKV("CONTENT", "redirect:").length === 0, JSON.stringify(j).slice(0, 200));
    r = await api("/pages/about-us");
    check("pages: unpublished page not public", r.status === 404);
    r = await pg("/" + p1.id + "/publish", { method: "POST", body: { version: 8 } });
    check("pages: publish again", r.status === 200);
    r = await pg("/" + p1.id, { method: "DELETE", token: userToken });
    check("pages: non-admin delete -> 403", r.status === 403);
    r = await pg("/" + p1.id + "?version=1", { method: "DELETE" });
    check("pages: stale delete -> 409", r.status === 409);
    r = await pg("/" + p1.id, { method: "DELETE" });
    check("pages: delete published page", r.status === 200);
    r = await pg("/" + p2.id, { method: "DELETE" });
    check("pages: delete copy", r.status === 200);
    r = await pg("/" + p2.id, { method: "DELETE" });
    check("pages: delete again -> 404", r.status === 404);
    const left = listLocalKV("CONTENT").filter((k) => /^(page:|pages:|pub:|redirect:)/.test(k));
    check("pages: no page keys left after delete", left.length === 0, left.join());
    r = await api("/admin/pages", { method: "PATCH", token: adminToken });
    check("pages: wrong method -> 404/405", r.status === 404 || r.status === 405);
  }

  // --- Posts / blog (Phase 4)
  {
    const po = (path, o = {}) => api("/admin/posts" + path, { token: adminToken, ...o });
    r = await api("/admin/posts");
    check("posts: list without token -> 401", r.status === 401);
    r = await api("/admin/posts", { token: userToken });
    check("posts: non-admin list -> 403 (drafts are admin-only)", r.status === 403);
    r = await po("");
    j = await r.json();
    check("posts: admin list (empty) + terms + limits", r.status === 200 && j.posts.length === 0 && j.terms.categories.length === 0 && j.limits.perPage === 9, JSON.stringify(j).slice(0, 200));
    // terms
    r = await po("/terms", { method: "POST", token: userToken, body: { kind: "category", name: "ডিজাইন" } });
    check("posts: non-admin create category -> 403", r.status === 403);
    r = await po("/terms", { method: "POST", body: { kind: "author", name: "x" } });
    check("posts: bad term kind -> 400", r.status === 400 && (await r.json()).field === "kind");
    r = await po("/terms", { method: "POST", body: { kind: "category", name: "" } });
    check("posts: empty term name -> 400", r.status === 400 && (await r.json()).field === "name");
    r = await po("/terms", { method: "POST", body: { kind: "category", name: "ওয়েব ডিজাইন", slug: "web-design" } });
    j = await r.json();
    const cat1 = j.term;
    check("posts: create category -> 201", r.status === 201 && /^c/.test(cat1.id) && cat1.slug === "web-design", JSON.stringify(j));
    r = await po("/terms", { method: "POST", body: { kind: "category", name: "SEO Tips" } });
    j = await r.json();
    const cat2 = j.term;
    check("posts: category auto slug from latin name", r.status === 201 && cat2.slug === "seo-tips", JSON.stringify(j));
    r = await po("/terms", { method: "POST", body: { kind: "category", name: "অন্য", slug: "web-design" } });
    check("posts: duplicate term slug -> 400 taken", r.status === 400 && (await r.json()).reason === "taken");
    r = await po("/terms", { method: "POST", body: { kind: "category", name: "ওয়েব ডিজাইন" } });
    j = await r.json();
    check("posts: same name returns existing term", r.status === 200 && j.existed && j.term.id === cat1.id);
    r = await po("/terms", { method: "POST", body: { kind: "tag", name: "বাংলা" } });
    j = await r.json();
    const tag1 = j.term;
    check("posts: create tag (bengali name -> fallback slug)", r.status === 201 && /^t/.test(tag1.id) && /^tag-[a-z0-9]+$/.test(tag1.slug), JSON.stringify(j));
    r = await po("/terms/" + tag1.id, { method: "PUT", body: { name: "বাংলা টিপস", slug: "bangla" } });
    j = await r.json();
    check("posts: rename tag + slug", r.status === 200 && j.term.name === "বাংলা টিপস" && j.term.slug === "bangla", JSON.stringify(j));
    r = await po("/terms/" + tag1.id, { method: "PUT", body: { color: "red" } });
    check("posts: unknown term field -> 400", r.status === 400);
    r = await po("/terms/czzzzzzzz", { method: "PUT", body: { name: "x" } });
    check("posts: unknown term -> 404", r.status === 404);

    // create + validation
    const bad = async (name, body, field, reason) => { const rr = await po("", { method: "POST", body }); const jj = await rr.json(); check("posts: " + name + " -> 400 " + field + "/" + reason, rr.status === 400 && jj.field === field && (!reason || jj.reason === reason), rr.status + " " + JSON.stringify(jj)); };
    await bad("missing title", { title: "" }, "title", "required");
    await bad("reserved slug", { title: "x", slug: "category" }, "slug", "reserved");
    await bad("bad slug", { title: "x", slug: "Hello World" }, "slug", "format");
    await bad("unknown key", { title: "x", html: "<script>" }, "html", "unknown");
    await bad("external image", { title: "x", image: "https://evil.example/x.png" }, "image", "image");
    await bad("bad date", { title: "x", date: "tomorrow" }, "date");
    await bad("bad term id", { title: "x", categories: ["../x"] }, "categories");
    await bad("tag id in categories", { title: "x", categories: [tag1.id] }, "categories");
    await bad("script in code block is fine but bad block type fails", { title: "x", blocks: [{ id: "bxxxx1", type: "script", content: {} }] }, "blocks.0.type");
    r = await po("", { method: "POST", token: userToken, body: { title: "x" } });
    check("posts: non-admin create -> 403", r.status === 403);
    const code = "function hi() {\n\treturn '<b>hi</b>';\n}";
    const blocks = [
      { id: "btoc001", type: "toc", content: {} },
      { id: "bh20001", type: "heading", content: { text: "প্রথম অংশ", level: "h2" } },
      { id: "btx0001", type: "text", content: { html: "<p>" + "শব্দ ".repeat(450) + "</p>" } },
      { id: "bcode01", type: "code", content: { code, lang: "JS" } },
      { id: "bcall01", type: "callout", content: { variant: "warn", title: "সাবধান", text: "এটা **জরুরি**" } },
    ];
    r = await po("", { method: "POST", body: { title: "Hello Blog World", categories: [cat1.id, "cdeleted1"], tags: [tag1.id], blocks, author: "মোশফিক" } });
    j = await r.json();
    const q1 = j.post;
    check("posts: create -> 201 draft, auto slug, unknown term dropped", r.status === 201 && q1.status === "draft" && q1.slug === "hello-blog-world" && q1.version === 1 && q1.categories.length === 1 && q1.categories[0] === cat1.id, JSON.stringify(j).slice(0, 300));
    check("posts: code block keeps tabs/newlines", q1.blocks[3].content.code === code, JSON.stringify(q1.blocks[3]));
    r = await po("", { method: "POST", body: { title: "Hello Blog World" } });
    j = await r.json();
    const q2 = j.post;
    check("posts: same title -> unique slug -2", r.status === 201 && q2.slug === "hello-blog-world-2", JSON.stringify(j).slice(0, 200));
    r = await po("", { method: "POST", body: { title: "x", slug: "hello-blog-world" } });
    check("posts: explicit taken slug -> 400 taken", r.status === 400 && (await r.json()).reason === "taken");
    r = await po("", { method: "POST", body: { title: "শুধু বাংলা শিরোনাম" } });
    j = await r.json();
    const q3 = j.post;
    check("posts: bengali-only title gets a fallback slug", r.status === 201 && /^post-[a-z0-9]+$/.test(q3.slug), JSON.stringify(j).slice(0, 200));
    r = await po("");
    j = await r.json();
    const e1 = j.posts.find((x) => x.id === q1.id);
    check("posts: index entry has reading time + status", j.posts.length === 3 && e1.readMin === 2 && e1.status === "draft" && e1.excerpt.length > 10, JSON.stringify(e1));
    r = await po("/" + q1.id, { token: userToken });
    check("posts: non-admin get -> 403", r.status === 403);
    r = await po("/" + q1.id);
    j = await r.json();
    check("posts: admin get -> post + terms", r.status === 200 && j.post.id === q1.id && j.terms.categories.length === 2);
    r = await po("/qnotthere1");
    check("posts: unknown id -> 404", r.status === 404);
    r = await po("/p1234567");
    check("posts: page id in posts route -> 404", r.status === 404);

    // save
    const edit = { title: q1.title, slug: q1.slug, excerpt: "ছোট সারাংশ", image: "", imageAlt: "", categories: q1.categories, tags: q1.tags, author: q1.author, date: "", seo: q1.seo, blocks: q1.blocks };
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, version: 1 } });
    j = await r.json();
    check("posts: save -> v2", r.status === 200 && j.post.version === 2 && j.post.excerpt === "ছোট সারাংশ", JSON.stringify(j).slice(0, 200));
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, version: 1 } });
    j = await r.json();
    check("posts: stale save -> 409 with current post", r.status === 409 && j.error === "version_conflict" && j.post.version === 2);
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit } });
    check("posts: save without version -> 400", r.status === 400);
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, slug: q2.slug, version: 2 } });
    check("posts: save with another post's slug -> 400 taken", r.status === 400 && (await r.json()).reason === "taken");
    r = await po("/" + q1.id + "/undo", { method: "POST", body: { version: 2 } });
    j = await r.json();
    check("posts: undo -> previous excerpt", r.status === 200 && j.post.version === 3 && j.post.excerpt === "", JSON.stringify(j).slice(0, 200));
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, version: 3 } });
    check("posts: save again -> v4", r.status === 200);

    // publish
    r = await api("/posts/hello-blog-world");
    check("posts: no public JSON for drafts", r.status === 404);
    r = await po("/" + q1.id + "/publish", { method: "POST", body: {} });
    check("posts: publish without version -> 400", r.status === 400);
    r = await po("/" + q1.id + "/publish", { method: "POST", token: userToken, body: { version: 4 } });
    check("posts: non-admin publish -> 403", r.status === 403);
    r = await po("/" + q1.id + "/publish", { method: "POST", body: { version: 4 } });
    j = await r.json();
    const pub1 = j.post;
    check("posts: publish -> published, date set", r.status === 200 && pub1.status === "published" && pub1.publishedSlug === "hello-blog-world" && Date.parse(pub1.date) > Date.now() - 60000, JSON.stringify(j).slice(0, 200));
    check("posts: postpub + posts:public keys", listLocalKV("CONTENT", "postpub:").join() === "postpub:hello-blog-world" && listLocalKV("CONTENT", "posts:public").length === 1, listLocalKV("CONTENT").join());
    // scheduled
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    r = await po("/" + q2.id, { method: "PUT", body: { title: q2.title, slug: q2.slug, date: future, version: 1 } });
    check("posts: set future date", r.status === 200);
    r = await po("/" + q2.id + "/publish", { method: "POST", body: { version: 2 } });
    j = await r.json();
    check("posts: publish with future date keeps it (scheduled)", r.status === 200 && j.post.status === "published" && j.post.date === future);
    r = await po("");
    j = await r.json();
    check("posts: scheduled post computes to 'scheduled'", PO.postStatus(j.posts.find((x) => x.id === q2.id), Date.now()) === "scheduled" && PO.postStatus(j.posts.find((x) => x.id === q1.id)) === "published");
    // slug change while published -> redirect
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, slug: "hello-blog", version: 5 } });
    j = await r.json();
    check("posts: edit published -> changed flag in index", r.status === 200 && (await (await po("")).json()).posts.find((x) => x.id === q1.id).changed === true);
    r = await po("/" + q1.id + "/publish", { method: "POST", body: { version: 6 } });
    j = await r.json();
    check("posts: republish with new slug -> redirect left behind", r.status === 200 && j.post.redirects[0] === "hello-blog-world" && listLocalKV("CONTENT", "postredirect:").join() === "postredirect:hello-blog-world" && !listLocalKV("CONTENT", "postpub:").includes("postpub:hello-blog-world"), listLocalKV("CONTENT").join());
    r = await po("/" + q3.id + "/unpublish", { method: "POST", body: { version: 1 } });
    check("posts: unpublish a draft -> 409", r.status === 409);
    // duplicate
    r = await po("/" + q1.id + "/duplicate", { method: "POST", body: {} });
    j = await r.json();
    const q4 = j.post;
    check("posts: duplicate -> draft copy, fresh block ids, no date", r.status === 201 && q4.status === "draft" && q4.slug === "hello-blog-copy" && q4.title.endsWith("(কপি)") && q4.date === "" && q4.blocks[0].id !== q1.blocks[0].id && q4.categories[0] === cat1.id, JSON.stringify(j).slice(0, 300));
    // trash / restore / delete
    r = await po("/" + q4.id, { method: "DELETE" });
    check("posts: permanent delete outside trash -> 409", r.status === 409 && (await r.json()).error === "not_in_trash");
    r = await po("/" + q1.id + "/trash", { method: "POST", body: { version: 7 } });
    j = await r.json();
    check("posts: trash a published post -> taken down", r.status === 200 && j.post.status === "trash" && listLocalKV("CONTENT", "postpub:").length === 1 && listLocalKV("CONTENT", "postredirect:").length === 0, listLocalKV("CONTENT").join());
    r = await po("/" + q1.id, { method: "PUT", body: { ...edit, version: 8 } });
    check("posts: editing a trashed post -> 409", r.status === 409);
    r = await po("/" + q1.id + "/restore", { method: "POST", body: {} });
    j = await r.json();
    check("posts: restore -> draft", r.status === 200 && j.post.status === "draft" && j.post.trashedAt === "");
    // bulk
    r = await po("/bulk", { method: "POST", body: { action: "explode", ids: [q1.id] } });
    check("posts: bulk bad action -> 400", r.status === 400);
    r = await po("/bulk", { method: "POST", body: { action: "trash", ids: [] } });
    check("posts: bulk empty ids -> 400", r.status === 400);
    r = await po("/bulk", { method: "POST", token: userToken, body: { action: "trash", ids: [q1.id] } });
    check("posts: non-admin bulk -> 403", r.status === 403);
    r = await po("/bulk", { method: "POST", body: { action: "publish", ids: [q1.id, q3.id, "qmissing01"] } });
    j = await r.json();
    check("posts: bulk publish (missing id reported)", r.status === 200 && j.done.length === 2 && j.failed.length === 1 && j.failed[0].id === "qmissing01" && listLocalKV("CONTENT", "postpub:").length === 3, JSON.stringify(j).slice(0, 300));
    r = await po("/bulk", { method: "POST", body: { action: "unpublish", ids: [q3.id, q4.id] } });
    j = await r.json();
    check("posts: bulk unpublish (draft reported as not_published)", j.done.length === 1 && j.failed[0].error === "not_published");
    r = await po("/bulk", { method: "POST", body: { action: "delete", ids: [q4.id] } });
    j = await r.json();
    check("posts: bulk delete outside trash refused", j.done.length === 0 && j.failed[0].error === "not_in_trash");
    // media usedBy
    r = await upload(PNG, "post.png", "image/png");
    const mItem = (await r.json()).item;
    r = await po("/" + q4.id, { method: "PUT", body: { title: q4.title, slug: q4.slug, image: mItem.url, version: q4.version } });
    check("posts: featured image from media library", r.status === 200 && (await r.json()).post.image === mItem.url);
    r = await api("/admin/media", { token: adminToken });
    j = await r.json();
    const mi = j.items.find((x) => x.key === mItem.key);
    check("media: usedBy lists the post", mi && mi.usedBy.length === 1 && mi.usedBy[0].kind === "post" && mi.usedBy[0].id === q4.id, JSON.stringify(mi));
    r = await api("/admin/media/" + mItem.key, { method: "DELETE", token: adminToken });
    j = await r.json();
    check("media: delete in use by a post -> 409 with usedBy", r.status === 409 && j.error === "in_use" && j.usedBy[0].id === q4.id, JSON.stringify(j));
    r = await api("/admin/media/" + mItem.key + "?force=1", { method: "DELETE", token: adminToken });
    check("media: forced delete", r.status === 200);
    // term delete -> posts keep working
    r = await po("/terms/" + cat1.id, { method: "DELETE" });
    j = await r.json();
    check("posts: delete category reports usage", r.status === 200 && j.posts >= 1 && !j.terms.categories.some((x) => x.id === cat1.id), JSON.stringify(j));
    r = await po("/" + q4.id, { method: "PUT", body: { title: q4.title, slug: q4.slug, categories: [cat1.id], version: q4.version + 1 } });
    j = await r.json();
    check("posts: saving with a deleted category drops it silently", r.status === 200 && j.post.categories.length === 0, JSON.stringify(j).slice(0, 200));
    // cleanup -> no keys left
    r = await po("/bulk", { method: "POST", body: { action: "trash", ids: [q1.id, q2.id, q3.id, q4.id] } });
    j = await r.json();
    check("posts: bulk trash all", j.done.length === 4 && listLocalKV("CONTENT", "postpub:").length === 0 && listLocalKV("CONTENT", "posts:public").length === 0, listLocalKV("CONTENT").join());
    r = await po("/bulk", { method: "POST", body: { action: "delete", ids: [q1.id, q2.id, q3.id, q4.id] } });
    j = await r.json();
    check("posts: bulk delete from trash", j.done.length === 4 && j.posts.length === 0);
    for (const t of [cat2, tag1]) await po("/terms/" + t.id, { method: "DELETE" });
    const leftQ = listLocalKV("CONTENT").filter((k) => /^(post:|posts:|postpub:|postredirect:)/.test(k));
    check("posts: no post keys left", leftQ.length === 0, leftQ.join());
  }

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
