// Local checks for the site Worker (CMS Phase 2). Run from the repo root with wrangler on PATH:  node site-worker/test/check.mjs
// Uses `wrangler dev --local` with a throwaway KV store; never touches production.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as M from "../../public/cms/model.js";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "wd71site-"));
const ORIGINAL = readFileSync("public/index.html", "utf8");
const V1_SEED = {
  heroTitle: "আপনার ব্যবসার ওয়েবসাইট, মাত্র", heroHighlight: "৩৯০০ টাকায়",
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
  check("Phase 1 key edits still render (escaped title, accent)", inner(t, "hero.title") === "পুরনো &lt;i&gt;শিরোনাম&lt;/i&gt; <em>৩৯০০ টাকায়</em>" && t.includes("--gold:#0B7A55;--gold-2:#238766"), inner(t, "hero.title"));

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
} catch (e) {
  fail++; console.error("ERROR", e, logs.slice(-1500));
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  setTimeout(() => { rmSync(persist, { recursive: true, force: true }); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 500);
}
