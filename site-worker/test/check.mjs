// Local checks for the site Worker (CMS Phase 2 + Phase 3 pages). Run from the repo root with wrangler on PATH:  node site-worker/test/check.mjs
// Uses `wrangler dev --local` with a throwaway KV store; never touches production.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as M from "../../public/cms/model.js";
import * as PG from "../../public/cms/pages.js";
import * as PO from "../../public/cms/posts.js";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "wd71site-"));
const ORIGINAL = readFileSync("public/index.html", "utf8");
const V1_SEED = {
  heroTitle: "উদ্যোক্তাদের জন্য ওয়েবসাইট ডিজাইন", heroHighlight: "সম্পূর্ণ ফ্রি।",
  heroSub: "ডোমেইন, হোস্টিং, ডিজাইন — সব এক প্যাকেজে", accentColor: "#D4A017",
  updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "seed", version: 1,
};
const SEED = M.seedDoc("seed", "2026-11-01T00:00:00.000Z");
const SETTINGS = { ...M.DEFAULT_SETTINGS, version: 1 };
const STYLE_DEFAULT = '<style id="wd71-cms">:root{--gold:#D4A017;--gold-2:#E9B930}</style>';
const WITH_STYLE = ORIGINAL.replace("</head>", STYLE_DEFAULT + "</head>");

