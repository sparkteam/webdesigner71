// Headless UI test of the Phase 3 page builder (pages list, create dialog, full-screen editor, list actions, mobile).
// Run from the repo root with playwright-core resolvable and wrangler on PATH: node site-worker/test/pages-ui.mjs  (SHOTS=<dir>, CHROME=<path> optional).
// The admin API is mocked with a stateful in-memory backend built on the real shared page model (public/cms/pages.js).
// No real KV is touched; /admin/, /__page-preview and /cms/* are served by a local `wrangler dev` of the site worker.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PG = await import(new URL("../../public/cms/pages.js", import.meta.url));
const M = await import(new URL("../../public/cms/model.js", import.meta.url));

const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`, SHOTS = process.env.SHOTS || join(tmpdir(), "cms3_shots");
mkdirSync(SHOTS, { recursive: true });
const persist = mkdtempSync(join(tmpdir(), "wd71ui3-"));
const dev = spawn("wrangler", ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore", detached: true });
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + JSON.stringify(x).slice(0, 400)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function freshState() {
  const at = "2026-11-01T17:07:49.000Z";
  return { pages: [], calls: [], putMode: "ok", puts: [], publishes: 0,
    sections: M.SECTION_IDS.map((id) => ({ ...M.DEFAULTS[id], version: 1, updatedAt: at, updatedBy: "seed" })),
    settings: { ...M.DEFAULT_SETTINGS, version: 1, updatedAt: at, updatedBy: "seed" } };
}
const now = () => new Date().toISOString();
function mockApi(ctx, st) {
  return ctx.route("https://api.webdesigner71.com/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method(), p = url.pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" } });
    st.calls.push({ m, path: p });
    const body = () => JSON.parse(req.postData() || "{}");
    const bad = (e) => json(400, { error: "invalid", field: e.field, reason: e.reason });
    const taken = (slug, id) => st.pages.some((x) => x.id !== id && (x.slug === slug || x.publishedSlug === slug));
    if (p === "/me") return json(200, { user: { email: "admin@example.com", name: "Admin", isAdmin: true, status: "approved" } });
    if (p === "/admin/users") return json(200, { users: [{ email: "admin@example.com", name: "Admin", status: "approved", isAdmin: true, createdAt: "2026-10-20T10:00:00Z" }] });
    if (p === "/content/homepage") return json(200, { schema: M.SCHEMA, source: "kv", sections: st.sections, settings: st.settings });
    if (p === "/admin/settings" && m === "GET") return json(200, { settings: st.settings });
    if (p === "/admin/media" && m === "GET") return json(200, { storage: "kv", maxBytes: M.MEDIA_MAX_BYTES, types: Object.keys(M.MEDIA_TYPES), items: [], builtin: M.BUILTIN_MEDIA });
    if (p === "/admin/pages" && m === "GET") return json(200, { pages: st.pages.map(PG.indexEntry), limits: PG.LIMITS, reserved: PG.RESERVED_SLUGS });
    if (p === "/admin/pages" && m === "POST") {
      const b = body(); let raw = b;
      if (b.template !== undefined) { if (!PG.TEMPLATES[b.template]) return json(400, { error: "invalid", field: "template", reason: "enum" }); raw = { ...b, blocks: PG.TEMPLATES[b.template].build((b.title || "").trim()) }; delete raw.template; }
      let c; try { c = PG.cleanPageInput(raw); } catch (e) { return bad(e); }
      if (taken(c.slug, null)) return json(400, { error: "invalid", field: "slug", reason: "taken" });
      const doc = { schema: 1, id: PG.newPageId(), ...c, status: "draft", version: 1, createdAt: now(), updatedAt: now(), updatedBy: "admin@example.com", publishedAt: null, publishedVersion: 0, publishedSlug: "", redirects: [] };
      st.pages.push(doc); st.lastCreate = b; return json(201, { ok: true, page: doc });
    }
    const pm = p.match(/^\/admin\/pages\/(p[a-z0-9]+)(?:\/(publish|unpublish|duplicate|undo))?$/);
    if (pm) {
      const i = st.pages.findIndex((x) => x.id === pm[1]); if (i < 0) return json(404, { error: "not_found" });
      const cur = st.pages[i], act = pm[2];
      if (!act && m === "GET") return json(200, { page: cur });
      if (!act && m === "PUT") {
        if (st.putMode === "network") return route.abort("failed");
        if (st.putMode === "409") { st.putMode = "ok"; st.pages[i] = { ...cur, title: cur.title + " (অন্য কেউ)", version: cur.version + 1, updatedBy: "other@example.com" }; return json(409, { error: "version_conflict", page: st.pages[i] }); }
        const { version, ...rest } = body();
        if (version !== cur.version) return json(409, { error: "version_conflict", page: cur });
        let c; try { c = PG.cleanPageInput(rest); } catch (e) { return bad(e); }
        if (taken(c.slug, cur.id)) return json(400, { error: "invalid", field: "slug", reason: "taken" });
        st.pages[i] = { ...cur, ...c, version: cur.version + 1, updatedAt: now() }; st.puts.push(rest);
        await sleep(150); return json(200, { ok: true, page: st.pages[i] });
      }
      if (act === "publish") {
        if (body().version !== cur.version) return json(409, { error: "version_conflict", page: cur });
        const v = cur.version + 1; st.publishes++;
        st.pages[i] = { ...cur, status: "published", version: v, publishedVersion: v, publishedSlug: cur.slug, publishedAt: now(), updatedAt: now() };
        return json(200, { ok: true, page: st.pages[i] });
      }
      if (act === "unpublish") {
        if (body().version !== cur.version) return json(409, { error: "version_conflict", page: cur });
        st.pages[i] = { ...cur, status: "draft", version: cur.version + 1, publishedSlug: "", redirects: [], updatedAt: now() };
        return json(200, { ok: true, page: st.pages[i] });
      }
      if (act === "duplicate") {
        let s = cur.slug + "-copy", n = 2; while (taken(s, null)) s = cur.slug + "-copy-" + n++;
        const doc = { ...cur, ...PG.cleanPageInput({ title: cur.title + " (কপি)", slug: s, seo: cur.seo, blocks: cur.blocks.map(PG.cloneBlock) }), id: PG.newPageId(), status: "draft", version: 1, publishedVersion: 0, publishedSlug: "", publishedAt: null, redirects: [] };
        st.pages.push(doc); return json(201, { ok: true, page: doc });
      }
      if (!act && m === "DELETE") {
        const v = url.searchParams.get("version"); if (v !== null && Number(v) !== cur.version) return json(409, { error: "version_conflict", page: cur });
        st.pages.splice(i, 1); return json(200, { ok: true, deleted: cur.id });
      }
    }
    return json(404, { error: "not_found" });
  });
}
async function setup(browser, ctxOpts, st = freshState(), hash = "#/pages") {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.route("https://accounts.google.com/**", (r) => r.abort());
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await ctx.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await ctx.route(BASE + "/media/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await ctx.addInitScript(() => sessionStorage.setItem("wd71_admin_token", "test-token"));
  await mockApi(ctx, st);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => { if (msg.type() === "error" && !/accounts\.google|fonts\.g|ERR_FAILED|Failed to load resource/.test(msg.text())) errors.push("console: " + msg.text()); });
  await page.goto(BASE + "/admin/" + hash);
  return { ctx, page, st, errors };
}
const fr = (page) => page.frameLocator("#pbFrame");
const frameReady = (page) => page.waitForFunction(() => { const f = document.querySelector("#pbFrame"); return f && f.contentDocument && f.contentDocument.querySelector("main#top .pb-root"); });
const draftOf = (page) => page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("wd71_pb_")) return JSON.parse(localStorage.getItem(k)); } return null; });
const layerIds = (page) => page.$$eval("#pbLayers > .lrow, #pbLayers .lrow", (rs) => rs.map((r) => r.dataset.id));
const topLayerIds = (page) => page.evaluate(() => [...document.querySelectorAll("#pbLayers .lrow")].filter((r) => !r.parentElement.closest(".lrow, .lkids")).map((r) => r.dataset.id));
const frameIds = (page) => page.evaluate(() => { const d = document.querySelector("#pbFrame").contentDocument; return [...d.querySelectorAll(".pb-root > .pb")].map((e) => [...e.classList].find((c) => /^b-b/.test(c)).slice(2)); });
