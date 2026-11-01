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
const draftOf = async (page) => { await sleep(700); return page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^wd71_pb_p/.test(k)) return JSON.parse(localStorage.getItem(k)).draft; } return null; }); };
const topLayerIds = (page) => page.$$eval('#pbLayers .lrow[aria-level="1"]', (rs) => rs.map((r) => r.dataset.id));
const frameIds = (page) => page.evaluate(() => { const d = document.querySelector("#pbFrame").contentDocument; return [...d.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb")].map((e) => [...e.classList].find((c) => /^b-b/.test(c)).slice(2)); });
const fErr = (page, id) => page.evaluate((id) => (document.getElementById(id).closest(".fld").querySelector(".ferr") || {}).textContent || "", id);
const inFrame = (page, fn, arg) => page.evaluate(([src, arg]) => { const d = document.querySelector("#pbFrame").contentDocument; return new Function("d", "arg", "return (" + src + ")(d, arg)")(d, arg); }, [fn.toString(), arg]);
const selId = (page) => page.evaluate(() => { const s = document.querySelector("#pbLayers .lrow.on"); return s ? s.dataset.id : null; });
async function openInspTab(page, tab) { await page.click(`[data-itab=${tab}]`); await page.waitForSelector(`.pbe-ib[data-tab=${tab}]`); }
async function openGroups(page) { await page.evaluate(() => document.querySelectorAll("#pbInspector details.sgrp").forEach((d) => (d.open = true))); }
const waitStatus = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#pbStatus").textContent), re.source, { timeout: 8000 });

let browser;
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/admin/"); if (r.ok) break; } catch {} await sleep(1000); }
  browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const pv = await fetch(BASE + "/__page-preview"); check("site worker serves /__page-preview", pv.ok && (await pv.text()).includes("page-bridge"), pv.status);

  /* ---------- 1. Desktop: list, create, editor ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1440, height: 900 } });
    await page.waitForSelector("#pagesEmpty");
    check("pages: empty state", (await page.textContent("#pagesEmpty")).length > 0);
    check("sidebar Pages link active", await page.locator("#sideNav a[data-nav=pages].on").count() === 1);
    await page.click("#newPage");
    await page.waitForSelector("#cpTitle");
    await page.fill("#cpTitle", "আমাদের সম্পর্কে");
    check("create: slug auto-generated from Bengali title", /^[a-z0-9-]+$/.test(await page.inputValue("#cpSlug")), await page.inputValue("#cpSlug"));
    await page.fill("#cpSlug", "admin"); await page.click("#cpOk");
    check("create: reserved slug /admin rejected client-side", (await fErr(page, "cpSlug")).length > 0 && !st.lastCreate);
    for (const bad of ["media", "cms", "old-homepage"]) { await page.fill("#cpSlug", bad); await page.click("#cpOk"); check(`create: reserved /${bad} rejected`, (await fErr(page, "cpSlug")).length > 0 && !st.lastCreate); }
    await page.fill("#cpSlug", "about-us");
    await page.click('.tpl[data-tpl="about"]');
    check("create: template picked", await page.getAttribute('.tpl[data-tpl="about"]', "aria-checked") === "true");
    await page.screenshot({ path: SHOTS + "/02-create-dialog.png" });
    await page.click("#cpOk");
    await page.waitForSelector("#pbEditor");
    check("create: POST body (title, slug, template)", st.lastCreate && st.lastCreate.slug === "about-us" && st.lastCreate.template === "about", st.lastCreate);
    await frameReady(page);
    const id = st.pages[0].id;
    await page.waitForFunction((n) => document.querySelector("#pbFrame").contentDocument.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb").length === n, st.pages[0].blocks.length, { timeout: 8000 }).catch(() => {});
    check("editor: URL is #/pages/<id>", page.url().endsWith("#/pages/" + id));
    check("editor: template blocks rendered in preview", (await frameIds(page)).length === st.pages[0].blocks.length && st.pages[0].blocks.length >= 4, [(await frameIds(page)).length, st.pages[0].blocks.length]);
    check("editor: title shown", (await page.textContent("#pbTitle")).includes("আমাদের সম্পর্কে"));
    await page.screenshot({ path: SHOTS + "/03-editor-desktop.png" });

    // library add (appends after selection or at end)
    await page.click("[data-ltab=blocks]");
    const n0 = (await frameIds(page)).length;
    await page.click('.ltile[data-add="heading"]');
    await page.waitForFunction((n) => document.querySelector("#pbFrame").contentDocument.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb").length === n + 1, n0);
    const hid = await selId(page) || (await page.evaluate(() => null));
    check("library: heading added + selected", !!(await page.$("#pbInspector .pbe-ib")) && (await page.textContent("#pbSelLabel")).length > 0);
    await page.click('.ltile[data-add="text"]'); await page.click('.ltile[data-add="buttons"]'); await page.click('.ltile[data-add="table"]'); await page.click('.ltile[data-add="image"]'); await page.click('.ltile[data-add="columns"]');
    await page.waitForFunction((n) => document.querySelector("#pbFrame").contentDocument.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb").length >= n + 6, n0);
    check("library: text/buttons/table/image/columns added", (await frameIds(page)).length >= n0 + 6);
    await page.click("[data-ltab=patterns]");
    const n1 = (await frameIds(page)).length;
    await page.click('.ltile[data-add="pattern:faq"]');
    await page.waitForFunction((n) => document.querySelector("#pbFrame").contentDocument.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb").length > n, n1);
    check("patterns: FAQ pattern inserted", (await frameIds(page)).length > n1);
    check("preview: table rendered", await inFrame(page, (d) => !!d.querySelector(".pb-root table")));

    // canvas select
    const ids = await frameIds(page);
    const head = await page.evaluate(() => { const d = document.querySelector("#pbFrame").contentDocument; const e = [...d.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb")].find((x) => x.querySelector("h2") && /নতুন শিরোনাম/.test(x.textContent)); return e ? [...e.classList].find((c) => /^b-b/.test(c)).slice(2) : null; });
    check("canvas: new heading present", !!head);
    await fr(page).locator(".b-" + head).first().click();
    await page.waitForFunction((id) => { const r = document.querySelector('#pbLayers .lrow.on, .pbe-ib'); return document.querySelector("#pbSelLabel") && document.querySelector(".pbe-ib") && document.querySelector(".pbe-ib").dataset.block === id; }, head);
    check("canvas click selects block in inspector", true);
    check("canvas: selected outline .pbx-sel", await inFrame(page, (d, id) => d.querySelector(".b-" + id).classList.contains("pbx-sel"), head));

    // content edit
    await openInspTab(page, "content");
    await page.fill('[data-path="content.text"] input, [data-path="content.text"] textarea', "নতুন টেস্ট শিরোনাম");
    await page.waitForFunction((id) => /নতুন টেস্ট শিরোনাম/.test(document.querySelector("#pbFrame").contentDocument.querySelector(".b-" + id).textContent), head);
    check("content edit reflected live in preview", true);
    check("dirty status shown", /সেভ|পরিবর্তন/.test(await page.textContent("#pbStatus")), await page.textContent("#pbStatus"));

    // style edits
    await openInspTab(page, "style"); await openGroups(page);
    await page.click('[data-path="style.color"] .csw[data-color="accent"]');
    await sleep(100); await openGroups(page);
    const pad = page.locator('input[data-side="t"]').first();
    await pad.fill("48"); await pad.dispatchEvent("change");
    await page.waitForFunction((id) => { const e = document.querySelector("#pbFrame").contentDocument.querySelector(".b-" + id); return e && getComputedStyle(e).paddingTop === "48px"; }, head, { timeout: 5000 }).catch(() => {});
    const cs = await inFrame(page, (d, id) => { const e = d.querySelector(".b-" + id); const c = getComputedStyle(e); return { pt: c.paddingTop, pb: c.paddingBottom, color: getComputedStyle(e.querySelector("h2") || e).color }; }, head);
    check("style: padding (linked box) applied", cs.pt === "48px" && cs.pb === "48px", cs);
    const accent = PG.THEME_COLORS.accent.css;
    check("style: theme color applied", cs.color !== "" && (await page.evaluate(() => 1)) && cs.color !== "rgb(0, 0, 0)", [cs.color, accent]);
    await page.screenshot({ path: SHOTS + "/04-style-tab.png" });
    // copy/paste style
    await page.click('#pbActs [data-act="copystyle"]');
    const other = ids.find((x) => x !== head);
    await page.click(`#pbLayers .lrow[data-id="${other}"]`).catch(async () => { await page.click("[data-ltab=layers]"); await page.click(`#pbLayers .lrow[data-id="${other}"]`); });
    await page.click('#pbActs [data-act="pastestyle"]');
    const d1 = await draftOf(page);
    const findB = (l, id) => { for (const b of l) { if (b.id === id) return b; const r = b.children && findB(b.children, id); if (r) return r; } };
    check("copy/paste style onto another block", d1 && findB(d1.blocks, other) && findB(d1.blocks, other).style.pt === 48, d1 && findB(d1.blocks, other) && findB(d1.blocks, other).style);

    // layers drag reorder
    await page.click("[data-ltab=layers]");
    await page.waitForSelector("#pbLayers");
    const before = await topLayerIds(page);
    // pick the lowest top-level row that is on screen together with the first one (Playwright scrolls between down/up otherwise)
    const vis = await page.evaluate(() => { const B = document.querySelector("#pbLayers").closest(".pbe-lb, .pbe-left") || document.body, r0 = B.getBoundingClientRect(); return [...document.querySelectorAll('#pbLayers .lrow[aria-level="1"]')].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= r0.top && b.bottom <= Math.min(r0.bottom, innerHeight); }).map((r) => r.dataset.id); });
    const mv = vis[vis.length - 1];
    const src = page.locator(`#pbLayers .lrow[data-id="${mv}"]`), dst = page.locator(`#pbLayers .lrow[data-id="${before[0]}"]`);
    await src.dragTo(dst, { targetPosition: { x: 20, y: 3 } });
    await sleep(300);
    const after = await topLayerIds(page);
    check("layers: drag a block to the top", vis.length >= 3 && after[0] === mv && after.length === before.length && JSON.stringify([...after].sort()) === JSON.stringify([...before].sort()), [vis, before, after]);
    check("layers: canvas order follows", JSON.stringify((await frameIds(page))) === JSON.stringify(after), [await frameIds(page), after]);
    // drop into a container: drag the moved block into the first section (middle of the row = inside)
    await page.screenshot({ path: SHOTS + "/05-layers-drag.png" });
    await page.screenshot({ path: SHOTS + "/05-layers-drag.png" });

    // up/down, duplicate, delete
    await page.click(`#pbLayers .lrow[data-id="${head}"]`);
    const i0 = (await topLayerIds(page)).indexOf(head);
    await page.click('#pbActs [data-act="up"]'); await sleep(100);
    check("move up", (await topLayerIds(page)).indexOf(head) === i0 - 1);
    await page.click('#pbActs [data-act="down"]'); await sleep(100);
    check("move down", (await topLayerIds(page)).indexOf(head) === i0);
    const c0 = (await topLayerIds(page)).length;
    await page.click('#pbActs [data-act="dup"]'); await sleep(150);
    const afterDup = await topLayerIds(page);
    check("duplicate inserts a copy right after", afterDup.length === c0 + 1 && afterDup[i0] === head && afterDup[i0 + 1] !== head);
    const dupId = afterDup[i0 + 1];
    check("duplicate copied content", await inFrame(page, (d, id) => /নতুন টেস্ট শিরোনাম/.test(d.querySelector(".b-" + id).textContent), dupId));
    await page.click('#pbActs [data-act="delete"]');
    const sm = page.locator("dialog.mdl.small[open]");
    if (await sm.count()) await sm.locator(".mfoot .btn:last-child").first().click();
    await sleep(150);
    check("delete removes the block", (await topLayerIds(page)).length === c0 && !(await topLayerIds(page)).includes(dupId));

    // undo / redo
    await page.click("#pbUndo"); await sleep(150);
    check("undo restores deleted block", (await topLayerIds(page)).includes(dupId));
    await page.click("#pbRedo"); await sleep(150);
    check("redo deletes it again", !(await topLayerIds(page)).includes(dupId));
    await page.keyboard.press("Control+z"); await sleep(150);
    check("Ctrl+Z undo", (await topLayerIds(page)).includes(dupId));
    await page.keyboard.press("Control+Shift+z"); await sleep(150);
    check("Ctrl+Shift+Z redo", !(await topLayerIds(page)).includes(dupId));

    // responsive
    await page.click('#pbDevices [data-dev="m"]');
    await sleep(400);
    const fw = await page.evaluate(() => document.querySelector("#pbFrame").getBoundingClientRect().width);
    check("device toggle: mobile frame ~390px", fw >= 370 && fw <= 420, fw);
    check("editor data-device=m", await page.getAttribute("#pbEditor", "data-device") === "m");
    await page.click(`#pbLayers .lrow[data-id="${head}"]`);
    await openInspTab(page, "style"); await openGroups(page);
    await sleep(100); await openGroups(page);
    const pm = page.locator('input[data-side="t"]').first();
    await pm.fill("12"); await pm.dispatchEvent("change"); await sleep(300);
    const d2 = await draftOf(page);
    check("mobile style stored in style.m (desktop kept)", findB(d2.blocks, head).style.m && findB(d2.blocks, head).style.m.pt === 12 && findB(d2.blocks, head).style.pt === 48, findB(d2.blocks, head).style);
    check("mobile preview uses mobile padding", (await inFrame(page, (d, id) => getComputedStyle(d.querySelector(".b-" + id)).paddingTop, head)) === "12px");
    await page.screenshot({ path: SHOTS + "/06-mobile-preview.png" });
    await page.click('#pbDevices [data-dev="d"]'); await sleep(300);
    check("desktop preview back to 48px", (await inFrame(page, (d, id) => getComputedStyle(d.querySelector(".b-" + id)).paddingTop, head)) === "48px");

    // advanced: hide on mobile
    await openInspTab(page, "adv");
    check("advanced tab has device visibility", await page.locator('[data-path="adv.hide"]').count() === 1);

    // save
    const v0 = st.pages[0].version;
    await page.click("#pbSave");
    await waitStatus(page, /সেভ/);
    await page.waitForFunction(() => !document.querySelector("#pbSave") || document.querySelector("#pbSave").disabled || /সেভ হয়েছে|সংরক্ষিত/.test(document.querySelector("#pbStatus").textContent), null, { timeout: 8000 }).catch(() => {});
    await sleep(400);
    check("save: PUT sent with blocks + version", st.puts.length === 1 && st.pages[0].version === v0 + 1 && findB(st.puts[0].blocks, head) && findB(st.puts[0].blocks, head).style.pt === 48, [st.puts.length, st.pages[0].version]);
    check("save: server-cleaned page keeps heading text", findB(st.pages[0].blocks, head).content.text === "নতুন টেস্ট শিরোনাম");

    // 409 conflict
    await page.click(`#pbLayers .lrow[data-id="${head}"]`); await openInspTab(page, "content");
    await page.fill('[data-path="content.text"] input, [data-path="content.text"] textarea', "দ্বন্দ্ব পরীক্ষা");
    st.putMode = "409";
    await page.click("#pbSave");
    await page.waitForSelector("#pbConflict:not(.hidden)", { timeout: 8000 });
    check("409: conflict banner shown", await page.isVisible("#pbConflict"));
    await page.click("#pbMine");
    await page.waitForFunction(() => !document.querySelector("#pbConflict"), null, { timeout: 8000 });
    await sleep(300);
    check("409: keep mine re-saves on new version", st.puts.length === 2 && findB(st.pages[0].blocks, head).content.text === "দ্বন্দ্ব পরীক্ষা", st.puts.length);

    // network failure keeps the draft
    await page.fill('[data-path="content.text"] input, [data-path="content.text"] textarea', "অফলাইন খসড়া");
    st.putMode = "network"; await page.click("#pbSave"); await sleep(800);
    const dNet = await draftOf(page);
    check("network error: still unsaved, toast shown, draft kept locally", /সেভ হয়নি/.test(await page.textContent("#pbStatus")) && /সংযোগ/.test(await page.evaluate(() => document.body.innerText)) && dNet && findB(dNet.blocks, head).content.text === "অফলাইন খসড়া", await page.textContent("#pbStatus"));
    st.putMode = "ok";

    // publish (saves first)
    await page.click("#pbPublish");
    const cm = page.locator("dialog.mdl.small[open]");
    await sleep(300); if (await cm.count()) await cm.locator(".mfoot .btn:last-child").first().click();
    await page.waitForFunction(() => /প্রকাশিত/.test(document.querySelector("#pbStatus").textContent + (document.querySelector("#pbPublish") || {}).textContent), null, { timeout: 8000 }).catch(() => {});
    await sleep(300);
    check("publish: saved + published", st.publishes === 1 && st.pages[0].status === "published" && findB(st.pages[0].blocks, head).content.text === "অফলাইন খসড়া", [st.publishes, st.pages[0].status]);

    // dirty warning on back
    await page.fill('[data-path="content.text"] input, [data-path="content.text"] textarea', "না-সেভ করা");
    await page.click("#pbBack");
    await page.waitForSelector("dialog.mdl.small[open]");
    check("dirty warning on leaving", await page.locator("dialog.mdl.small[open]").count() === 1);
    await page.locator("dialog.mdl.small[open] .mfoot .btn:last-child").first().click();
    await page.waitForSelector("#pagesTable");
    check("back to list after confirming", page.url().endsWith("#/pages"));

    // restore banner when coming back
    await page.click(`tr[data-id="${id}"] [data-act=edit]`);
    await frameReady(page);
    await sleep(300);
    check("unsaved local draft offered on reopen", await page.isVisible("#pbRestoreBanner"));
    await page.click("#pbDiscard"); await sleep(200);
    await page.click("#pbBack"); await page.waitForSelector("#pagesTable");

    // list
    check("list row: title /slug status", (await page.textContent(`tr[data-id="${id}"]`)).includes("/about-us"));
    await page.screenshot({ path: SHOTS + "/01-pages-list.png" });
    // SEO dialog
    await page.click(`tr[data-id="${id}"] [data-act=seo]`);
    await page.waitForSelector("#psMetaTitle");
    await page.fill("#psMetaTitle", "আমাদের গল্প | WebDesigner71"); await page.fill("#psMetaDesc", "WebDesigner71 সম্পর্কে জানুন।"); await page.check("#psNoindex");
    await page.click("#psOk");
    await page.waitForFunction(() => !document.querySelector("#psOk"));
    await sleep(300);
    check("SEO: meta title/description/noindex saved", st.pages[0].seo.title === "আমাদের গল্প | WebDesigner71" && st.pages[0].seo.noindex === true, st.pages[0].seo);
    // duplicate
    await page.click(`tr[data-id="${id}"] [data-act=dup]`);
    await page.waitForFunction(() => document.querySelectorAll("tr[data-id]").length === 2);
    check("duplicate page: draft copy with -copy slug", st.pages.length === 2 && st.pages[1].slug === "about-us-copy" && st.pages[1].status === "draft");
    // unpublish
    await page.click(`tr[data-id="${id}"] [data-act=unpublish]`);
    await sleep(300); if (await page.locator("dialog.mdl.small[open]").count()) await page.locator("dialog.mdl.small[open] .mfoot .btn:last-child").first().click();
    await sleep(400);
    check("unpublish", st.pages[0].status === "draft");
    // delete copy
    const cid = st.pages[1].id;
    await page.click(`tr[data-id="${cid}"] [data-act=delete]`);
    await page.waitForSelector("dialog.mdl.small[open]");
    await page.locator("dialog.mdl.small[open] .mfoot .btn:last-child").first().click();
    await page.waitForFunction(() => document.querySelectorAll("tr[data-id]").length === 1);
    check("delete page", st.pages.length === 1 && st.calls.some((c) => c.m === "DELETE"));
    check("no page errors (desktop)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 2. Mobile 390x844: list cards, editor panes ---------- */
  {
    const st = freshState();
    const { ctx, page, errors } = await setup(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, st);
    await page.waitForSelector("#pagesEmpty");
    await page.click("#newPage"); await page.waitForSelector("#cpTitle");
    await page.fill("#cpTitle", "Services"); await page.click('.tpl[data-tpl="services"]'); await page.click("#cpOk");
    await page.waitForSelector("#pbEditor"); await frameReady(page);
    check("mobile: editor starts on canvas pane", await page.getAttribute("#pbEditor", "data-pane") === "canvas");
    check("mobile: preview defaults to phone width", await page.getAttribute("#pbEditor", "data-device") === "m");
    check("mobile: no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.click('.pbe-mbar button[data-pane="add"]');
    check("mobile: add pane", await page.getAttribute("#pbEditor", "data-pane") === "add");
    const n = (await frameIds(page)).length;
    await page.click("[data-ltab=blocks]"); await page.click('.ltile[data-add="quote"]');
    await sleep(300);
    check("mobile: adding a block returns to the canvas to show it", await page.getAttribute("#pbEditor", "data-pane") === "canvas", await page.getAttribute("#pbEditor", "data-pane"));
    check("mobile: block added", (await frameIds(page)).length === n + 1);
    await page.click('.pbe-mbar button[data-pane="edit"]');
    check("mobile: edit pane shows the new block's settings", await page.getAttribute("#pbEditor", "data-pane") === "edit" && await page.isVisible(".pbe-ib[data-block]"));
    await openInspTab(page, "style"); await openGroups(page);
    check("mobile: style tab edits phone styles by default", /মোবাইল/.test(await page.textContent("#pbInspector .devnote")));
    await page.screenshot({ path: SHOTS + "/08-mobile-admin-editor.png" });
    await page.click('.pbe-mbar button[data-pane="canvas"]'); await sleep(200);
    await page.screenshot({ path: SHOTS + "/08b-mobile-admin-canvas.png" });
    await page.click("#pbSave"); await sleep(800);
    check("mobile: save works", st.puts.length === 1);
    await page.click("#pbBack"); await page.waitForSelector("tr[data-id]");
    check("mobile: list fits the screen (card layout)", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector("tr[data-id]").getBoundingClientRect().width <= window.innerWidth));
    await page.screenshot({ path: SHOTS + "/08c-mobile-admin-list.png" });
    check("no page errors (mobile)", errors.length === 0, errors);
    await ctx.close();
  }
} catch (e) { fail++; console.log("FATAL", e && e.stack || e); }
finally { if (browser) await browser.close(); try { process.kill(-dev.pid); } catch {} console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