const kv = (binding, ...args) => execFileSync("wrangler", ["kv", "key", ...args, "--binding", binding, "--local", "--persist-to", persist], { stdio: "pipe" });
const putKV = (key, obj) => { const f = join(persist, "v.json"); writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj)); kv("CONTENT", "put", key, "--path", f); };
const delKV = (key) => kv("CONTENT", "delete", key);
const putMedia = (key, bytes, meta) => { const f = join(persist, "m.bin"); writeFileSync(f, bytes); kv("MEDIA", "put", key, "--path", f, "--metadata", JSON.stringify(meta)); };
const edit = (mut) => { const d = JSON.parse(JSON.stringify(SEED)); mut(Object.fromEntries(d.sections.map((s) => [s.id, s]))); return d; };

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + String(extra).slice(0, 300)}`); };
const inner = (html, id) => (html.match(new RegExp(`<([a-z0-9]+)[^>]*data-cms="${id.replace(".", "\\.")}"[^>]*>([\\s\\S]*?)</\\1>`)) || [])[2];
const get = async (p, h = {}, method = "GET") => { const r = await fetch(BASE + p, { headers: h, redirect: "manual", method }); return { r, t: method === "HEAD" ? "" : await r.text() }; };

const dev = spawn("wrangler", ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist], { stdio: ["ignore", "pipe", "pipe"], detached: true });
let logs = ""; dev.stdout.on("data", (d) => (logs += d)); dev.stderr.on("data", (d) => (logs += d));

try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/old-homepage/"); break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

  // 0. shared module
  check("public/cms/model.js === admin-worker/src/cms-model.js (byte-identical copies)", readFileSync("public/cms/model.js", "utf8") === readFileSync("admin-worker/src/cms-model.js", "utf8"));
  check("seed plan has no element edits (only the accent style)", JSON.stringify(M.plan(M.cleanDoc(SEED), M.DEFAULT_SETTINGS).map((o) => o.op)) === '["css"]');
  check("every data-cms field in the schema exists in index.html", M.SECTIONS.every((s) => s.fields.every((f) => ORIGINAL.includes(`data-cms="${s.id}.${f.key}"`))));
  check("every slot section has a data-cms-slot", M.SECTIONS.every((s) => !s.slot || ORIGINAL.includes(`data-cms-slot="${s.id}"`)));
  let { r, t } = await get("/");
  check("empty KV -> original page byte-identical", r.status === 200 && t === ORIGINAL);

  // 1. Phase 1 key only (what production has before the v2 seed) -> unchanged live output
  putKV("content:homepage", V1_SEED);
  ({ r, t } = await get("/"));
  check("Phase 1 key only -> original + style tag (migration keeps live output)", t === WITH_STYLE);
  putKV("content:homepage", { ...V1_SEED, heroTitle: "পুরনো <i>শিরোনাম</i>", accentColor: "#0B7A55" });
  ({ t } = await get("/"));
  check("Phase 1 key edits still render (escaped title, accent)", inner(t, "hero.title") === "পুরনো &lt;i&gt;শিরোনাম&lt;/i&gt; <em>সম্পূর্ণ ফ্রি।</em>" && t.includes("--gold:#0B7A55;--gold-2:#238766"), inner(t, "hero.title"));

  // 2. v2 seed
  putKV("content:homepage:v2", SEED); putKV("settings:site", SETTINGS);
  ({ r, t } = await get("/"));
  check("v2 seed -> whole page = original + style tag only", t === WITH_STYLE);
  check("v2 key wins over the Phase 1 key", !t.includes("পুরনো"));
  check("cache-control must-revalidate, no etag", r.headers.get("cache-control") === "public, max-age=0, must-revalidate" && !r.headers.get("etag"));
  ({ r, t } = await get("/", { "if-none-match": '"anything"', "if-modified-since": new Date().toUTCString() }));
  check("conditional request still gets full page", r.status === 200 && t === WITH_STYLE);
  ({ r, t } = await get("/index.html"));
  check("/index.html handled (200 rewritten or redirect to /)", (r.status === 200 && t.includes(STYLE_DEFAULT)) || (r.status >= 300 && r.status < 400), r.status);

  // 3. edits
  putKV("content:homepage:v2", edit((s) => {
    s.hero.fields.title = { text: "নতুন <b>শিরোনাম</b> & মূল্য", highlight: "৪৯০০ টাকায়" };
    s.hero.fields.buttons.items.reverse(); s.hero.fields.buttons.items.push({ id: "b9", label: "কল করুন", href: "tel:+8801700000000", style: "green", newTab: false, hidden: false });
    s.hero.fields.badge.hidden = true;
    s.problem.fields.pains.items[1].hidden = true;
    s.how.hidden = true;
    s.packages.extra = [{ id: "e1", type: "heading", text: "অফার <script>" }, { id: "e2", type: "button", label: "যোগাযোগ", href: "#contact", style: "gold", hidden: false }, { id: "e3", type: "image", src: "/media/2026-11-abc.png", alt: "ছবি \"x\"" }];
    s.faq.fields.items.items = [s.faq.fields.items.items[2], { id: "q9", q: "নতুন প্রশ্ন?", a: "উত্তর **জরুরি**" }];
    s.footer.fields.copyright.text = "© ২০২৭ WebDesigner71";
    s.contact.fields.primary.items = [];
  }));
  putKV("settings:site", { ...SETTINGS, siteTitle: "নতুন <টাইটেল>", metaDescription: "নতুন বিবরণ", primaryColor: "#123456", accentColor: "#0B7A55", contactPhone: "+880 1700-000000", contactEmail: "a@b.co" });
  ({ t } = await get("/"));
  check("hero title escaped + highlight", inner(t, "hero.title") === "নতুন &lt;b&gt;শিরোনাম&lt;/b&gt; &amp; মূল্য <em>৪৯০০ টাকায়</em>", inner(t, "hero.title"));
  check("hero buttons reordered + added", inner(t, "hero.buttons") === '<a href="#work" class="btn btn-ghost">কাজের নমুনা দেখুন</a>\n<a href="#packages" class="btn btn-gold">অফার নিন →</a>\n<a href="tel:+8801700000000" class="btn btn-green">কল করুন</a>', inner(t, "hero.buttons"));
  check("hidden field removed (badge)", !t.includes('data-cms="hero.badge"'));
  check("hidden card removed, others kept", !t.includes("ফেসবুকে পোস্ট করলেই") && t.includes("দোকান আছে, অনলাইনে") && t.includes("কাস্টমার ভরসা পায় না"));
  check("hidden section removed (how)", !t.includes('data-cms-section="how"') && !t.includes("ডিজাইন করে দিচ্ছি"));
  check("extras appended, escaped", t.includes('<div class="cms-extra"') && t.includes("অফার &lt;script&gt;") && t.includes('<img src="/media/2026-11-abc.png" alt="ছবি &quot;x&quot;"') && !t.includes("<script>অ"));
  check("faq rebuilt with numbered ids + bold", t.includes('aria-controls="fa1" id="fq1">ডোমেইন ও হোস্টিং কি সত্যিই ফ্রি?') && t.includes('id="fa2"') && t.includes("উত্তর <strong>জরুরি</strong>") && !t.includes("দাম কত?"));
  check("empty replace-mode buttons remove the element", !t.includes('data-cms="contact.primary"'));
  check("footer copyright", inner(t, "footer.copyright") === "© ২০২৭ WebDesigner71");
  check("settings: <title> only in head, escaped", t.includes("<title>নতুন &lt;টাইটেল&gt;</title>") && (t.match(/<title>/g) || []).length === 1);
  check("settings: meta description + theme-color", t.includes('name="description" content="নতুন বিবরণ"') && t.includes('name="theme-color" content="#123456"'));
  check("settings: colors style", t.includes('<style id="wd71-cms">:root{--gold:#0B7A55;--gold-2:#238766;--green:#123456;--green-2:#2E4C6A;--green-3:#204060}</style>'), (t.match(/<style id="wd71-cms">[^<]*/) || [])[0]);
  check("settings: footer contact line", t.includes('<p class="cms-contact"><a href="tel:+8801700000000">+880 1700-000000</a> · <a href="mailto:a@b.co">a@b.co</a></p>'));
  check("untouched sections stay byte-identical (packages cards)", inner(t, "packages.cards") === inner(ORIGINAL, "packages.cards"));

  // 4. preview ignores KV
  ({ r, t } = await get("/?cms_preview=1"));
  check("cms_preview=1 page = original + noindex only (ignores KV)", t === ORIGINAL.replace("</head>", '<meta name="robots" content="noindex"></head>'));
  check("cms_preview=1 no-store", r.headers.get("cache-control") === "no-store");

  // 5. fail-safe
  putKV("content:homepage:v2", edit((s) => { s.hero.fields.buttons.items[0].href = "javascript:alert(1)"; }));
  ({ t } = await get("/"));
  check("unsafe href in KV -> original page", t === ORIGINAL);
  putKV("content:homepage:v2", edit((s) => { s.packages.extra = [{ id: "x", type: "image", src: "https://evil.example/x.png" }]; }));
  ({ t } = await get("/"));
  check("external image in KV -> original page", t === ORIGINAL);
  putKV("content:homepage:v2", SEED); putKV("settings:site", { ...SETTINGS, accentColor: "red;}body{display:none" });
  ({ t } = await get("/"));
  check("invalid settings -> original page", t === ORIGINAL);
  putKV("settings:site", SETTINGS); putKV("content:homepage:v2", "not json{");
  ({ r, t } = await get("/"));
  check("corrupt v2 value -> original page", r.status === 200 && t === ORIGINAL);
  putKV("content:homepage:v2", SEED);
  ({ t } = await get("/"));
  check("restored seed -> original + style", t === WITH_STYLE);

  // 6. media
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  putMedia("2026-11-test01.png", png, { contentType: "image/png", size: png.length, alt: "t" });
  putMedia("2026-11-evil.svg", Buffer.from("<svg onload=alert(1)>"), { contentType: "image/svg+xml", size: 21 });
  ({ r } = await get("/media/2026-11-test01.png"));
  const bytes = Buffer.from(await (await fetch(BASE + "/media/2026-11-test01.png")).arrayBuffer());
  check("/media/<key> -> 200 image/png, same bytes", r.status === 200 && r.headers.get("content-type") === "image/png" && bytes.equals(png), r.status);
  check("/media long immutable cache + nosniff + CSP sandbox", r.headers.get("cache-control") === "public, max-age=31536000, immutable" && r.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(r.headers.get("content-security-policy") || ""));
  ({ r } = await get("/media/2026-11-test01.png", { "if-none-match": r.headers.get("etag") }));
  check("/media etag -> 304", r.status === 304, r.status);
  ({ r } = await get("/media/2026-11-test01.png", {}, "HEAD"));
  check("/media HEAD -> 200", r.status === 200 && r.headers.get("content-type") === "image/png", r.status);
  ({ r } = await get("/media/2026-11-evil.svg"));
  check("/media non-whitelisted type (svg) -> 404", r.status === 404, r.status);
  for (const p of ["/media/missing.png", "/media/..%2fwrangler.jsonc", "/media/", "/media/a%00b.png"]) { ({ r } = await get(p)); check(`${p} -> 404`, r.status === 404, r.status); }

  // 7. other paths untouched
  for (const [p, f] of [["/admin/", "public/admin/index.html"], ["/old-homepage/", "public/old-homepage/index.html"], ["/old-homepage/style.css", "public/old-homepage/style.css"], ["/old-homepage/script.js", "public/old-homepage/script.js"], ["/CNAME", "public/CNAME"], ["/cms/model.js", "public/cms/model.js"], ["/assets/hero-illustration.svg", "public/assets/hero-illustration.svg"]]) {
    ({ r, t } = await get(p));
    check(`${p} -> 200, identical to file`, r.status === 200 && t === readFileSync(f, "utf8"), r.status);
  }
  for (const p of ["/wrangler.jsonc", "/.gitignore", "/docs/cms-phase1.md", "/docs/cms-phase2.md", "/admin-worker/src/index.js", "/admin-worker/src/cms-model.js", "/admin-worker/wrangler.jsonc", "/site-worker/src/index.js", "/public/index.html"]) {
    ({ r } = await get(p));
    check(`${p} -> 404`, r.status === 404, r.status);
  }

  // 8. Phase 3 pages
  check("public/cms/pages.js === admin-worker/src/cms-pages.js (byte-identical copies)", readFileSync("public/cms/pages.js", "utf8") === readFileSync("admin-worker/src/cms-pages.js", "utf8"));
  const dirs = readdirSync("public").filter((d) => statSync(join("public", d)).isDirectory());
  check("every public/ directory is a reserved slug", dirs.every((d) => PG.RESERVED_SLUGS.includes(d)), dirs.join());
  const homeBefore = (await get("/")).t;
  const statusBefore = {};
  for (const p of ["/admin", "/admin/", "/old-homepage", "/old-homepage/", "/cms/", "/cms", "/media", "/assets/", "/index.html", "/CNAME"]) statusBefore[p] = (await get(p)).r.status;
  // <meta content="..."> values are inert text (HTMLRewriter escapes the quote); drop only those before scanning for live markup
  const noAttr = (html) => html.replace(/(<meta\b[^>]*?\scontent=)"[^"]*"/g, '$1""');
  const XSS = '<img src=x onerror=alert(1)>"\'</title><script>alert(1)</script>';
  const all = []; // one of every block type, each in a legal parent
  for (const type of PG.BLOCK_TYPES) {
    if (type === "column" || type === "columns") continue;
    const b = PG.newBlock(type);
    if (type === "section") b.children = [PG.newBlock("heading")];
    all.push(b);
  }
  const colsB = PG.newBlock("columns", "1-1"); colsB.children[0].children.push(PG.newBlock("text")); colsB.children[1].children.push(PG.newBlock("image"));
  all.push(colsB);
  const h = PG.newBlock("heading"); h.content.text = "Hi " + XSS; h.style = { color: "accent", size: 40, m: { size: 28 } }; h.adv = { anchor: "intro", cls: "my-x" };
  const btn = PG.newBlock("buttons"); btn.content.buttons[0].label = "<script>alert(1)</script>";
  const vid = PG.newBlock("video"); vid.content.url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const hid = PG.newBlock("text"); hid.hidden = true; hid.content.html = "<p>SECRET-HIDDEN</p>";
  all.unshift(h, btn); all.push(vid, hid);
  const doc = { id: "ptest00001", slug: "all-blocks", title: "সব ব্লক " + XSS, seo: { title: "", description: "Desc " + XSS, image: "/assets/hero-illustration.svg", noindex: false }, blocks: all, version: 3 };
  check("test page passes the server validator", (() => { try { PG.cleanPageInput(doc); return true; } catch (e) { console.log(e.field, e.reason); return false; } })());
  putKV("pub:all-blocks", PG.publishedSnapshot(doc, "2026-11-02T00:00:00.000Z"));
  ({ r, t } = await get("/all-blocks"));
  check("published page -> 200 html", r.status === 200 && /text\/html/.test(r.headers.get("content-type")), r.status);
  const missing = PG.BLOCK_TYPES.filter((x) => !new RegExp('class="pb pb-' + x + '[ "]').test(t));
  check("every block type rendered (pb-<type>)", missing.length === 0, missing.join());
  check("page uses the site shell (header, footer, site CSS)", t.includes('data-cms="header.') && t.includes('data-cms-slot="footer"') && t.includes("--green:#0B3D2E") && t.includes('<style id="wd71-page">'));
  check("homepage <main> content not on the page", !t.includes('id="packages"') && !t.includes('data-cms="hero.title"'));
  check("title escaped + suffixed", t.includes("<title>সব ব্লক &lt;img src=x onerror=alert(1)&gt;\"'&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; | WebDesigner71</title>"), (t.match(/<title>[^]*?<\/title>/) || [])[0]);
  check("no raw XSS anywhere", !/<script>alert|<img src=x|onerror=alert\(1\)>/.test(noAttr(t)), ((m) => m && t.slice(Math.max(0, m.index - 200), m.index + 80))(t.match(/<script>alert|<img src=x|onerror=alert\(1\)>/)));
  check("XSS text shown escaped in heading + button", (t.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) || []).length >= 3);
  check("canonical + og:url point at the page", t.includes('<link rel="canonical" href="http://127.0.0.1:' + PORT + '/all-blocks">'), (t.match(/<link rel="canonical"[^>]*>/) || [])[0]);
  check("og:image absolute, description set", t.includes('og:image" content="http://127.0.0.1:' + PORT + '/assets/hero-illustration.svg"') && t.includes('name="description" content="Desc <img src=x onerror=alert(1)>&quot;'), (t.match(/og:image[^>]*>/)||[])[0] + " " + (t.match(/name="description"[^>]*>/)||[])[0]);
  check("header in-page anchors point back to the homepage", t.includes('href="/#packages"') && !/<header[^]*?href="#packages"[^]*?<\/header>/.test(t));
  check("hidden blocks are not rendered publicly", !t.includes("SECRET-HIDDEN"));
  check("anchor id + extra class + style rules", t.includes('id="intro"') && t.includes("my-x") && new RegExp("\\.pb\\.b-" + h.id + "\\{[^}]*font-size:40px").test(t) && t.includes("@media (max-width:767px)"));
  check("video embedded from youtube-nocookie only", t.includes("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ") && !t.includes("youtube.com/watch"));
  check("editor-only markup absent publicly", !t.includes("pb-ph") && !t.includes("pb-drop") && !t.includes("page-bridge"));
  ({ r, t } = await get("/all-blocks/"));
  check("trailing slash -> same page, canonical without slash", r.status === 200 && t.includes("/all-blocks\">") && !t.includes("/all-blocks/\""));
  ({ r, t } = await get("/all-blocks", {}, "HEAD"));
  check("HEAD page -> 200", r.status === 200);

  // tampered KV snapshots are re-validated: unsafe content never renders
  const bad = (mut) => { const d = JSON.parse(JSON.stringify(doc)); mut(d); return PG.publishedSnapshot(d, "2026-11-02T00:00:00.000Z"); };
  const cases = [
    ["javascript: href", (d) => { d.blocks[1].content.buttons[0].href = "javascript:alert(1)"; }],
    ["data: image", (d) => { d.blocks.find((b) => b.type === "image").content.src = "data:image/svg+xml,<svg onload=alert(1)>"; }],
    ["external image", (d) => { d.blocks.find((b) => b.type === "image").content.src = "https://evil.example/a.png"; }],
    ["css injection", (d) => { d.blocks[0].style.color = "red}</style><script>alert(1)</script>"; }],
    ["raw html in rich text", (d) => { d.blocks.find((b) => b.type === "text").content.html = "<p onclick=x>ok</p><script>alert(1)</script>"; }],
    ["iframe video from elsewhere", (d) => { d.blocks.find((b) => b.type === "video").content.url = "https://evil.example/embed"; }],
  ];
  for (const [name, mut] of cases) {
    putKV("pub:tamper", bad(mut));
    ({ r, t } = await get("/tamper"));
    const ok = (r.status === 404 && t.includes("pb-404")) || (r.status === 200 && !/<script>alert|onclick=|javascript:|evil\.example|data:image/.test(noAttr(t)));
    check("tampered KV (" + name + ") never renders unsafe", ok, r.status + " " + ((m) => m ? t.slice(Math.max(0, m.index - 150), m.index + 80) : "")(t.match(/<script>alert|onclick=|javascript:|evil\.example|data:image/)));
  }
  delKV("pub:tamper");

  // drafts, unknown slugs, styled 404
  putKV("page:pdraft0001", { ...doc, id: "pdraft0001", slug: "draft-page", status: "draft" });
  ({ r, t } = await get("/draft-page"));
  check("draft page (doc only, no pub key) -> styled 404", r.status === 404 && t.includes("pb-404") && t.includes('data-cms-slot="footer"'), r.status);
  check("404 page noindex", t.includes('<meta name="robots" content="noindex">') && r.headers.get("x-robots-tag") === "noindex");
  for (const p of ["/nope", "/a/b", "/Upper", "/a--b", "/" + "a".repeat(61)]) { ({ r, t } = await get(p)); check(`${p} -> styled 404`, r.status === 404 && t.includes("pb-404"), r.status); }
  ({ r, t } = await get("/missing.png"));
  check("/missing.png -> plain asset 404 (not the HTML page)", r.status === 404 && !t.includes("pb-404"), r.status);
  ({ r } = await get("/nope", {}, "HEAD"));
  check("HEAD unknown -> 404", r.status === 404);
  ({ r, t } = await get("/all-blocks", {}, "POST"));
  check("POST to a page path -> not rendered", !t.includes("pb-root"), r.status);

  // reserved paths keep priority even with a (forged) pub key of the same name
  for (const k of ["admin", "old-homepage", "cms", "media", "assets", "index"]) putKV("pub:" + k, { ...PG.publishedSnapshot(doc, "x"), slug: k });
  for (const [p, st] of Object.entries(statusBefore)) { ({ r, t } = await get(p)); check(`${p} unchanged by pages (${st})`, r.status === st && !t.includes("pb-root"), r.status + " vs " + st); }
  ({ r, t } = await get("/admin/"));
  check("/admin/ still the admin app", t === readFileSync("public/admin/index.html", "utf8"));
  for (const k of ["admin", "old-homepage", "cms", "media", "assets", "index"]) delKV("pub:" + k);

  // redirects
  putKV("redirect:old-slug", { to: "all-blocks", page: "ptest00001" });
  ({ r } = await get("/old-slug"));
  check("moved slug -> 301 to new slug", r.status === 301 && r.headers.get("location") === "/all-blocks", r.status + " " + r.headers.get("location"));
  putKV("redirect:evil", { to: "//evil.example" });
  ({ r } = await get("/evil"));
  check("redirect to a non-slug target refused -> 404", r.status === 404, r.status);
  delKV("redirect:evil");
  putKV("pub:old-slug", PG.publishedSnapshot({ ...doc, slug: "old-slug" }, "x"));
  ({ r } = await get("/old-slug"));
  check("a live page wins over a stale redirect", r.status === 200, r.status);
  delKV("pub:old-slug"); delKV("redirect:old-slug");

  // sitemap
  putKV("pages:index", { pages: [
    PG.indexEntry({ ...doc, status: "published", publishedSlug: "all-blocks", updatedAt: "2026-11-02T00:00:00Z", publishedAt: "2026-11-02T01:00:00Z" }),
    PG.indexEntry({ ...doc, id: "phidden001", status: "published", publishedSlug: "hidden-page", seo: { noindex: true } }),
    PG.indexEntry({ ...doc, id: "pdraft0001", slug: "draft-page", status: "draft" }),
    { id: "pbadxx0001", status: "published", publishedSlug: "<script>" },
  ] });
  ({ r, t } = await get("/sitemap.xml"));
  check("sitemap.xml: xml, home + published indexable pages only", r.status === 200 && /xml/.test(r.headers.get("content-type")) && t.includes("/all-blocks</loc><lastmod>2026-11-02</lastmod>") && !t.includes("hidden-page") && !t.includes("draft-page") && !t.includes("script") && (t.match(/<url>/g) || []).length === 2, t);

  // editor preview shell
  ({ r, t } = await get("/__page-preview"));
  check("/__page-preview: empty shell + bridge, noindex, no-store, same-origin frames only",
    r.status === 200 && t.includes('src="/cms/page-bridge.js"') && t.includes('<div class="pb-root"></div>') && r.headers.get("cache-control") === "no-store" && /frame-ancestors 'self'/.test(r.headers.get("content-security-policy") || "") && t.includes('content="noindex"'), r.status);
  ({ r, t } = await get("/cms/page-bridge.js"));
  check("/cms/page-bridge.js served as a static file", r.status === 200 && t === readFileSync("public/cms/page-bridge.js", "utf8"));

  // homepage byte-identical with pages present, and after they are gone
  ({ t } = await get("/"));
  check("homepage byte-identical while pages exist", t === homeBefore);
  delKV("pub:all-blocks"); delKV("page:pdraft0001"); delKV("pages:index");
  ({ r, t } = await get("/"));
  check("homepage byte-identical after pages removed", t === homeBefore);
  ({ r } = await get("/all-blocks"));
  check("deleted page -> 404", r.status === 404);
  ({ r, t } = await get("/sitemap.xml"));
  check("sitemap with no pages = homepage only", (t.match(/<url>/g) || []).length === 1);

  // ---------------------------------------------------------------- Phase 4: blog
  check("public/cms/posts.js === admin-worker/src/cms-posts.js (import line normalised)", readFileSync("public/cms/posts.js", "utf8") === readFileSync("admin-worker/src/cms-posts.js", "utf8").replace('from "./cms-pages.js"', 'from "./pages.js"'));
  ({ r, t } = await get("/blog"));
  check("/blog with no posts -> 200 empty state, noindex", r.status === 200 && t.includes("শীঘ্রই নতুন লেখা আসছে") && /noindex/.test(r.headers.get("x-robots-tag") || ""), r.status);
  ({ r, t } = await get("/blog/feed.xml"));
  check("/blog/feed.xml with no posts -> valid empty RSS", r.status === 200 && /rss\+xml/.test(r.headers.get("content-type")) && t.includes("<rss") && !t.includes("<item>"));
  const T0 = Date.now();
  const iso = (d) => new Date(T0 + d * 86400000).toISOString();
  const TERMS = { categories: [{ id: "cdesign01", name: "ডিজাইন", slug: "design" }, { id: "cseo00001", name: "SEO", slug: "seo" }], tags: [{ id: "tbangla01", name: "বাংলা", slug: "bangla" }] };
  const postBlocks = [
    { id: "btoc0001", type: "toc", content: {} },
    { id: "bhead001", type: "heading", content: { text: "শুরু করার আগে", level: "h2" } },
    { id: "btext001", type: "text", content: { html: "<p>" + "লেখা ".repeat(420) + "</p>" } },
    { id: "bcode001", type: "code", content: { code: "<script>alert(1)</script>\n\tok();", lang: "html" } },
    { id: "bcall001", type: "callout", content: { variant: "tip", title: "টিপস", text: "মনে রাখুন" } },
    { id: "bgal0001", type: "gallery", content: { items: [{ image: "/media/abc.png", alt: "ছবি ১" }, { image: "/media/def.png", alt: "ছবি ২" }], cols: 2 } },
  ];
  const snap = (n, d, extra = {}) => ({ schema: 1, id: "qpost0000" + n, slug: "post-" + n, title: "পোস্ট নম্বর " + n + " <b>", excerpt: "সারাংশ " + n, image: n === 1 ? "/media/abc.png" : "", imageAlt: "",
    categories: n % 2 ? ["cdesign01"] : ["cseo00001", "cgone0001"], tags: n === 1 ? ["tbangla01"] : [], author: "মোশফিক", date: iso(-n), seo: { title: "", description: "", image: "", noindex: false },
    blocks: postBlocks, readMin: 2, version: 1, publishedAt: iso(-n), updatedAt: iso(-n), ...extra });
  const snaps = [];
  for (let n = 1; n <= 11; n++) snaps.push(snap(n, -n));
  snaps.push(snap(12, 0, { date: iso(2), slug: "future-post", title: "ভবিষ্যতের পোস্ট" })); // scheduled
  snaps.push(snap(13, 0, { slug: "hidden-post", seo: { title: "", description: "", image: "", noindex: true } }));
  putKV("posts:public", { posts: snaps.map((s) => ({ ...PO.publicEntry(s) })) });
  putKV("posts:terms", TERMS);
  for (const s of [snaps[0], snaps[1], snaps[11], snaps[12]]) putKV("postpub:" + s.slug, s);
  putKV("postredirect:old-post", { to: "post-1", post: "qpost00001" });
  putKV("postredirect:evil-post", { to: "//evil.example" });

  ({ r, t } = await get("/blog"));
  check("/blog: 200, 9 cards, featured first card, pager to page 2", r.status === 200 && (t.match(/<article class="wb-card/g) || []).length === 9 && t.includes("wb-card wb-feat") && t.includes('href="/blog/page/2"') && !(r.headers.get("x-robots-tag") || "").includes("noindex"), (t.match(/<article class="wb-card/g) || []).length);
  check("/blog: scheduled post hidden, titles escaped, canonical, RSS link, Bengali date", !t.includes("ভবিষ্যতের পোস্ট") && t.includes("পোস্ট নম্বর 1 &lt;b&gt;") && !t.includes("পোস্ট নম্বর 1 <b>") && t.includes('<link rel="canonical" href="http://127.0.0.1:8798/blog">') && t.includes('type="application/rss+xml"') && /[০-৯]+ (জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর) [০-৯]{4}/.test(t));
  check("/blog: same site header/footer as homepage", t.includes("<header") && t.includes("<footer") && t.includes('<main id="top" class="pb-page">'));
  ({ r, t } = await get("/blog/"));
  check("/blog/ -> same list (canonical without slash)", r.status === 200 && t.includes('href="http://127.0.0.1:8798/blog"'));
  ({ r, t } = await get("/blog/page/2"));
  check("/blog/page/2: remaining 3 cards, no featured", r.status === 200 && (t.match(/<article class="wb-card/g) || []).length === 3 && !t.includes("wb-card wb-feat"), (t.match(/<article class="wb-card/g) || []).length);
  ({ r } = await get("/blog/page/1"));
  check("/blog/page/1 -> 301 /blog", r.status === 301 && r.headers.get("location") === "/blog");
  ({ r } = await get("/blog/page/3"));
  check("/blog/page/3 (out of range) -> 404", r.status === 404);
  ({ r } = await get("/blog/page/0"));
  check("/blog/page/0 -> 404", r.status === 404);
  ({ r, t } = await get("/blog/category/design"));
  check("/blog/category/design: only that category", r.status === 200 && (t.match(/<article class="wb-card/g) || []).length === 7 && t.includes("ডিজাইন"), (t.match(/<article class="wb-card/g) || []).length);
  ({ r, t } = await get("/blog/tag/bangla"));
  check("/blog/tag/bangla: one post", r.status === 200 && (t.match(/<article class="wb-card/g) || []).length === 1);
  ({ r } = await get("/blog/category/nope"));
  check("/blog/category/<unknown> -> 404", r.status === 404);
  ({ r } = await get("/blog/category/design/page/2"));
  check("/blog/category/design/page/2 (out of range) -> 404", r.status === 404);

  ({ r, t } = await get("/blog/post-1"));
  check("/blog/<slug>: 200 article with title, author, reading time, date", r.status === 200 && t.includes('<h1 class="wb-title">পোস্ট নম্বর 1 &lt;b&gt;</h1>') && t.includes("মোশফিক") && t.includes("মিনিটে পড়া") && t.includes("<time datetime="));
  check("/blog/<slug>: category + tag links, share links, related posts, prev link", t.includes('href="/blog/category/design"') && t.includes('href="/blog/tag/bangla"') && t.includes("facebook.com/sharer") && t.includes("আরও পড়ুন") && t.includes('rel="prev" href="/blog/post-2"') && !t.includes('rel="next"'));
  check("/blog/<slug>: og:type article, JSON-LD BlogPosting, canonical, og:image", t.includes('<meta property="og:type" content="article">') && t.includes('"@type":"BlogPosting"') && t.includes('<link rel="canonical" href="http://127.0.0.1:8798/blog/post-1">') && t.includes('og:image" content="http://127.0.0.1:8798/media/abc.png"'));
  check("/blog/<slug>: toc with heading anchor, code escaped, callout, gallery", t.includes('class="pb-toc') && t.includes('id="h-bhead001"') && t.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !t.includes("<script>alert(1)") && t.includes("pb-callout") && t.includes("/media/abc.png") && !t.includes("evil.example"));
  check("/blog/<slug>: JSON-LD can't break out of its script tag", (t.match(/<\/script>/g) || []).length === (t.match(/<script/g) || []).length);
  ({ r, t } = await get("/blog/post-2"));
  check("/blog/post-2: deleted category ignored, next + prev links", r.status === 200 && t.includes('href="/blog/category/seo"') && !t.includes("cgone0001") && t.includes('rel="next" href="/blog/post-1"') && t.includes('rel="prev" href="/blog/post-3"'));
  putKV("postpub:post-3", { ...snaps[2], blocks: [{ id: "bgal0002", type: "gallery", content: { items: [{ image: "https://evil.example/x.png", alt: "x" }] } }] });
  ({ r, t } = await get("/blog/post-3"));
  check("tampered snapshot (external image) -> 404, never rendered", r.status === 404 && !t.includes("evil.example"));
  putKV("postpub:post-3", { ...snaps[2], image: "javascript:alert(1)" });
  ({ r, t } = await get("/blog/post-3"));
  check("tampered snapshot (javascript: image) -> 404", r.status === 404 && !t.includes("javascript:"));
  delKV("postpub:post-3");
  ({ r } = await get("/blog/future-post"));
  check("scheduled post (future date) -> 404 until its time", r.status === 404);
  ({ r, t } = await get("/blog/hidden-post"));
  check("noindex post -> 200 with noindex", r.status === 200 && /noindex/.test(r.headers.get("x-robots-tag") || "") && t.includes('<meta name="robots" content="noindex">'));
  ({ r } = await get("/blog/old-post?x=1"));
  check("post redirect -> 301 /blog/post-1 (query kept)", r.status === 301 && r.headers.get("location") === "/blog/post-1?x=1");
  ({ r } = await get("/blog/evil-post"));
  check("bad post redirect target ignored -> 404", r.status === 404);
  ({ r } = await get("/blog/post-5"));
  check("listed but no postpub key -> 404", r.status === 404);
  ({ r } = await get("/blog/Post-1"));
  check("uppercase / bad slug -> 404", r.status === 404);
  ({ r } = await get("/blog/a/b/c"));
  check("deep unknown blog path -> 404", r.status === 404);
  ({ r } = await get("/post-1"));
  check("post slug is not a page at the root", r.status === 404);
  ({ r, t } = await get("/blog/post-1", {}, "HEAD"));
  check("HEAD /blog/<slug> -> 200, no body", r.status === 200);

  ({ r, t } = await get("/blog/feed.xml"));
  check("RSS: 12 visible posts (scheduled excluded), absolute links, escaped", r.status === 200 && (t.match(/<item>/g) || []).length === 12 && t.includes("<link>http://127.0.0.1:8798/blog/post-1</link>") && !t.includes("future-post") && t.includes("পোস্ট নম্বর 1 &lt;b&gt;") && t.includes("<dc:creator>"), (t.match(/<item>/g) || []).length);
  ({ r, t } = await get("/sitemap.xml"));
  check("sitemap: /blog + visible indexable posts (no scheduled, no noindex)", t.includes("/blog</loc>") && t.includes("/blog/post-1</loc>") && !t.includes("future-post") && !t.includes("hidden-post") && (t.match(/<url>/g) || []).length === 1 + 1 + 11, (t.match(/<url>/g) || []).length);
  putKV("posts:public", "not json{");
  ({ r } = await get("/blog"));
  check("corrupt posts:public -> blog still answers (404 page, no crash)", r.status === 404 || r.status === 200);
  ({ r, t } = await get("/sitemap.xml"));
  check("corrupt posts:public -> sitemap still served", r.status === 200 && t.includes("<urlset"));
  ({ t } = await get("/"));
  check("homepage byte-identical while posts exist", t === homeBefore);
  for (const k of ["posts:public", "posts:terms", "postpub:post-1", "postpub:post-2", "postpub:future-post", "postpub:hidden-post", "postredirect:old-post", "postredirect:evil-post"]) delKV(k);
  ({ r, t } = await get("/blog/post-1"));
  check("deleted post -> 404", r.status === 404);
  ({ t } = await get("/"));
  check("homepage byte-identical after posts removed", t === homeBefore);
} catch (e) {
  fail++; console.error("ERROR", e, logs.slice(-1500));
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  setTimeout(() => { rmSync(persist, { recursive: true, force: true }); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 500);
}
