// Headless UI test of the Phase 2 admin (sidebar, section editors, media, settings, mobile drawer).
// Run from the repo root with playwright-core resolvable (e.g. `npm i --no-save playwright-core`) and wrangler on PATH: node site-worker/test/admin-ui.mjs  (SHOTS=<dir>, CHROME=<path> optional).
// API + session are mocked with a stateful in-memory backend built on the real shared model. No real KV writes.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const M = await import(new URL("../../public/cms/model.js", import.meta.url));

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`, SHOTS = process.env.SHOTS || join(tmpdir(), "cms2_shots");
const persist = mkdtempSync(join(tmpdir(), "wd71ui2-"));
const dev = spawn("wrangler", ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore", detached: true });
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + JSON.stringify(x).slice(0, 400)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function freshState() {
  const at = "2026-11-01T17:07:49.000Z";
  return {
    sections: M.SECTION_IDS.map((id) => ({ ...M.DEFAULTS[id], version: 1, updatedAt: at, updatedBy: "seed" })),
    prev: {}, settings: { ...M.DEFAULT_SETTINGS, version: 1, updatedAt: at, updatedBy: "seed" }, settingsPrev: null,
    media: [], calls: [], putMode: "ok", n: 0,
  };
}
function usage(st, url) {
  const used = [];
  const walk = (v, p) => { if (typeof v === "string") { if (v === url) used.push(p); return; } if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + "." + (x && x.id ? x.id : i))); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? p + "." + k : k); };
  for (const s of st.sections) { walk(s.fields, s.id); walk(s.extra, s.id + ".extra"); }
  return used;
}
const pubMedia = (st, it) => ({ ...it, usedIn: usage(st, it.url) });
function mockApi(ctx, st) {
  return ctx.route("https://api.webdesigner71.com/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method(), p = url.pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" } });
    st.calls.push({ m, path: p, body: m === "POST" && p === "/admin/media" ? "<multipart>" : req.postData() });
    if (p === "/me") return json(200, { user: { email: "admin@example.com", name: "Admin", isAdmin: true, status: "approved" } });
    if (p === "/admin/users") return json(200, { users: [
      { email: "admin@example.com", name: "Admin", status: "approved", isAdmin: true, createdAt: "2026-10-20T10:00:00Z" },
      { email: "pending@example.com", name: "Pending User", status: "pending", createdAt: "2026-10-30T10:00:00Z" }] });
    if (p.startsWith("/admin/users/")) return json(200, { ok: true });
    if (p === "/content/homepage") return json(200, { schema: M.SCHEMA, source: "kv", sections: st.sections, settings: st.settings });
    const sm = p.match(/^\/admin\/content\/homepage\/sections\/([a-z]+)(\/undo)?$/);
    if (sm) {
      const i = st.sections.findIndex((s) => s.id === sm[1]); if (i < 0) return json(404, { error: "unknown_section" });
      const cur = st.sections[i], b = JSON.parse(req.postData() || "{}");
      if (sm[2]) {
        if (!st.prev[cur.id]) return json(404, { error: "no_previous" });
        const next = { ...st.prev[cur.id], version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: "admin@example.com" };
        st.prev[cur.id] = cur; st.sections[i] = next; return json(200, { ok: true, section: next });
      }
      if (st.putMode === "network") return route.abort("failed");
      if (st.putMode === "409") { st.putMode = "ok"; st.sections[i] = { ...cur, version: cur.version + 1 }; return json(409, { error: "version_conflict", section: st.sections[i] }); }
      if (st.putMode === "400") { st.putMode = "ok"; return json(400, { error: "invalid", field: st.badField }); }
      if (b.version !== cur.version) return json(409, { error: "version_conflict", section: cur });
      let clean; try { clean = M.cleanSection(cur.id, b); } catch (e) { return json(400, { error: "invalid", field: e.field }); }
      const next = { ...clean, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: "admin@example.com" };
      st.prev[cur.id] = cur; st.sections[i] = next; st.lastPut = { id: cur.id, body: b };
      await sleep(200);
      return json(200, { ok: true, section: next });
    }
    if (p === "/admin/settings" && m === "GET") return json(200, { settings: st.settings });
    if (p === "/admin/settings" && m === "PUT") {
      const b = JSON.parse(req.postData());
      if (b.version !== st.settings.version) return json(409, { error: "version_conflict", settings: st.settings });
      let clean; try { clean = M.cleanSettings(b); } catch (e) { return json(400, { error: "invalid", field: e.field }); }
      st.settingsPrev = st.settings; st.settings = { ...clean, version: st.settings.version + 1, updatedAt: new Date().toISOString(), updatedBy: "admin@example.com" };
      st.lastSettingsPut = b; return json(200, { ok: true, settings: st.settings });
    }
    if (p === "/admin/settings/undo") { if (!st.settingsPrev) return json(404, { error: "no_previous" }); const nx = { ...st.settingsPrev, version: st.settings.version + 1 }; st.settingsPrev = st.settings; st.settings = nx; return json(200, { ok: true, settings: nx }); }
    if (p === "/admin/media" && m === "GET") return json(200, { storage: "kv", maxBytes: M.MEDIA_MAX_BYTES, types: Object.keys(M.MEDIA_TYPES), items: st.media.map((x) => pubMedia(st, x)), builtin: M.BUILTIN_MEDIA });
    if (p === "/admin/media" && m === "POST") {
      const raw = req.postDataBuffer() || Buffer.alloc(0), txt = raw.toString("latin1");
      const name = (txt.match(/filename="([^"]+)"/) || [])[1] || "image.png";
      const alt = Buffer.from((txt.match(/name="alt"\r\n\r\n([^\r]*)/) || [, ""])[1], "latin1").toString("utf8");
      const key = "2026-11-test" + ++st.n + ".png";
      const it = { key, url: "/media/" + key, contentType: "image/png", size: PNG.length, alt, name, uploadedAt: new Date(Date.now() + st.n).toISOString(), uploadedBy: "admin@example.com" };
      st.media.unshift(it); st.lastUpload = { name, alt, size: raw.length, hasCT: !!req.headers()["content-type"] && req.headers()["content-type"].startsWith("multipart/form-data") };
      return json(201, { ok: true, item: pubMedia(st, it) });
    }
    const mm = p.match(/^\/admin\/media\/(.+)$/);
    if (mm) {
      const key = decodeURIComponent(mm[1]), it = st.media.find((x) => x.key === key);
      if (!it) return json(404, { error: "not_found" });
      if (m === "PUT") { it.alt = JSON.parse(req.postData()).alt; return json(200, { ok: true, item: pubMedia(st, it) }); }
      if (m === "DELETE") { const u = usage(st, it.url); if (u.length) return json(409, { error: "in_use", usedIn: u }); st.media = st.media.filter((x) => x !== it); return json(200, { ok: true, deleted: key }); }
    }
    return json(404, { error: "not_found" });
  });
}
async function setup(browser, ctxOpts, st = freshState()) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.route("https://accounts.google.com/**", (r) => r.abort());
  await ctx.route(BASE + "/media/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await ctx.addInitScript(() => sessionStorage.setItem("wd71_admin_token", "test-token"));
  await mockApi(ctx, st);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => { if (msg.type() === "error" && !/accounts\.google|ERR_FAILED|Failed to load resource/.test(msg.text())) errors.push("console: " + msg.text()); });
  await page.goto(BASE + "/admin/#/dashboard");
  await page.waitForSelector("#sideNav a[data-nav=dashboard].on", { state: "attached" });
  return { ctx, page, st, errors };
}
const dlg = (page) => page.locator("dialog.mdl.wide[open]");
const small = (page) => page.locator("dialog.mdl.small[open]");
const picker = (page) => page.locator("dialog.mdl.picker[open]");
const frame = (page) => page.frameLocator("dialog.mdl.wide[open] iframe");
const fld = (page, path) => dlg(page).locator(`[data-path="${path}"]`);
const inp = (page, path) => fld(page, path).locator("input[type=text], textarea").first();
const saveBtn = (page) => dlg(page).locator('[data-act="save"], .mfoot .btn-gold').first();
async function openSection(page, sid, key) {
  await page.goto(BASE + "/admin/#/homepage/" + sid);
  await page.waitForSelector("#secEdit");
  if (key) await page.click(`[data-field="${key}"] button`); else await page.click("#secEdit");
  await dlg(page).waitFor();
  await page.waitForFunction(() => { const f = document.querySelector("dialog.mdl.wide[open] iframe"); return f && f.contentDocument && f.contentDocument.querySelector("[data-cms-section]"); });
  await sleep(250);
}
const pvText = (page, sel) => frame(page).locator(sel).first().textContent();

let browser;
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/admin/"); if (r.ok) break; } catch {} await sleep(1000); }
  browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });

  /* ---------- 1. Dashboard + sidebar navigation (desktop) ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1360, height: 900 } });
    await page.waitForFunction(() => document.querySelector("#statPending .n") && document.querySelector("#statPending .n").textContent.trim() === "১");
    check("dashboard: pending users count", (await page.textContent("#statPending .n")).trim() === "১");
    check("dashboard: last updated shown", /সর্বশেষ|আপডেট/.test(await page.textContent("#statUpdated")), await page.textContent("#statUpdated"));
    check("sidebar: pending badge", (await page.textContent("#navPending")).trim() === "১");
    const navIds = await page.$$eval("#sideNav [data-nav]", (as) => as.map((a) => a.dataset.nav));
    check("sidebar: all items", ["dashboard", "homepage", "pages", "posts", "media", "users", "settings"].every((x) => navIds.includes(x)), navIds);
    check("sidebar: one sub-item per homepage section", M.SECTION_IDS.every((id) => navIds.includes("homepage/" + id)), navIds);
    check("sidebar: drawer button hidden on desktop", !(await page.isVisible("#menuBtn")));
    await page.screenshot({ path: SHOTS + "/01-dashboard.png" });
    // nav each page
    for (const [id, sel] of [["pages", "[data-page=pages]"], ["posts", "[data-page=posts]"], ["users", "#rows tr"], ["media", "#mediaGrid"], ["settings", "#setEdit"], ["homepage", "#homeRows"]]) {
      await page.click(`#sideNav a[data-nav="${id}"]`);
      await page.waitForSelector(sel, { state: "visible" });
      const on = await page.$eval(`#sideNav a[data-nav="${id}"]`, (a) => a.classList.contains("on") && a.getAttribute("aria-current") === "page");
      check("nav → " + id + " shows page and marks active", on);
      if (id === "pages" || id === "posts") check(id + ": placeholder শীঘ্রই আসছে", (await page.textContent(`[data-page=${id}]`)).includes("শীঘ্রই আসছে"));
    }
    check("users: existing approval list moved here", (await page.$$("#rows tr")).length === 2);
    await page.click('#sideNav a[data-nav="homepage/packages"]');
    await page.waitForSelector("#secEdit");
    check("sidebar sub-item opens section page", (await page.textContent("[data-page=homepage]")).includes("প্যাকেজ ও দাম") && await page.$eval('#sideNav a[data-nav="homepage/packages"]', (a) => a.classList.contains("on")));
    await page.screenshot({ path: SHOTS + "/02-sidebar-section-page.png" });
    await page.goBack(); await page.waitForSelector("#homeRows");
    check("browser back works with hash router", (await page.$$("#homeRows .row")).length === M.SECTIONS.length);
    check("no page errors (nav)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 2. Every section editor: open with preview, edit, live preview, save ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1440, height: 900 } });
    const EDIT = { header: "logo", footer: "copyright" };
    for (const def of M.SECTIONS) {
      const key = EDIT[def.id] || "title", path = key + ".text", sel = `[data-cms="${def.id}.${key}"]`;
      await openSection(page, def.id);
      check(def.id + ": editor open with preview iframe", await dlg(page).locator("iframe").count() === 1);
      check(def.id + ": section toggle present", await fld(page, "hidden").count() === 1);
      check(def.id + ": a control for every field", (await Promise.all(def.fields.map((f) => dlg(page).locator(`[data-key="${f.key}"]`).count()))).every((n) => n === 1));
      const val = "পরীক্ষা " + def.label + " ১২৩";
      await inp(page, path).fill(val);
      await sleep(250);
      const shown = (await pvText(page, sel)).trim();
      check(def.id + ": preview updates live", shown.includes("পরীক্ষা"), shown);
      check(def.id + ": save enabled when dirty", await saveBtn(page).isEnabled());
      await page.screenshot({ path: `${SHOTS}/03-editor-${def.id}.png` });
      await saveBtn(page).click();
      await dlg(page).waitFor({ state: "detached" });
      const put = st.lastPut;
      check(def.id + ": PUT sends field + version", put && put.id === def.id && put.body.fields[key].text === val && put.body.version === 1, put);
      check(def.id + ": page shows saved value", (await page.textContent("[data-page=homepage]")).includes(val));
    }
    check("no page errors (all editors)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 3. Hero: buttons add/remove/reorder/hide, extra elements, image from Media ---------- */
  {
    const st0 = freshState();
    st0.media.push({ key: "2026-11-libAAAA.png", url: "/media/2026-11-libAAAA.png", contentType: "image/png", size: 68, alt: "লাইব্রেরির ছবি", name: "lib.png", uploadedAt: "2026-11-01T10:00:00Z", uploadedBy: "admin@example.com" });
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1440, height: 900 } }, st0);
    await openSection(page, "hero", "buttons");
    const items = () => fld(page, "buttons.items").locator(":scope > .rep-item");
    const ids = () => items().evaluateAll((els) => els.map((e) => e.dataset.id));
    check("hero buttons: 2 seeded", (await items().count()) === 2);
    // add
    await fld(page, "buttons.items").locator(':scope > .rep-add [data-act="add"]').click();
    check("buttons: add creates item", (await items().count()) === 3);
    await inp(page, "buttons.items.2.label").fill("নতুন বাটন");
    await inp(page, "buttons.items.2.href").fill("javascript:alert(1)");
    await sleep(100);
    check("buttons: unsafe href blocked inline", await fld(page, "buttons.items.2.href").evaluate((e) => e.classList.contains("bad")) && await saveBtn(page).isDisabled());
    await inp(page, "buttons.items.2.href").fill("tel:+8801700000000");
    await sleep(250);
    check("buttons: preview shows new button", (await frame(page).locator('[data-cms="hero.buttons"] a').count()) === 3 && (await frame(page).locator('[data-cms="hero.buttons"] a').nth(2).textContent()).includes("নতুন বাটন"));
    // reorder: move new one up twice
    const before = await ids();
    await items().nth(2).locator('[data-act="up"]').click();
    await items().nth(1).locator('[data-act="up"]').click();
    const after = await ids();
    check("buttons: reorder up", after[0] === before[2] && after[1] === before[0], { before, after });
    await sleep(250);
    check("buttons: preview reflects order", (await frame(page).locator('[data-cms="hero.buttons"] a').first().textContent()).includes("নতুন বাটন"));
    await items().nth(0).locator('[data-act="down"]').click();
    check("buttons: reorder down", (await ids())[1] === before[2]);
    // hide second original
    await items().nth(2).locator('[data-act="hide"]').click();
    await sleep(250);
    check("buttons: hide removes from preview", (await frame(page).locator('[data-cms="hero.buttons"] a').count()) === 2);
    // delete first
    await items().nth(0).locator('[data-act="del"]').click();
    check("buttons: delete", (await items().count()) === 2);
    // trust list: hide + reorder
    const trust = fld(page, "trust.items").locator(":scope > .rep-item");
    const tCount = await trust.count();
    await trust.nth(0).locator('[data-act="hide"]').click();
    await trust.nth(1).locator('[data-act="up"]').click();
    check("trust list: hide + reorder", (await fld(page, "trust.items").locator(":scope > .rep-item.is-hidden").count()) === 1 && (await trust.count()) === tCount);
    // extra: heading + paragraph + button + image (via picker)
    const extra = fld(page, "extra");
    const adder = (t) => extra.locator(':scope > .rep-add [data-act="add"]', { hasText: M.EXTRA_LABELS[t] });
    await adder("heading").click(); await inp(page, "extra.0.text").fill("নতুন শিরোনাম এলিমেন্ট");
    await adder("text").click(); await inp(page, "extra.1.text").fill("নতুন প্যারাগ্রাফ <b>escape</b>");
    await adder("button").click(); await inp(page, "extra.2.label").fill("এক্সট্রা বাটন"); await inp(page, "extra.2.href").fill("#contact");
    await adder("image").click();
    await picker(page).waitFor();
    check("picker: library + builtin tiles", (await picker(page).locator(".ptile").count()) === 2);
    await picker(page).locator('.ptile[data-url="/media/2026-11-libAAAA.png"]').click();
    await picker(page).locator("#pickOk").click();
    await picker(page).waitFor({ state: "detached" });
    check("extra image added from Media with alt", (await extra.locator(":scope > .rep-item").count()) === 4 && (await inp(page, "extra.3.alt").inputValue()) === "লাইব্রেরির ছবি");
    await sleep(300);
    const slot = frame(page).locator('[data-cms-slot="hero"]');
    check("extra: preview renders heading/text/button/image", (await slot.locator("h3, h2").count()) >= 1 && (await slot.textContent()).includes("<b>escape</b>") && (await slot.locator('img[src="/media/2026-11-libAAAA.png"]').count()) === 1 && (await slot.locator("a", { hasText: "এক্সট্রা বাটন" }).count()) === 1);
    check("extra: text escaped (no injected <b>)", (await slot.locator("b").count()) === 0);
    // swap hero image from Media
    await fld(page, "image.src").locator('[data-act="pick"]').click();
    await picker(page).waitFor();
    await picker(page).locator('.ptile[data-url="/media/2026-11-libAAAA.png"]').click();
    await picker(page).locator("#pickOk").click();
    await sleep(300);
    check("hero image swapped in preview", (await frame(page).locator('[data-cms="hero.image"]').first().evaluate((e) => (e.tagName === "IMG" ? e : e.querySelector("img")) && (e.tagName === "IMG" ? e : e.querySelector("img")).getAttribute("src"))) === "/media/2026-11-libAAAA.png");
    // highlight preserved
    await inp(page, "title.highlight").fill("মাত্র ৪৯৯৯");
    await sleep(250);
    check("hero highlight renders as <em>", (await frame(page).locator('[data-cms="hero.title"] em').textContent()).includes("৪৯৯৯"));
    await page.screenshot({ path: SHOTS + "/04-hero-editor-buttons-extra.png" });
    await saveBtn(page).click();
    await dlg(page).waitFor({ state: "detached" });
    const b = st.lastPut.body;
    check("hero PUT: buttons order/hide/new", b.fields.buttons.items.length === 2 && b.fields.buttons.items[0].label === "নতুন বাটন" && b.fields.buttons.items[0].href === "tel:+8801700000000" && b.fields.buttons.items[1].hidden === true, b.fields.buttons);
    check("hero PUT: extra types", JSON.stringify(b.extra.map((e) => e.type)) === JSON.stringify(["heading", "text", "button", "image"]), b.extra);
    check("hero PUT: image src", b.fields.image.src === "/media/2026-11-libAAAA.png");
    // media library now shows usage
    await page.click('#sideNav a[data-nav="media"]');
    await page.waitForSelector('#mediaGrid .mcard[data-key="2026-11-libAAAA.png"] .mused');
    check("media: used-on-homepage badge", (await page.textContent('#mediaGrid .mcard[data-key="2026-11-libAAAA.png"] .mused')).includes("হিরো"));
    // delete in-use → guided, not deleted
    await page.click('#mediaGrid .mcard[data-key="2026-11-libAAAA.png"] [data-act="delete"]');
    await small(page).waitFor();
    check("media: in-use delete offers সেকশনে যান", (await small(page).textContent()).includes("সেকশনে যান"));
    await small(page).locator(".btn-line").click();
    check("media: in-use image not deleted", !st.calls.some((c) => c.m === "DELETE"));
    // undo hero
    await page.goto(BASE + "/admin/#/homepage/hero"); await page.waitForSelector("#secUndo");
    await page.click("#secUndo"); await small(page).waitFor(); await small(page).locator(".btn-green").click();
    await page.waitForFunction(() => !document.querySelector("dialog.mdl.small[open]"));
    await sleep(300);
    check("hero undo restores previous", st.sections.find((s) => s.id === "hero").fields.buttons.items.length === 2 && st.sections.find((s) => s.id === "hero").fields.image.src === "" && st.calls.some((c) => c.path.endsWith("/hero/undo")));
    check("no page errors (hero)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 4. Validation, server field error, 409 banner (section editor) ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1360, height: 900 } });
    await openSection(page, "packages");
    await inp(page, "title.text").fill("");
    await sleep(200);
    check("validation: empty title marks field bad", (await fld(page, "title.text").getAttribute("class")).includes("bad") || (await dlg(page).locator('.bad[data-path="title.text"]').count()) === 1);
    check("validation: save disabled while invalid", !(await saveBtn(page).isEnabled()));
    await inp(page, "title.text").fill("বৈধ টাইটেল");
    await sleep(200);
    check("validation: fixed → save enabled", await saveBtn(page).isEnabled());
    st.putMode = "409";
    await saveBtn(page).click();
    await dlg(page).locator(".mbanner.warn").waitFor();
    check("409: conflict banner with reload", (await dlg(page).locator(".mbanner.warn").textContent()).includes("রিলোড"));
    check("409: dialog stays open, edit kept", (await inp(page, "title.text").inputValue()) === "বৈধ টাইটেল");
    await page.screenshot({ path: SHOTS + "/05-editor-409-banner.png" });
    await dlg(page).locator(".mbanner.warn button").click();
    await sleep(400);
    st.putMode = "400"; st.badField = "title.text";
    await inp(page, "title.text").fill("আবার পরীক্ষা");
    await sleep(150);
    await saveBtn(page).click();
    await page.waitForFunction(() => document.querySelector('dialog.mdl.wide[open] .bad[data-path="title.text"]') || document.querySelector("dialog.mdl.wide[open] .mbanner.err"));
    check("400 field error mapped to the field", (await dlg(page).locator('.bad[data-path="title.text"]').count()) === 1);
    // escape closes with dirty confirm
    await page.keyboard.press("Escape");
    await small(page).waitFor();
    check("dirty close asks for confirmation", (await small(page).count()) === 1);
    await small(page).locator(".btn-line").first().click();
    check("cancel keeps editor open", (await dlg(page).count()) === 1);
    check("no page errors (validation)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 5. Media library: upload (mocked POST), alt edit, delete, svg/oversize rejection ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1360, height: 900 } });
    await page.click('#sideNav a[data-nav="media"]');
    await page.waitForSelector("#mediaGrid");
    check("media: KV storage note", (await page.textContent("#mediaStorage")).includes("KV"));
    check("media: built-in illustrations listed", (await page.$$("#mediaGrid .mcard")).length === M.BUILTIN_MEDIA.length);
    // upload
    let [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#mediaUpload")]);
    await fc.setFiles({ name: "shop.png", mimeType: "image/png", buffer: PNG });
    await small(page).locator("#upAlt").waitFor();
    await page.fill("#upAlt", "দোকানের ছবি");
    await page.click("#upGo");
    await page.waitForSelector('#mediaGrid .mcard[data-key="2026-11-test1.png"]');
    check("upload: multipart POST with alt", st.lastUpload && st.lastUpload.hasCT && st.lastUpload.alt === "দোকানের ছবি" && st.lastUpload.name === "shop.png", st.lastUpload);
    check("upload: card shows alt", (await page.textContent('.mcard[data-key="2026-11-test1.png"] .malt')).includes("দোকানের ছবি"));
    await page.screenshot({ path: SHOTS + "/06-media-library.png" });
    // alt edit
    await page.click('.mcard[data-key="2026-11-test1.png"] [data-act="alt"]');
    await page.waitForSelector("#pmIn");
    await page.fill("#pmIn", "নতুন বিবরণ");
    await page.click("#pmOk");
    await page.waitForFunction(() => (document.querySelector('.mcard[data-key="2026-11-test1.png"] .malt') || {}).textContent?.includes("নতুন বিবরণ"));
    check("alt edit: PUT + card updated", st.media[0].alt === "নতুন বিবরণ");
    // copy URL
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await page.click('.mcard[data-key="2026-11-test1.png"] [data-act="copy"]');
    await sleep(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check("copy URL: absolute /media/ link", clip === BASE + "/media/2026-11-test1.png", clip);
    // svg rejected (no POST)
    const posts0 = st.calls.filter((c) => c.m === "POST").length;
    [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#mediaUpload")]);
    await fc.setFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
    await small(page).waitFor();
    check("svg rejected with message", (await small(page).textContent()).includes("SVG নয়"));
    await small(page).locator("button").last().click(); await small(page).waitFor({ state: "detached" });
    [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#mediaUpload")]);
    await fc.setFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(M.MEDIA_MAX_BYTES + 1) });
    await small(page).waitFor();
    check("oversize (>5MB) rejected with message", (await small(page).textContent()).includes("৫ MB"));
    await small(page).locator("button").last().click(); await small(page).waitFor({ state: "detached" });
    check("rejected files never POSTed", st.calls.filter((c) => c.m === "POST").length === posts0);
    // delete (not in use) via confirm
    await page.click('.mcard[data-key="2026-11-test1.png"] [data-act="delete"]');
    await small(page).waitFor();
    check("delete uses danger confirm", (await small(page).locator(".btn-danger").count()) === 1);
    await small(page).locator(".btn-danger").click();
    await page.waitForSelector('.mcard[data-key="2026-11-test1.png"]', { state: "detached" });
    check("delete: DELETE sent, card gone", st.calls.some((c) => c.m === "DELETE" && c.path === "/admin/media/2026-11-test1.png") && st.media.length === 0);
    check("no page errors (media)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 6. Settings: edit with live preview, validation, save, undo ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1440, height: 900 } });
    await page.click('#sideNav a[data-nav="settings"]');
    await page.waitForSelector("#setEdit");
    check("settings: rows for every field", (await page.$$("#pSettings .srow")).length === 7);
    await page.screenshot({ path: SHOTS + "/07a-settings-page.png" });
    await page.click("#setEdit");
    await dlg(page).waitFor();
    await page.waitForFunction(() => { const f = document.querySelector("dialog.mdl.wide[open] iframe"); return f && f.contentDocument && f.contentDocument.querySelector("[data-cms-slot=footer]"); });
    const sf = (n) => dlg(page).locator(`.fld[data-field="${n}"] input, .fld[data-field="${n}"] textarea`).first();
    await sf("contactPhone").fill("abc"); await sf("contactPhone").blur();
    await sleep(200);
    check("settings: bad phone blocks save", !(await saveBtn(page).isEnabled()) && (await dlg(page).locator('.fld[data-field="contactPhone"]').textContent()).includes("সঠিক ফোন"));
    await sf("contactPhone").fill("+880 1700-000000");
    await sf("contactEmail").fill("hello@example.com");
    await sf("siteTitle").fill("নতুন সাইট টাইটেল");
    await sleep(300);
    check("settings: footer contact in preview", (await frame(page).locator("[data-cms-slot=footer] .cms-contact").textContent()).includes("+880 1700-000000"));
    await page.screenshot({ path: SHOTS + "/07-settings-editor.png" });
    await saveBtn(page).click();
    await dlg(page).waitFor({ state: "detached" });
    check("settings PUT: values + version", st.lastSettingsPut && st.lastSettingsPut.siteTitle === "নতুন সাইট টাইটেল" && st.lastSettingsPut.contactEmail === "hello@example.com" && st.lastSettingsPut.version === 1, st.lastSettingsPut);
    await page.waitForFunction(() => document.querySelector("#pSettings").textContent.includes("নতুন সাইট টাইটেল"));
    check("settings page shows saved values", true);
    await page.click("#setUndo"); await small(page).waitFor(); await small(page).locator(".btn-green").click();
    await page.waitForFunction(() => !document.querySelector("#pSettings").textContent.includes("নতুন সাইট টাইটেল"));
    check("settings undo restores previous", st.settings.siteTitle === M.DEFAULT_SETTINGS.siteTitle && st.calls.some((c) => c.path === "/admin/settings/undo"));
    check("no page errors (settings)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 7. Mobile drawer (390px) ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    check("mobile: menu button visible", await page.isVisible("#menuBtn"));
    const sideX = async () => (await page.locator("#sidebar").boundingBox());
    const offscreen = async () => { const b = await sideX(); return !b || b.x + b.width <= 1; };
    check("mobile: sidebar hidden by default", await offscreen());
    await page.click("#menuBtn"); await sleep(400);
    check("mobile: drawer opens", (await page.getAttribute("#menuBtn", "aria-expanded")) === "true" && !(await offscreen()));
    await page.screenshot({ path: SHOTS + "/08-mobile-drawer.png" });
    await page.keyboard.press("Escape"); await sleep(400);
    check("mobile: Escape closes drawer", (await page.getAttribute("#menuBtn", "aria-expanded")) === "false" && (await offscreen()));
    await page.click("#menuBtn"); await sleep(400);
    await page.mouse.click(370, 400); await sleep(400);
    check("mobile: overlay tap closes drawer", (await page.getAttribute("#menuBtn", "aria-expanded")) === "false");
    await page.click("#menuBtn"); await sleep(400);
    await page.click('#sideNav a[data-nav="media"]'); await sleep(400);
    check("mobile: nav link navigates + closes", (await page.isVisible("#mediaGrid")) && (await page.getAttribute("#menuBtn", "aria-expanded")) === "false");
    await page.screenshot({ path: SHOTS + "/09-mobile-media.png" });
    await openSection(page, "hero");
    check("mobile: editor opens full-screen", (await dlg(page).boundingBox()).width >= 380);
    await page.screenshot({ path: SHOTS + "/10-mobile-editor.png" });
    check("no page errors (mobile)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 8. Preview (force render of seed) text-equals the public page ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1360, height: 900 } });
    await openSection(page, "hero");
    const pv = await page.evaluate(() => document.querySelector("dialog.mdl.wide[open] iframe").contentDocument.body.innerText);
    const p2 = await ctx.newPage(); await p2.goto(BASE + "/");
    const live = await p2.evaluate(() => document.body.innerText);
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    check("seed force-render text == public page text", norm(pv) === norm(live), [norm(pv).length, norm(live).length]);
    check("no page errors (equivalence)", errors.length === 0, errors);
    await ctx.close();
  }
} catch (e) { fail++; console.log("FATAL", e && e.stack || e); }
finally { if (browser) await browser.close(); try { process.kill(-dev.pid); } catch {} console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
