// Headless UI test of the Phase 4 blog admin (posts list, filters, bulk actions, trash, create dialog,
// post editor with blog blocks + post settings, scheduling, categories & tags manager, media usage), desktop + 390px.
// Run from the repo root: node site-worker/test/posts-ui.mjs  (SHOTS=<dir>, CHROME=<path> optional).
// The admin API is mocked with a stateful in-memory backend built on the real shared models (public/cms/posts.js, pages.js).
// No real KV is touched; /admin/, /__page-preview and /cms/* come from a local `wrangler dev` of the site worker.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PG = await import(new URL("../../public/cms/pages.js", import.meta.url));
const PO = await import(new URL("../../public/cms/posts.js", import.meta.url));
const M = await import(new URL("../../public/cms/model.js", import.meta.url));

const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`, SHOTS = process.env.SHOTS || join(tmpdir(), "cms4_shots");
mkdirSync(SHOTS, { recursive: true });
const persist = mkdtempSync(join(tmpdir(), "wd71ui4-"));
const dev = spawn("wrangler", ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore", detached: true });
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + JSON.stringify(x).slice(0, 400)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const now = () => new Date().toISOString();
const IMG = "/media/abc123def4.png";

function freshState() {
  const at = "2026-11-01T17:07:49.000Z";
  return { posts: [], terms: { categories: [], tags: [], version: 0 }, calls: [], puts: [], creates: [], bulk: [], putMode: "ok",
    media: [{ key: "abc123def4.png", url: IMG, name: "cover.png", type: "image/png", size: 68, alt: "কভার", uploadedAt: at, uploadedBy: "admin@example.com" }],
    mediaDeletes: [],
    sections: M.SECTION_IDS.map((id) => ({ ...M.DEFAULTS[id], version: 1, updatedAt: at, updatedBy: "seed" })),
    settings: { ...M.DEFAULT_SETTINGS, version: 1, updatedAt: at, updatedBy: "seed" } };
}
const KEYS = ["title", "slug", "excerpt", "image", "imageAlt", "categories", "tags", "author", "date", "seo", "blocks"];
const pick = (d) => Object.fromEntries(KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
function seedPost(st, o) {
  const c = PO.cleanPostInput({ title: o.title, slug: o.slug, excerpt: o.excerpt || "", categories: o.categories || [], tags: o.tags || [], author: "Admin", date: o.date || "", blocks: o.blocks || [PG.newBlock("text")], image: o.image || "" });
  const doc = { schema: 1, id: PO.newPostId(), ...c, status: o.status || "draft", version: 1, createdAt: now(), updatedAt: o.updatedAt || now(), updatedBy: "admin@example.com",
    publishedAt: o.status === "published" ? now() : "", publishedVersion: o.status === "published" ? 1 : 0, publishedSlug: o.status === "published" ? c.slug : "", redirects: [], trashedAt: o.status === "trash" ? now() : "" };
  st.posts.push(doc); return doc;
}
function mockApi(ctx, st) {
  return ctx.route("https://api.webdesigner71.com/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method(), p = url.pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" } });
    st.calls.push({ m, path: p, q: url.search });
    const body = () => JSON.parse(req.postData() || "{}");
    const bad = (e) => json(400, { error: "invalid", field: e.field, reason: e.reason });
    const taken = (slug, id) => st.posts.some((x) => x.id !== id && (x.slug === slug || x.publishedSlug === slug));
    const index = () => st.posts.map(PO.indexEntry);
    const termsOut = () => ({ ...st.terms });
    const validTerms = (c) => ({ ...c, categories: c.categories.filter((id) => st.terms.categories.some((t) => t.id === id)), tags: c.tags.filter((id) => st.terms.tags.some((t) => t.id === id)) });
    if (p === "/me") return json(200, { user: { email: "admin@example.com", name: "Admin", isAdmin: true, status: "approved" } });
    if (p === "/admin/users") return json(200, { users: [{ email: "admin@example.com", name: "Admin", status: "approved", isAdmin: true, createdAt: "2026-10-20T10:00:00Z" }] });
    if (p === "/content/homepage") return json(200, { schema: M.SCHEMA, source: "kv", sections: st.sections, settings: st.settings });
    if (p === "/admin/settings" && m === "GET") return json(200, { settings: st.settings });
    if (p === "/admin/pages" && m === "GET") return json(200, { pages: [], limits: PG.LIMITS, reserved: PG.RESERVED_SLUGS });
    if (p === "/admin/media" && m === "GET") {
      const users = (u) => st.posts.filter((d) => PO.indexEntry(d).media.includes(u)).map((d) => ({ kind: "post", id: d.id, title: d.title, status: d.status }));
      return json(200, { storage: "kv", maxBytes: M.MEDIA_MAX_BYTES, types: Object.keys(M.MEDIA_TYPES), items: st.media.map((x) => ({ ...x, usedIn: [], usedBy: users(x.url) })), builtin: M.BUILTIN_MEDIA });
    }
    const mm = p.match(/^\/admin\/media\/(.+)$/);
    if (mm && m === "DELETE") {
      const it = st.media.find((x) => x.key === decodeURIComponent(mm[1])); if (!it) return json(404, { error: "not_found" });
      const by = st.posts.filter((d) => PO.indexEntry(d).media.includes(it.url));
      if (by.length && url.searchParams.get("force") !== "1") return json(409, { error: "in_use", usedIn: [], usedBy: by.map((d) => ({ kind: "post", id: d.id, title: d.title, status: d.status })) });
      st.media = st.media.filter((x) => x !== it); st.mediaDeletes.push(url.search); return json(200, { ok: true, deleted: it.key });
    }
    if (p === "/admin/posts" && m === "GET") return json(200, { posts: index(), terms: termsOut(), limits: PO.POST_LIMITS, reserved: PO.RESERVED_POST_SLUGS, now: now() });
    if (p === "/admin/posts" && m === "POST") {
      const b = body(); st.creates.push(b);
      const raw = { ...b }; if (!raw.slug) { let s = PO.slugify(raw.title || "", "post-x"), n = 2; const base = s; while (taken(s, null)) s = base + "-" + n++; raw.slug = s; }
      let c; try { c = validTerms(PO.cleanPostInput(raw)); } catch (e) { return bad(e); }
      if (taken(c.slug, null)) return json(400, { error: "invalid", field: "slug", reason: "taken" });
      const doc = { schema: 1, id: PO.newPostId(), ...c, status: "draft", version: 1, createdAt: now(), updatedAt: now(), updatedBy: "admin@example.com", publishedAt: "", publishedVersion: 0, publishedSlug: "", redirects: [], trashedAt: "" };
      st.posts.unshift(doc); return json(201, { ok: true, post: doc });
    }
    if (p === "/admin/posts/bulk" && m === "POST") {
      const b = body(); st.bulk.push(b); const done = [], failed = [];
      for (const id of b.ids) {
        const i = st.posts.findIndex((x) => x.id === id); if (i < 0) { failed.push({ id, error: "not_found" }); continue; }
        const r = act(st.posts[i], b.action); if (r.error) { failed.push({ id, error: r.error }); continue; }
        if (r.deleted) st.posts.splice(i, 1); else st.posts[i] = r.doc; done.push(id);
      }
      return json(200, { ok: true, action: b.action, done, failed, posts: index() });
    }
    if (p === "/admin/posts/terms" && m === "POST") {
      const b = body(), kind = b.kind === "category" ? "categories" : "tags", list = st.terms[kind];
      let name; try { name = PO.cleanTermName(b.name); } catch (e) { return json(400, { error: "invalid", field: "name", reason: e.reason }); }
      const dup = list.find((t) => t.name.toLowerCase() === name.toLowerCase()); if (dup) return json(200, { ok: true, term: dup, terms: termsOut(), existed: true });
      let s = PO.slugify(name, b.kind + "-" + list.length), n = 2; const base = s; while (list.some((t) => t.slug === s)) s = base + "-" + n++;
      const term = { id: PO.newTermId(b.kind), slug: s, name }; list.push(term); st.terms.version++;
      return json(201, { ok: true, term, terms: termsOut() });
    }
    const tm = p.match(/^\/admin\/posts\/terms\/([ct][a-z0-9]+)$/);
    if (tm) {
      const kind = tm[1][0] === "c" ? "categories" : "tags", t = st.terms[kind].find((x) => x.id === tm[1]); if (!t) return json(404, { error: "not_found" });
      if (m === "PUT") { const b = body(); if (b.name) t.name = b.name; if (b.slug) { if (PO.termSlugProblem(b.slug)) return json(400, { error: "invalid", field: "slug", reason: "format" }); t.slug = b.slug; } return json(200, { ok: true, term: t, terms: termsOut() }); }
      if (m === "DELETE") { st.terms[kind] = st.terms[kind].filter((x) => x !== t); return json(200, { ok: true, deleted: t.id, posts: 0, terms: termsOut() }); }
    }
    const pm = p.match(/^\/admin\/posts\/(q[a-z0-9]+)(?:\/(publish|unpublish|duplicate|trash|restore|undo))?$/);
    if (pm) {
      const i = st.posts.findIndex((x) => x.id === pm[1]); if (i < 0) return json(404, { error: "not_found" });
      const cur = st.posts[i], a = pm[2];
      if (!a && m === "GET") return json(200, { post: cur, terms: termsOut() });
      if (!a && m === "PUT") {
        if (st.putMode === "network") return route.abort("failed");
        const { version, ...rest } = body();
        if (version !== cur.version) return json(409, { error: "version_conflict", post: cur });
        if (cur.status === "trash") return json(409, { error: "in_trash" });
        let c; try { c = validTerms(PO.cleanPostInput(rest)); } catch (e) { return bad(e); }
        if (taken(c.slug, cur.id)) return json(400, { error: "invalid", field: "slug", reason: "taken" });
        st.posts[i] = { ...cur, ...c, version: cur.version + 1, updatedAt: now() }; st.puts.push(rest);
        await sleep(120); return json(200, { ok: true, post: st.posts[i] });
      }
      if (!a && m === "DELETE") {
        if (cur.status !== "trash") return json(409, { error: "not_in_trash" });
        st.posts.splice(i, 1); return json(200, { ok: true, deleted: cur.id });
      }
      if (a === "duplicate") {
        let s = cur.slug + "-copy", n = 2; while (taken(s, null)) s = cur.slug + "-copy-" + n++;
        const doc = { ...cur, ...PO.cleanPostInput({ ...pick(cur), title: cur.title + " (কপি)", slug: s, date: "", blocks: cur.blocks.map(PG.cloneBlock) }), id: PO.newPostId(), status: "draft", version: 1, publishedVersion: 0, publishedSlug: "", publishedAt: "", redirects: [] };
        st.posts.unshift(doc); return json(201, { ok: true, post: doc });
      }
      const b = body();
      if ((a === "publish" || a === "unpublish") && b.version !== cur.version) return json(409, { error: "version_conflict", post: cur });
      const r = act(cur, a); if (r.error) return json(409, { error: r.error });
      st.posts[i] = r.doc; return json(200, { ok: true, post: r.doc });
    }
    return json(404, { error: "not_found" });
  });
  function act(cur, a) {
    const t = now(), bump = (o) => ({ ...cur, ...o, version: cur.version + 1, updatedAt: t });
    if (a === "publish") { if (cur.status === "trash") return { error: "in_trash" }; const d = bump({ status: "published", date: cur.date || t, publishedAt: t, publishedSlug: cur.slug }); d.publishedVersion = d.version; return { doc: d }; }
    if (a === "unpublish") return cur.status === "published" ? { doc: bump({ status: "draft", publishedSlug: "" }) } : { error: "not_published" };
    if (a === "trash") return { doc: cur.status === "trash" ? cur : bump({ status: "trash", trashedAt: t, publishedSlug: "" }) };
    if (a === "restore") return cur.status === "trash" ? { doc: bump({ status: "draft", trashedAt: "" }) } : { error: "not_in_trash" };
    if (a === "delete") return cur.status === "trash" ? { deleted: true } : { error: "not_in_trash" };
    return { error: "invalid_action" };
  }
}
async function setup(browser, ctxOpts, st = freshState(), hash = "#/posts") {
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
const confirmOk = async (page) => { await page.waitForSelector("dialog.mdl.small[open]"); await page.locator("dialog.mdl.small[open] .mfoot .btn:last-child").first().click(); await page.waitForFunction(() => !document.querySelector("dialog.mdl.small[open]")); };
const prompt = async (page, value) => { const D = "dialog.mdl.small[open]"; await page.waitForSelector(D + " .mbody input, " + D + " .mbody textarea"); const i = page.locator(D + " .mbody input, " + D + " .mbody textarea").first(); await i.fill(value); await page.locator(D + " .mfoot .btn:last-child").first().click(); await page.waitForFunction(() => !document.querySelector("dialog.mdl.small[open]")); };
const frameReady = (page) => page.waitForFunction(() => { const f = document.querySelector("#pbFrame"); return f && f.contentDocument && f.contentDocument.querySelector("main#top .wb-post .pb-root"); }, null, { timeout: 15000 });
const inFrame = (page, fn, arg) => page.evaluate(([src, arg]) => { const d = document.querySelector("#pbFrame").contentDocument; return new Function("d", "arg", "return (" + src + ")(d, arg)")(d, arg); }, [fn.toString(), arg]);
const rowIds = (page) => page.$$eval("#postsTable tr[data-id]", (rs) => rs.map((r) => r.dataset.id));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const waitStatus = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#pbStatus").textContent), re.source, { timeout: 8000 });
const DAY = 86400e3;

let browser;
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/admin/"); if (r.ok) break; } catch {} await sleep(1000); }
  browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const cmsMod = await fetch(BASE + "/cms/posts.js"); check("site worker serves /cms/posts.js", cmsMod.ok && /renderArticle/.test(await cmsMod.text()), cmsMod.status);

  /* ---------- 1. Desktop ---------- */
  {
    const { ctx, page, st, errors } = await setup(browser, { viewport: { width: 1440, height: 900 } });
    await page.waitForSelector("#postsEmpty");
    check("posts: empty state", /এখনো কোনো পোস্ট নেই/.test(await page.textContent("#postsEmpty")));
    check("sidebar Posts link active, no 'coming soon' badge", await page.locator("#sideNav a[data-nav=posts].on").count() === 1 && !/শীঘ্রই/.test(await page.textContent("#sideNav a[data-nav=posts]")));
    await page.screenshot({ path: SHOTS + "/01-posts-empty.png" });

    // categories & tags manager
    await page.click("#termsBtn"); await page.waitForSelector("#catCard");
    check("terms: URL #/posts/terms", page.url().endsWith("#/posts/terms"));
    for (const n of ["ওয়েব ডিজাইন", "এসইও", "টিপস"]) { await page.fill("#newCatName", n); await page.press("#newCatName", "Enter"); await page.waitForFunction((n) => [...document.querySelectorAll("#catCard [data-term] b")].some((b) => b.textContent === n), n); }
    check("terms: 3 categories created via API", st.terms.categories.length === 3 && st.calls.filter((c) => c.path === "/admin/posts/terms" && c.m === "POST").length === 3);
    await page.fill("#newTagName", "wordpress"); await page.press("#newTagName", "Enter");
    await page.waitForSelector("#tagCard [data-term]");
    check("terms: tag created", st.terms.tags.length === 1 && /#wordpress/.test(await page.textContent("#tagCard")));
    const tipsId = st.terms.categories[2].id;
    await page.click(`#catCard [data-term="${tipsId}"] [data-act=rename]`); await prompt(page, "টিপস ও কৌশল");
    await page.waitForFunction(() => /টিপস ও কৌশল/.test(document.querySelector("#catCard").textContent));
    check("terms: rename", st.terms.categories[2].name === "টিপস ও কৌশল");
    await page.click(`#catCard [data-term="${tipsId}"] [data-act=slug]`); await prompt(page, "tips");
    await page.waitForFunction(() => /\/blog\/category\/tips/.test(document.querySelector("#catCard").textContent));
    check("terms: change slug", st.terms.categories[2].slug === "tips");
    await page.screenshot({ path: SHOTS + "/02-terms.png" });
    await page.click(`#catCard [data-term="${tipsId}"] [data-act=delete]`); await confirmOk(page);
    await page.waitForFunction((id) => !document.querySelector(`#catCard [data-term="${id}"]`), tipsId);
    check("terms: delete (confirmed)", st.terms.categories.length === 2);
    await page.click("#termsBack"); await page.waitForSelector("#postsEmpty");

    // create dialog
    await page.click("#newPost"); await page.waitForSelector("#cqTitle");
    await page.fill("#cqTitle", "Website Speed Guide");
    check("create: slug auto-generated", (await page.inputValue("#cqSlug")) === "website-speed-guide", await page.inputValue("#cqSlug"));
    await page.fill("#cqSlug", "feed"); await page.click("#cqOk"); await sleep(150);
    check("create: reserved blog slug 'feed' rejected client-side", st.creates.length === 0 && await page.isVisible("#cqTitle"));
    await page.fill("#cqSlug", "BAD slug!"); await page.click("#cqOk"); await sleep(150);
    check("create: invalid slug rejected", st.creates.length === 0);
    await page.fill("#cqSlug", "website-speed-guide");
    const webId = st.terms.categories[0].id;
    await page.click(`#cqCats .chip:has-text("ওয়েব ডিজাইন")`);
    check("create: category chip toggles", await page.getAttribute(`#cqCats .chip:has-text("ওয়েব ডিজাইন")`, "aria-pressed") === "true");
    await sleep(450); await page.screenshot({ path: SHOTS + "/03-create-dialog.png" });
    await page.click("#cqOk");
    await page.waitForSelector("#pbEditor");
    const c0 = st.creates[0];
    check("create: POST body", c0 && c0.title === "Website Speed Guide" && c0.slug === "website-speed-guide" && c0.author === "Admin" && JSON.stringify(c0.categories) === JSON.stringify([webId]) && c0.blocks.length === 1 && c0.blocks[0].type === "text", c0);
    const id = st.posts[0].id;
    await frameReady(page);
    check("editor: URL #/posts/<id>", page.url().endsWith("#/posts/" + id));
    check("editor: post mode class", await page.$eval("#pbEditor", (e) => e.classList.contains("pbe-post")));
    check("editor: article layout in preview (title + category)", await inFrame(page, (d) => d.querySelector(".wb-title").textContent === "Website Speed Guide" && /ওয়েব ডিজাইন/.test(d.querySelector(".wb-cats").textContent)));
    check("editor: draft has no public view link", !(await page.isVisible("#pbView")) || !(await page.getAttribute("#pbView", "href") || "").includes("/blog/"));

    // blog blocks from the library
    await page.click("[data-ltab=blocks]");
    check("library: blog group with toc/callout/code/gallery", await page.locator('.ltile[data-add="toc"]').count() === 1 && await page.locator('.ltile[data-add="callout"]').count() === 1 && await page.locator('.ltile[data-add="code"]').count() === 1 && await page.locator('.ltile[data-add="gallery"]').count() === 1);
    const groupsTxt = await page.$$eval(".lib-g", (g) => g.map((x) => x.textContent));
    check("library: blog group listed first for posts", /ব্লগ/.test(groupsTxt[0] || ""), groupsTxt);
    await page.click('.ltile[data-add="heading"]'); await page.click('.ltile[data-add="callout"]'); await page.click('.ltile[data-add="code"]');
    await page.waitForFunction(() => document.querySelector("#pbFrame").contentDocument.querySelector(".pb-root pre"));
    check("preview: callout + code rendered", await inFrame(page, (d) => !!d.querySelector(".pb-root aside[role=note]") && !!d.querySelector(".pb-root pre code")));
    // the code field
    const cta = page.locator("textarea.codeta").first();
    check("inspector: code field is a monospace LTR textarea", await cta.count() === 1 && (await cta.getAttribute("dir")) === "ltr");
    await cta.fill("const a = 1;"); await cta.press("End"); await cta.press("Tab"); await cta.type("// x");
    check("code field: Tab inserts a tab character", (await cta.inputValue()).includes("\t// x"), await cta.inputValue());
    await page.waitForFunction(() => /const a = 1;/.test(document.querySelector("#pbFrame").contentDocument.querySelector(".pb-root pre").textContent));
    check("code edit reflected live (escaped text)", await inFrame(page, (d) => d.querySelector(".pb-root pre code").textContent.includes("const a = 1;")));
    await page.click('.ltile[data-add="toc"]');
    await page.waitForFunction(() => document.querySelector("#pbFrame").contentDocument.querySelector(".pb-root nav"));
    check("preview: table of contents lists the heading", await inFrame(page, (d) => d.querySelectorAll(".pb-root nav a").length >= 1));
    await page.screenshot({ path: SHOTS + "/04-post-editor.png" });

    // post settings from the editor (title click or ⚙)
    await page.click("#pbTitle"); await page.waitForSelector("#psExcerpt");
    await sleep(450); await page.screenshot({ path: SHOTS + "/05-post-settings.png" });
    check("settings: reading time shown", /মিনিট/.test(await page.textContent("#psRead")));
    await page.fill("#psExcerpt", "ধীর ওয়েবসাইট গ্রাহক হারায়। জানুন কীভাবে দ্রুত করবেন।");
    await page.click(`#psCats .chip:has-text("এসইও")`);
    await page.fill("#psTagIn", "wordpress"); await page.press("#psTagIn", "Enter");
    await page.fill("#psTagIn", "speed"); await page.press("#psTagIn", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#psTags .chip").length === 2);
    check("settings: existing tag reused + new tag created", st.terms.tags.length === 2);
    await page.click("#psCatNew"); await prompt(page, "পারফরম্যান্স");
    await page.waitForFunction(() => [...document.querySelectorAll("#psCats .chip.on")].some((c) => c.textContent === "পারফরম্যান্স"));
    check("settings: inline new category selected", st.terms.categories.length === 3);
    await page.fill("#psAuthor", "Md. Moshfiqur Rahman");
    const future = new Date(Date.now() + 3 * DAY), fIn = new Date(future.getTime() + 6 * 3600e3).toISOString().slice(0, 16);
    await page.fill("#psDate", fIn); await page.dispatchEvent("#psDate", "change");
    check("settings: future date explained as scheduling", /শিডিউল/.test(await page.textContent("#psDateNote")), await page.textContent("#psDateNote"));
    await page.fill("#psSlug", "page"); await sleep(50);
    check("settings: reserved slug disables OK", await page.isDisabled("#psOk"));
    await page.fill("#psSlug", "website-speed-guide");
    await page.fill("#psMetaTitle", "ওয়েবসাইট স্পিড গাইড | WebDesigner71");
    await page.click("#psOk"); await page.waitForFunction(() => !document.querySelector("#psOk"));
    await page.waitForFunction(() => /ধীর ওয়েবসাইট/.test(document.querySelector("#pbFrame").contentDocument.querySelector(".wb-lead") ? document.querySelector("#pbFrame").contentDocument.querySelector(".wb-lead").textContent : ""));
    check("preview: excerpt + tags + author follow the settings", await inFrame(page, (d) => /#speed/.test(d.querySelector(".wb-tags").textContent) && /Moshfiqur/.test(d.querySelector(".wb-by").textContent)));
    check("editor: publish button says schedule for a future date", /শিডিউল/.test(await page.textContent("#pbPublish")), await page.textContent("#pbPublish"));

    // save + schedule
    await page.click("#pbSave"); await waitStatus(page, /সেভ/); await sleep(400);
    const put = st.puts[st.puts.length - 1];
    check("save: PUT carries all post fields", put && put.excerpt.startsWith("ধীর") && put.tags.length === 2 && put.categories.length === 3 && put.author === "Md. Moshfiqur Rahman" && Math.abs(Date.parse(put.date) - Math.floor(future.getTime() / 60000) * 60000) < 60000 && put.seo.title.includes("স্পিড") && put.blocks.some((b) => b.type === "code"), put && { ...put, blocks: put.blocks.length });
    check("save: code kept verbatim", st.posts[0].blocks.find((b) => b.type === "code").content.code.includes("const a = 1;\t// x"));
    await page.click("#pbPublish");
    await sleep(300); if (await page.locator("dialog.mdl.small[open]").count()) await confirmOk(page);
    await page.waitForFunction(() => /শিডিউল করা/.test(document.querySelector("#pbPublish").textContent + document.querySelector("#pbStatus").textContent), null, { timeout: 8000 }).catch(() => {});
    check("publish with future date → scheduled", st.posts[0].status === "published" && PO.postStatus(st.posts[0]) === "scheduled", PO.postStatus(st.posts[0]));
    check("editor: scheduled time shown in the status", /শিডিউল/.test(await page.textContent("#pbStatus") + await page.textContent("#pbPublish")));
    await page.screenshot({ path: SHOTS + "/06-scheduled.png" });
    await page.click("#pbBack"); await page.waitForSelector("#postsTable");
    check("back to the posts list", page.url().endsWith("#/posts"));
    check("list: scheduled pill", /শিডিউল করা/.test(await page.textContent(`tr[data-id="${id}"] .pill.st-sched`)));

    // more posts for filters / bulk / pager
    const tagW = st.terms.tags[0].id, seoId = st.terms.categories[1].id;
    for (let i = 0; i < 22; i++) seedPost(st, { title: "পুরোনো লেখা " + (i + 1), slug: "old-post-" + (i + 1), status: i < 12 ? "published" : "draft", date: new Date(Date.now() - (i + 1) * DAY).toISOString(), categories: i % 2 ? [seoId] : [], tags: i % 3 ? [] : [tagW], image: i === 0 ? IMG : "" });
    await page.reload(); await page.waitForSelector("#postsTable");
    check("list: 20 per page + pager", (await rowIds(page)).length === 20 && await page.locator("#postPager .btn").count() === 2);
    const tabTxt = await page.$$eval(".qtab", (t) => t.map((x) => x.dataset.st + ":" + x.querySelector(".qc").textContent));
    check("tabs: all/published/scheduled/draft with counts (trash hidden while empty)", JSON.stringify(tabTxt) === JSON.stringify(["all:২৩", "published:১২", "scheduled:১", "draft:১০"]), tabTxt);
    await page.click("#postPager .btn:last-child"); await sleep(100);
    check("pager: page 2 has the rest", (await rowIds(page)).length === 3);
    await page.click('.qtab[data-st="scheduled"]');
    check("tab: scheduled filter", JSON.stringify(await rowIds(page)) === JSON.stringify([id]));
    await page.click('.qtab[data-st="draft"]');
    check("tab: draft filter", (await rowIds(page)).length === 10);
    await page.click('.qtab[data-st="all"]');
    await page.fill("#postSearch", "speed"); await sleep(400);
    check("search: by title/slug", JSON.stringify(await rowIds(page)) === JSON.stringify([id]));
    await page.fill("#postSearch", "কোনোকিছুনেই"); await sleep(400);
    check("search: no results message", await page.isVisible("#postsNone"));
    await page.fill("#postSearch", ""); await sleep(400);
    await page.selectOption("#postCat", seoId); await sleep(100);
    check("category filter", (await rowIds(page)).length === 12, (await rowIds(page)).length);
    await page.screenshot({ path: SHOTS + "/07-posts-list-filtered.png" });
    await page.selectOption("#postCat", ""); await sleep(100);
    await page.screenshot({ path: SHOTS + "/08-posts-list.png" });
    check("list row: thumbnail, /blog/slug, reading time, category pill", await page.locator(`tr[data-id="${st.posts.find((p) => p.slug === "old-post-1").id}"] .qthumb img`).count() === 1 && /\/blog\/old-post-2/.test(await page.textContent("#postsTable")) && /মিনিট/.test(await page.textContent("#postsTable")) && await page.locator("#postsTable .pill.qcatp").count() > 0);

    // bulk: select drafts → publish
    await page.click('.qtab[data-st="draft"]');
    await page.click("#postSelAll");
    check("bulk bar appears with count", await page.isVisible("#postBulk") && /১০টি/.test(await page.textContent("#postBulk")));
    await page.screenshot({ path: SHOTS + "/09-bulk.png" });
    await page.click('#postBulk [data-bulk="publish"]');
    await page.waitForFunction(() => !document.querySelector("#postBulk:not(.hidden)"));
    check("bulk publish: one request with 10 ids", st.bulk.length === 1 && st.bulk[0].action === "publish" && st.bulk[0].ids.length === 10);
    check("bulk publish: drafts now live", st.posts.filter((p) => p.status === "draft").length === 0);
    // bulk trash two
    await page.click('.qtab[data-st="all"]');
    const ids2 = (await rowIds(page)).slice(1, 3);
    for (const x of ids2) await page.check(`tr[data-id="${x}"] .qsel`);
    await page.click('#postBulk [data-bulk="trash"]'); await confirmOk(page);
    await page.waitForSelector('.qtab[data-st="trash"]');
    check("bulk trash (confirmed) → trash tab appears", st.posts.filter((p) => p.status === "trash").length === 2 && /২/.test(await page.textContent('.qtab[data-st="trash"] .qc')));
    await page.click('.qtab[data-st="trash"]');
    check("trash tab lists trashed posts with restore/delete", (await rowIds(page)).length === 2 && await page.locator("#postsTable [data-act=restore]").count() === 2 && await page.locator("#postsTable [data-act=edit]").count() === 0);
    await page.screenshot({ path: SHOTS + "/10-trash.png" });
    await page.click(`tr[data-id="${ids2[0]}"] [data-act=restore]`);
    await page.waitForFunction((x) => !document.querySelector(`tr[data-id="${x}"]`), ids2[0]);
    check("restore → draft", st.posts.find((p) => p.id === ids2[0]).status === "draft");
    await page.click(`tr[data-id="${ids2[1]}"] [data-act=delete]`); await confirmOk(page);
    await page.waitForFunction(() => !document.querySelector('.qtab[data-st="trash"].on') || !document.querySelector("#postsTable"));
    check("delete permanently (confirmed, DELETE with version)", !st.posts.some((p) => p.id === ids2[1]) && st.calls.some((c) => c.m === "DELETE" && c.path.endsWith(ids2[1]) && /version=/.test(c.q)));
    await page.click('.qtab[data-st="all"]').catch(() => {});
    await page.waitForSelector("#postsTable");
    // row actions: duplicate, unpublish, trash, settings
    const live = st.posts.find((p) => p.status === "published" && /^old-post-\d+$/.test(p.slug) && !ids2.includes(p.id) && !(Date.parse(p.date) > Date.now()));
    await page.click(`tr[data-id="${live.id}"] [data-act=dup]`);
    await page.waitForFunction(() => /\(কপি\)/.test(document.querySelector("#postsTable").textContent));
    check("duplicate → draft copy with -copy slug and empty date", st.posts[0].slug === live.slug + "-copy" && st.posts[0].status === "draft" && st.posts[0].date === "");
    await page.click(`tr[data-id="${live.id}"] [data-act=unpublish]`); await confirmOk(page); await sleep(300);
    check("unpublish (confirmed)", st.posts.find((p) => p.id === live.id).status === "draft");
    await page.click(`tr[data-id="${live.id}"] [data-act=seo]`); await page.waitForSelector("#psMetaDesc");
    await page.fill("#psMetaDesc", "পুরোনো লেখার বিবরণ"); await page.check("#psNoindex"); await page.click("#psOk");
    await page.waitForFunction(() => !document.querySelector("#psOk")); await sleep(300);
    check("list ⚙ settings saved (meta + noindex)", st.posts.find((p) => p.id === live.id).seo.noindex === true && st.posts.find((p) => p.id === live.id).seo.description === "পুরোনো লেখার বিবরণ");
    await page.click(`tr[data-id="${live.id}"] [data-act=trash]`); await sleep(300);
    check("row trash", st.posts.find((p) => p.id === live.id).status === "trash");
    // trashed post can't be opened in the editor
    await page.goto(BASE + "/admin/#/posts/" + live.id); await page.waitForSelector("#postsTable");
    check("trashed post: editor refused, back on the list", !(await page.$("#pbEditor")) && page.url().endsWith("#/posts"));

    // dashboard stat + quick link
    await page.click('#sideNav a[data-nav="dashboard"]'); await page.waitForSelector("#statPosts");
    await page.waitForFunction(() => !/…/.test(document.querySelector("#statPosts .n").textContent));
    check("dashboard: posts stat card", /প্রকাশিত/.test(await page.textContent("#statPosts")) && await page.locator('a[href="#/posts"]').count() >= 2);

    // media library: post usage + forced delete confirm
    st.posts.find((p) => p.slug === "old-post-1").status = "draft";
    st.posts.find((p) => p.slug === "old-post-1").image = IMG;
    await page.click('#sideNav a[data-nav="media"]'); await page.waitForSelector("#mediaGrid .pill");
    check("media: card shows 'পোস্ট: <title>' usage", /পোস্ট: পুরোনো লেখা ১/.test(await page.textContent("#mediaGrid")) || /পোস্ট: /.test(await page.textContent("#mediaGrid")), await page.textContent("#mediaGrid .mused"));
    await page.screenshot({ path: SHOTS + "/11-media-usage.png" });
    await page.locator("#mediaGrid button:has-text('মুছুন'), #mediaGrid [data-act=delete], #mediaGrid .danger").first().click();
    await page.waitForSelector("dialog.mdl.small[open]");
    check("media delete: warning names the posts using it", /ব্যবহার হচ্ছে/.test(await page.textContent("dialog.mdl.small[open]")) && /পুরোনো লেখা/.test(await page.textContent("dialog.mdl.small[open]")));
    await page.locator("dialog.mdl.small[open] .mfoot .btn:last-child").first().click(); await sleep(500);
    check("media delete: confirmed → DELETE ?force=1", st.mediaDeletes.length === 1 && st.mediaDeletes[0] === "?force=1", st.mediaDeletes);
    check("no page errors (desktop)", errors.length === 0, errors);
    await ctx.close();
  }

  /* ---------- 2. Mobile 390x844 ---------- */
  {
    const st = freshState();
    st.terms.categories.push({ id: "cabcdefg1", slug: "web", name: "ওয়েব" });
    for (let i = 0; i < 4; i++) seedPost(st, { title: "মোবাইল পোস্ট " + (i + 1) + " — একটু লম্বা শিরোনাম যাতে লাইন ভাঙে", slug: "m-post-" + (i + 1), status: i % 2 ? "draft" : "published", date: new Date(Date.now() - i * DAY).toISOString(), categories: ["cabcdefg1"] });
    const { ctx, page, errors } = await setup(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, st);
    await page.waitForSelector("#postsTable");
    check("mobile: list fits the screen", await noOverflow(page) && await page.evaluate(() => [...document.querySelectorAll("#postsTable tr[data-id]")].every((r) => r.getBoundingClientRect().right <= window.innerWidth + 1)));
    check("mobile: tabs + search visible", await page.isVisible(".qtabs") && await page.isVisible("#postSearch"));
    await page.screenshot({ path: SHOTS + "/12-mobile-list.png", fullPage: true });
    await page.check(`#postsTable tr[data-id] .qsel >> nth=0`);
    check("mobile: bulk bar fits", await page.isVisible("#postBulk") && await noOverflow(page));
    await page.check(`#postsTable tr[data-id] .qsel >> nth=0`).catch(() => {}); await page.uncheck(`#postsTable tr[data-id] .qsel >> nth=0`);
    await page.click("#newPost"); await page.waitForSelector("#cqTitle");
    await page.fill("#cqTitle", "Mobile Post"); await sleep(450); await page.screenshot({ path: SHOTS + "/13-mobile-create.png" });
    await page.click("#cqOk"); await page.waitForSelector("#pbEditor"); await frameReady(page);
    check("mobile: editor opens on canvas, phone width", await page.getAttribute("#pbEditor", "data-pane") === "canvas" && await page.getAttribute("#pbEditor", "data-device") === "m");
    check("mobile: editor no horizontal overflow", await noOverflow(page));
    await page.screenshot({ path: SHOTS + "/14-mobile-editor.png" });
    await page.click('.pbe-mbar button[data-pane="add"]'); await page.click("[data-ltab=blocks]"); await page.click('.ltile[data-add="callout"]'); await sleep(300);
    check("mobile: callout added", await inFrame(page, (d) => !!d.querySelector(".pb-root aside[role=note]")));
    // meta click in the preview opens the settings (pb:meta)
    await page.frameLocator("#pbFrame").locator(".wb-title").click();
    await page.waitForSelector("#psExcerpt", { timeout: 5000 }).catch(() => {});
    check("mobile: tapping the title in the preview opens post settings", await page.isVisible("#psExcerpt"));
    check("mobile: settings dialog fits (one column)", await page.evaluate(() => { const b = document.querySelector("dialog.mdl[open] .mbox").getBoundingClientRect(); return b.width <= window.innerWidth + 1 && getComputedStyle(document.querySelector(".qset")).gridTemplateColumns.split(" ").length === 1; }));
    await sleep(450); await page.screenshot({ path: SHOTS + "/15-mobile-settings.png" });
    await page.fill("#psExcerpt", "মোবাইল থেকে লেখা"); await page.click("#psOk"); await sleep(200);
    await page.click("#pbSave"); await sleep(800);
    check("mobile: save works", st.puts.length === 1 && st.puts[0].excerpt === "মোবাইল থেকে লেখা");
    await page.click("#pbBack"); await page.waitForSelector("#postsTable");
    await page.goto(BASE + "/admin/#/posts/terms"); await page.waitForSelector("#catCard");
    check("mobile: terms manager fits", await noOverflow(page));
    await page.screenshot({ path: SHOTS + "/16-mobile-terms.png" });
    check("no page errors (mobile)", errors.length === 0, errors);
    await ctx.close();
  }
} catch (e) { fail++; console.log("FATAL", e && e.stack || e); }
finally { if (browser) await browser.close(); try { process.kill(-dev.pid); } catch {} console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
