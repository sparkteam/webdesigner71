/**
 * WebDesigner71 CMS — blog posts model, sanitizer & renderer (Phase 4).
 *
 * Builds on pages.js (same blocks, same sanitizer, same renderer) — posts are pages with blog metadata.
 * Used by: site-worker (renders /blog/*), page-bridge.js (exact editor preview), the admin panel (schema/limits),
 * and admin-worker/src/cms-posts.js (identical except for the import path; check.mjs enforces it).
 *
 * KV CONTENT keys:
 *   "posts:index"          { posts:[ IndexEntry ] }      admin list (drafts, published, scheduled, trash)
 *   "post:<id>"            Post (working copy, version-checked)
 *   "postpub:<slug>"       published snapshot — the only per-post key the public site reads
 *   "postredirect:<slug>"  { to:<slug>, post:<id> }      301 left behind when a published post changes slug
 *   "posts:public"         { posts:[ PublicEntry ] }     published (incl. scheduled) list for /blog, feed, sitemap
 *   "posts:terms"          { categories:[Term], tags:[Term], version }
 *
 * "Scheduled" is not a stored state: a published post whose date is in the future. The public side filters by
 * date at request time, so it appears automatically when the time passes (no cron; KV cache ≤ 60 s).
 */
import * as PG from "./cms-pages.js";

const { PageError } = PG;
const esc = PG.escHtml;
export const POST_SCHEMA = 1;
export const QKEYS = {
  index: "posts:index",
  post: (id) => "post:" + id,
  prev: (id) => "post:" + id + ":prev",
  pub: (slug) => "postpub:" + slug,
  redirect: (slug) => "postredirect:" + slug,
  list: "posts:public",
  terms: "posts:terms",
};
export const POST_LIMITS = { posts: 500, categories: 50, tags: 200, postCategories: 5, postTags: 15, title: 160, excerpt: 300,
  author: 80, termName: 40, perPage: 9, related: 3, feed: 20, redirects: 10 };
export const POST_ID_RE = /^q[a-z0-9]{6,20}$/;
export const TERM_ID_RE = /^[ct][a-z0-9]{6,12}$/;
/** Words that would collide with /blog/<word>/… routes. */
export const RESERVED_POST_SLUGS = ["page", "category", "tag", "feed", "feed-xml", "rss", "preview", "index", "search", "author"];
const rnd = (n) => { let s = ""; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
export const newPostId = () => "q" + rnd(10);
export const newTermId = (kind) => (kind === "tag" ? "t" : "c") + rnd(8);
const clen = (s) => [...s].length;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function str(v, path, max, o = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new PageError(path, "type");
  let t = o.multiline ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : v.replace(/\s+/g, " ").trim();
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (clen(t) > max) throw new PageError(path, "too_long");
  if (o.min && clen(t) < o.min) throw new PageError(path, "required");
  return t;
}
/** null when fine, else a reason: required | too_long | format | reserved */
export function postSlugProblem(s) {
  if (!s) return "required";
  if (s.length > PG.SLUG_MAX) return "too_long";
  if (!PG.SLUG_RE.test(s)) return "format";
  if (RESERVED_POST_SLUGS.includes(s)) return "reserved";
  return null;
}
export function termSlugProblem(s) {
  if (!s) return "required";
  if (s.length > 40) return "too_long";
  if (!PG.SLUG_RE.test(s)) return "format";
  if (s === "page") return "reserved";
  return null;
}
/** Latin slug from a title; Bengali-only titles fall back to "post-<rand>" (callers may pass a fallback). */
export function slugify(title, fallback) {
  const s = String(title || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return s.length >= 2 ? s : fallback || "post-" + rnd(5);
}
function cleanDate(v, path) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || v.length > 40) throw new PageError(path, "type");
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.UTC(2100, 0, 1)) throw new PageError(path, "date");
  return new Date(t).toISOString();
}
function cleanIds(v, path, max, prefix) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new PageError(path, "type");
  const out = [];
  for (const id of v) {
    if (typeof id !== "string" || !TERM_ID_RE.test(id) || id[0] !== prefix) throw new PageError(path, "invalid");
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > max) throw new PageError(path, "too_many");
  return out;
}
const POST_KEYS = ["title", "slug", "excerpt", "image", "imageAlt", "categories", "tags", "author", "date", "seo", "blocks"];
/** Validate the editable part of a post. Returns a canonical copy; throws PageError(field, reason). */
export function cleanPostInput(raw) {
  if (!isObj(raw)) throw new PageError("post", "type");
  for (const k of Object.keys(raw)) if (!POST_KEYS.includes(k)) throw new PageError(k, "unknown");
  const title = str(raw.title, "title", POST_LIMITS.title, { min: 1 });
  const slug = typeof raw.slug === "string" ? raw.slug.trim().toLowerCase() : "";
  const sp = postSlugProblem(slug);
  if (sp) throw new PageError("slug", sp);
  let image = "";
  if (raw.image) { image = PG.safeImg(raw.image); if (!image) throw new PageError("image", "image"); }
  const blocks = PG.cleanBlocks(raw.blocks === undefined ? [] : raw.blocks);
  const out = {
    title, slug,
    excerpt: str(raw.excerpt, "excerpt", POST_LIMITS.excerpt, { multiline: true }),
    image, imageAlt: str(raw.imageAlt, "imageAlt", 150),
    categories: cleanIds(raw.categories, "categories", POST_LIMITS.postCategories, "c"),
    tags: cleanIds(raw.tags, "tags", POST_LIMITS.postTags, "t"),
    author: str(raw.author, "author", POST_LIMITS.author),
    date: cleanDate(raw.date, "date"),
    seo: PG.cleanSeo(raw.seo),
    blocks,
  };
  if (PG.jsonBytes(out) > PG.LIMITS.bytes) throw new PageError("blocks", "too_large");
  return out;
}
/** Terms document (categories + tags). Tolerant: invalid entries are dropped. */
export function cleanTerms(raw) {
  const pick = (list, prefix, max) => {
    const out = [], seen = new Set();
    for (const t of Array.isArray(list) ? list : []) {
      if (!isObj(t) || typeof t.id !== "string" || !TERM_ID_RE.test(t.id) || t.id[0] !== prefix) continue;
      let name; try { name = str(t.name, "name", POST_LIMITS.termName, { min: 1 }); } catch { continue; }
      if (termSlugProblem(t.slug) || seen.has(t.slug)) continue;
      seen.add(t.slug); out.push({ id: t.id, slug: t.slug, name });
      if (out.length >= max) break;
    }
    return out;
  };
  const r = isObj(raw) ? raw : {};
  return { categories: pick(r.categories, "c", POST_LIMITS.categories), tags: pick(r.tags, "t", POST_LIMITS.tags), version: Number.isInteger(r.version) ? r.version : 0 };
}
export const cleanTermName = (v) => str(v, "name", POST_LIMITS.termName, { min: 1 });
export function termMaps(terms) {
  const t = terms || { categories: [], tags: [] };
  const m = { cat: new Map(), tag: new Map(), catSlug: new Map(), tagSlug: new Map() };
  for (const c of t.categories || []) { m.cat.set(c.id, c); m.catSlug.set(c.slug, c); }
  for (const g of t.tags || []) { m.tag.set(g.id, g); m.tagSlug.set(g.slug, g); }
  return m;
}

/* ------------------------------------------------------------------ derived values */
export function wordCount(blocks) { const t = PG.blockText(blocks); return t ? t.split(/\s+/).length : 0; }
/** ~200 words/minute, at least 1. */
export function readingMinutes(blocks) { return Math.max(1, Math.round(wordCount(blocks) / 200)); }
export function autoExcerpt(blocks, max = 180) {
  const parts = [];
  const walk = (list) => { for (const b of list || []) { if (b.hidden) continue; if (b.type === "text" || b.type === "quote" || b.type === "callout") parts.push(PG.blockText([b])); walk(b.children); } };
  walk(blocks);
  let t = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!t) t = PG.blockText(blocks);
  if (clen(t) <= max) return t;
  const cut = [...t].slice(0, max).join("");
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:।\s]+$/, "") + "…";
}
/** draft | published | scheduled | trash */
export function postStatus(p, now = Date.now()) {
  if (!p) return "draft";
  if (p.status === "trash") return "trash";
  if (p.status !== "published") return "draft";
  return p.date && Date.parse(p.date) > now ? "scheduled" : "published";
}
const DRAFT_KEYS = ["title", "slug", "excerpt", "image", "imageAlt", "categories", "tags", "author", "date", "seo", "blocks"];
export const postChanged = (doc, snap) => !snap || DRAFT_KEYS.some((k) => JSON.stringify(doc[k]) !== JSON.stringify(snap[k]));
export function indexEntry(doc) {
  return {
    id: doc.id, title: doc.title, slug: doc.slug, status: doc.status, date: doc.date || "", author: doc.author || "",
    categories: doc.categories || [], tags: doc.tags || [], image: doc.image || "", publishedSlug: doc.publishedSlug || "",
    changed: doc.status === "published" && doc.version !== doc.publishedVersion, blocks: PG.countBlocks(doc.blocks), readMin: readingMinutes(doc.blocks), excerpt: (doc.excerpt || autoExcerpt(doc.blocks, 140)),
    updatedAt: doc.updatedAt, publishedAt: doc.publishedAt || "", trashedAt: doc.trashedAt || "", version: doc.version,
    media: [...PG.mediaRefs([doc.image, doc.seo, doc.blocks])],
  };
}
export function publishedSnapshot(doc, now) {
  return {
    schema: POST_SCHEMA, id: doc.id, slug: doc.slug, title: doc.title, excerpt: doc.excerpt, image: doc.image, imageAlt: doc.imageAlt,
    categories: doc.categories, tags: doc.tags, author: doc.author, date: doc.date, seo: doc.seo, blocks: doc.blocks,
    readMin: readingMinutes(doc.blocks), version: doc.version, publishedAt: now, updatedAt: doc.updatedAt,
  };
}
export function publicEntry(snap) {
  return {
    id: snap.id, slug: snap.slug, title: snap.title, excerpt: snap.excerpt || autoExcerpt(snap.blocks), image: snap.image || "", imageAlt: snap.imageAlt || "",
    author: snap.author || "", date: snap.date, categories: snap.categories || [], tags: snap.tags || [], readMin: snap.readMin || 1,
    updatedAt: snap.publishedAt || snap.updatedAt || snap.date, noindex: !!(snap.seo && snap.seo.noindex),
  };
}
/** Public entries that are live at `now`, newest first. */
export function visibleEntries(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((e) => e && e.slug && e.date && Date.parse(e.date) <= now)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || (a.id < b.id ? 1 : -1));
}

/* ------------------------------------------------------------------ Bengali dates (Asia/Dhaka, fixed UTC+6) */
const BN_MONTHS = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
export const bn = (n) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);
export function bnDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 6 * 3600 * 1000);
  return bn(d.getUTCDate()) + " " + BN_MONTHS[d.getUTCMonth()] + " " + bn(d.getUTCFullYear());
}
const readLabel = (m) => bn(m || 1) + " মিনিটে পড়া";

/* ------------------------------------------------------------------ rendering */
const attr = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "").map(([k, v]) => (v === true ? " " + k : " " + k + '="' + esc(v) + '"')).join("");
const postUrl = (slug) => "/blog/" + slug;
const catUrl = (t) => "/blog/category/" + t.slug;
const tagUrl = (t) => "/blog/tag/" + t.slug;
const initial = (name) => esc(([...String(name || "W").trim()][0] || "W").toUpperCase());
const catsOf = (e, m) => (e.categories || []).map((id) => m.cat.get(id)).filter(Boolean);
const tagsOf = (e, m) => (e.tags || []).map((id) => m.tag.get(id)).filter(Boolean);
const timeTag = (iso) => (iso ? "<time" + attr({ datetime: iso }) + ">" + esc(bnDate(iso)) + "</time>" : "");

function card(e, m, featured) {
  const cats = catsOf(e, m);
  const img = e.image ? "<img" + attr({ src: e.image, alt: e.imageAlt || "", loading: featured ? "eager" : "lazy", decoding: "async" }) + ">"
    : '<span class="wb-ph" aria-hidden="true">' + initial(e.title) + "</span>";
  return '<article class="wb-card' + (featured ? " wb-feat" : "") + '"><a class="wb-card-img" href="' + esc(postUrl(e.slug)) + '" tabindex="-1" aria-hidden="true">' + img + "</a>" +
    '<div class="wb-card-b">' + (cats.length ? '<div class="wb-cats">' + cats.slice(0, 2).map((c) => '<a href="' + esc(catUrl(c)) + '">' + esc(c.name) + "</a>").join("") + "</div>" : "") +
    "<h2 class=\"wb-card-t\"><a href=\"" + esc(postUrl(e.slug)) + "\">" + esc(e.title) + "</a></h2>" + (e.excerpt ? '<p class="wb-card-x">' + esc(e.excerpt) + "</p>" : "") +
    '<p class="wb-card-m">' + timeTag(e.date) + "<span>" + esc(readLabel(e.readMin)) + "</span></p></div></article>";
}
function pager(base, page, pages) {
  if (pages <= 1) return "";
  const href = (n) => (n === 1 ? base : base + "/page/" + n);
  let nums = "";
  for (let n = 1; n <= pages; n++) {
    if (pages > 7 && n !== 1 && n !== pages && Math.abs(n - page) > 1) { if (!nums.endsWith("…</span>")) nums += '<span class="wb-gap">…</span>'; continue; }
    nums += n === page ? '<span aria-current="page">' + bn(n) + "</span>" : '<a href="' + href(n) + '">' + bn(n) + "</a>";
  }
  return '<nav class="wb-pager" aria-label="পাতা">' + (page > 1 ? '<a class="wb-pg-btn" rel="prev" href="' + href(page - 1) + '">← নতুন লেখা</a>' : "") +
    '<div class="wb-pg-nums">' + nums + "</div>" + (page < pages ? '<a class="wb-pg-btn" rel="next" href="' + href(page + 1) + '">পুরোনো লেখা →</a>' : "") + "</nav>";
}
const RSS_LINK = '<link rel="alternate" type="application/rss+xml" title="WebDesigner71 ব্লগ" href="/blog/feed.xml">';
const ldJson = (o) => '<script type="application/ld+json">' + JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + "</script>";

/**
 * Blog index / category / tag archive. `list` = visibleEntries(...) (already filtered + sorted).
 * Returns null when the page number is out of range (caller → 404).
 */
export function renderBlogList({ list, terms, page = 1, term = null, kind = "all", origin = "" }) {
  const m = termMaps(terms);
  const items = kind === "category" ? list.filter((e) => (e.categories || []).includes(term.id)) : kind === "tag" ? list.filter((e) => (e.tags || []).includes(term.id)) : list;
  const per = POST_LIMITS.perPage, pages = Math.max(1, Math.ceil(items.length / per));
  if (!Number.isInteger(page) || page < 1 || page > pages) return null;
  const base = kind === "all" ? "/blog" : kind === "category" ? catUrl(term) : tagUrl(term);
  const slice = items.slice((page - 1) * per, page * per);
  const counts = new Map();
  for (const e of list) for (const id of e.categories || []) counts.set(id, (counts.get(id) || 0) + 1);
  const cats = (terms && terms.categories || []).filter((c) => counts.get(c.id));
  const chips = cats.length ? '<nav class="wb-chips" aria-label="ক্যাটাগরি"><a href="/blog"' + (kind === "all" ? ' aria-current="page"' : "") + ">সব লেখা</a>" +
    cats.map((c) => '<a href="' + esc(catUrl(c)) + '"' + (kind === "category" && term.id === c.id ? ' aria-current="page"' : "") + ">" + esc(c.name) + " <small>" + bn(counts.get(c.id)) + "</small></a>").join("") + "</nav>" : "";
  const h1 = kind === "all" ? "ব্লগ" : kind === "category" ? term.name : "#" + term.name;
  const kicker = kind === "all" ? "আমাদের লেখা" : kind === "category" ? "ক্যাটাগরি" : "ট্যাগ";
  const lead = kind === "all" ? "ওয়েবসাইট, ডিজাইন আর অনলাইন ব্যবসা নিয়ে সহজ ভাষায় কাজের কথা।" : bn(items.length) + "টি লেখা";
  const crumbs = '<nav class="wb-crumbs" aria-label="ব্রেডক্রাম্ব"><a href="/">হোম</a><span>›</span>' + (kind === "all" ? '<span aria-current="page">ব্লগ</span>' : '<a href="/blog">ব্লগ</a><span>›</span><span aria-current="page">' + esc(h1) + "</span>") + "</nav>";
  let grid;
  if (!items.length) grid = '<div class="wb-empty"><span aria-hidden="true">✎</span><h2>শীঘ্রই নতুন লেখা আসছে</h2><p>আমরা লিখছি — একটু পরে আবার ঘুরে যান।</p><a class="btn btn-primary" href="/">হোমপেজে ফিরুন</a></div>';
  else grid = '<div class="wb-grid">' + slice.map((e, i) => card(e, m, kind === "all" && page === 1 && i === 0 && slice.length > 2)).join("") + "</div>" + pager(base, page, pages);
  const main = '<div class="wb"><header class="wb-hero"><div class="wb-wrap">' + crumbs + '<p class="wb-kicker">' + kicker + '</p><h1 class="wb-h1">' + esc(h1) + '</h1><p class="wb-lead">' + esc(lead) + "</p>" + chips + "</div></header>" +
    '<section class="wb-list"><div class="wb-wrap">' + grid + "</div></section></div>";
  const title = (kind === "all" ? "ব্লগ" : h1 + " — ব্লগ") + (page > 1 ? " (পাতা " + bn(page) + ")" : "");
  const description = kind === "all" ? "WebDesigner71 ব্লগ — ওয়েবসাইট, ডিজাইন আর অনলাইন ব্যবসা নিয়ে সহজ বাংলায় লেখা।" : kicker + ": " + term.name + " — WebDesigner71 ব্লগের " + bn(items.length) + "টি লেখা।";
  return { title, description, noindex: !items.length, css: POST_CSS, fontsHref: "", main, headExtra: RSS_LINK };
}

const SHARE = [
  ["facebook", "Facebook", (u) => "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(u)],
  ["whatsapp", "WhatsApp", (u, t) => "https://wa.me/?text=" + encodeURIComponent(t + " " + u)],
  ["x", "X", (u, t) => "https://twitter.com/intent/tweet?url=" + encodeURIComponent(u) + "&text=" + encodeURIComponent(t)],
  ["linkedin", "LinkedIn", (u) => "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(u)],
  ["email", "ইমেইল", (u, t) => "mailto:?subject=" + encodeURIComponent(t) + "&body=" + encodeURIComponent(u)],
];
const SHARE_ICON = {
  facebook: "M14 8h3V4h-3a5 5 0 0 0-5 5v3H6v4h3v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1z",
  whatsapp: "M3 21l1.6-4.8A8.5 8.5 0 1 1 8 19.6zM9 8.5c0 3.5 3 6.5 6.5 6.5l1.5-1.5-2-1-1 1a5 5 0 0 1-2.5-2.5l1-1-1-2z",
  x: "M4 4l16 16M20 4L4 20",
  linkedin: "M6 9v11M6 5v.01M10 20v-6a3 3 0 0 1 6 0v6M10 9v11M16 20v-6",
  email: "M3 6h18v12H3zM3 7l9 6 9-6",
};
const shareIco = (k) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + SHARE_ICON[k] + '"/></svg>';

/**
 * The article (used by the site AND by the editor preview bridge with editor:true).
 * post: snapshot-like { title, slug, excerpt, image, imageAlt, author, date, categories, tags, blocks, readMin? }
 */
export function renderArticle(post, ctx = {}) {
  const m = termMaps(ctx.terms);
  const cats = catsOf(post, m), tags = tagsOf(post, m);
  const url = (ctx.origin || "") + postUrl(post.slug || "");
  const readMin = post.readMin || readingMinutes(post.blocks);
  const author = post.author || (ctx.settings && ctx.settings.siteName) || "WebDesigner71";
  const crumbs = '<nav class="wb-crumbs" aria-label="ব্রেডক্রাম্ব"><a href="/">হোম</a><span>›</span><a href="/blog">ব্লগ</a>' + (cats[0] ? '<span>›</span><a href="' + esc(catUrl(cats[0])) + '">' + esc(cats[0].name) + "</a>" : "") + "</nav>";
  const head = '<header class="wb-head"><div class="wb-wrap wb-narrow">' + crumbs +
    (cats.length ? '<div class="wb-cats">' + cats.map((c) => '<a href="' + esc(catUrl(c)) + '">' + esc(c.name) + "</a>").join("") + "</div>" : "") +
    '<h1 class="wb-title">' + esc(post.title || (ctx.editor ? "শিরোনামহীন পোস্ট" : "")) + "</h1>" + (post.excerpt ? '<p class="wb-lead">' + esc(post.excerpt) + "</p>" : "") +
    '<div class="wb-meta"><span class="wb-av" aria-hidden="true">' + initial(author) + '</span><span class="wb-by"><b>' + esc(author) + "</b><span>" +
    (post.date ? timeTag(post.date) : ctx.editor ? "<time>প্রকাশের সময় তারিখ বসবে</time>" : "") + '<span class="wb-dot" aria-hidden="true">•</span>' + esc(readLabel(readMin)) + "</span></span></div></div></header>";
  const hero = post.image ? '<figure class="wb-hero-img"><img' + attr({ src: post.image, alt: post.imageAlt || "", decoding: "async", fetchpriority: "high" }) + "></figure>" : "";
  const body = '<div class="wb-body">' + PG.renderMain(post.blocks || [], { editor: !!ctx.editor, page: { title: post.title || "", slug: post.slug || "" }, settings: ctx.settings || null }) + "</div>";
  const share = '<div class="wb-share"><span>শেয়ার করুন</span>' + SHARE.map(([k, label, fn]) => '<a class="s-' + k + '"' + attr({ href: fn(url, post.title || ""), target: k === "email" ? null : "_blank", rel: k === "email" ? null : "noopener", "aria-label": label + "-এ শেয়ার করুন", title: label }) + ">" + shareIco(k) + "</a>").join("") + "</div>";
  const tagRow = tags.length ? '<div class="wb-tags">' + tags.map((t) => '<a href="' + esc(tagUrl(t)) + '">#' + esc(t.name) + "</a>").join("") + "</div>" : "";
  let nav = "";
  const list = ctx.list || [];
  const i = list.findIndex((e) => e.id === post.id);
  if (i >= 0) {
    const newer = list[i - 1], older = list[i + 1];
    if (newer || older) nav = '<nav class="wb-prevnext" aria-label="আরও লেখা">' +
      (older ? '<a class="wb-pn prev" rel="prev" href="' + esc(postUrl(older.slug)) + '"><small>← আগের লেখা</small><b>' + esc(older.title) + "</b></a>" : "<span></span>") +
      (newer ? '<a class="wb-pn next" rel="next" href="' + esc(postUrl(newer.slug)) + '"><small>পরের লেখা →</small><b>' + esc(newer.title) + "</b></a>" : "<span></span>") + "</nav>";
  }
  const foot = '<footer class="wb-foot"><div class="wb-wrap wb-narrow">' + tagRow + share + nav + "</div></footer>";
  let related = "";
  if (list.length > 1) {
    const rel = relatedPosts(post, list);
    if (rel.length) related = '<section class="wb-related" aria-labelledby="wb-rel-h"><div class="wb-wrap"><h2 id="wb-rel-h">আরও পড়ুন</h2><div class="wb-grid">' + rel.map((e) => card(e, m, false)).join("") + "</div></div></section>";
  }
  return '<div class="wb"><article class="wb-post">' + head + hero + body + foot + "</article>" + related + "</div>";
}
/** Shared categories ×2 + shared tags, then recency; padded with the latest posts. */
export function relatedPosts(post, list, n = POST_LIMITS.related) {
  const cs = new Set(post.categories || []), ts = new Set(post.tags || []);
  const scored = list.filter((e) => e.id !== post.id).map((e, i) => ({ e, i, s: (e.categories || []).filter((x) => cs.has(x)).length * 2 + (e.tags || []).filter((x) => ts.has(x)).length }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, n).map((x) => x.e);
}
/** Full public render of one post → shell input (title, description, css, main, headExtra…). */
export function renderPost(snap, ctx = {}) {
  const origin = ctx.origin || "";
  const seo = snap.seo || {};
  const description = seo.description || snap.excerpt || autoExcerpt(snap.blocks, 155);
  const image = seo.image || snap.image || "";
  const m = termMaps(ctx.terms);
  const ld = {
    "@context": "https://schema.org", "@type": "BlogPosting", headline: snap.title, description,
    datePublished: snap.date, dateModified: snap.publishedAt || snap.date,
    author: { "@type": "Person", name: snap.author || "WebDesigner71" },
    publisher: { "@type": "Organization", name: "WebDesigner71", url: origin + "/" },
    mainEntityOfPage: origin + postUrl(snap.slug), inLanguage: "bn",
    keywords: tagsOf(snap, m).map((t) => t.name).join(", ") || undefined,
    articleSection: (catsOf(snap, m)[0] || {}).name,
    image: image ? origin + image : undefined,
  };
  const headExtra = RSS_LINK + '<meta property="article:published_time"' + attr({ content: snap.date }) + ">" + ldJson(ld);
  return {
    title: seo.title || snap.title, description, noindex: !!seo.noindex, ogImage: image, ogType: "article",
    css: PG.pageCss(snap.blocks || []) + POST_CSS, fontsHref: PG.fontsHref(snap.blocks || []),
    main: renderArticle(snap, ctx), headExtra,
  };
}
/** RSS 2.0 for the latest visible posts. */
export function renderFeed(list, terms, origin) {
  const m = termMaps(terms);
  const x = (s) => esc(s);
  const items = list.slice(0, POST_LIMITS.feed).map((e) => "<item><title>" + x(e.title) + "</title><link>" + x(origin + postUrl(e.slug)) + '</link><guid isPermaLink="true">' + x(origin + postUrl(e.slug)) +
    "</guid><pubDate>" + new Date(e.date).toUTCString() + "</pubDate>" + (e.author ? "<dc:creator>" + x(e.author) + "</dc:creator>" : "") +
    catsOf(e, m).map((c) => "<category>" + x(c.name) + "</category>").join("") + "<description>" + x(e.excerpt || "") + "</description></item>").join("");
  const last = list[0] ? new Date(list[0].date).toUTCString() : new Date(0).toUTCString();
  return '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>WebDesigner71 ব্লগ</title><link>' + x(origin + "/blog") +
    "</link><description>ওয়েবসাইট, ডিজাইন আর অনলাইন ব্যবসা নিয়ে সহজ বাংলায় লেখা</description><language>bn</language><lastBuildDate>" + last + '</lastBuildDate><atom:link href="' + x(origin + "/blog/feed.xml") + '" rel="self" type="application/rss+xml"/>' + items + "</channel></rss>\n";
}

/* ------------------------------------------------------------------ blog CSS (Bengali-first typography) */
const Mo = PG.BREAKPOINTS.mobile, T = PG.BREAKPOINTS.tablet;
export const POST_CSS = `
.wb{--wb-w:1140px;--wb-n:760px;background:var(--cream)}
.wb-wrap{max-width:var(--wb-w);margin:0 auto;padding:0 24px}.wb-narrow{max-width:calc(var(--wb-n) + 48px)}
.wb-crumbs{display:flex;flex-wrap:wrap;gap:8px;font-size:.9rem;color:var(--muted);margin-bottom:18px}
.wb-crumbs a{color:var(--green);text-decoration:none;font-weight:600}.wb-crumbs a:hover{text-decoration:underline}
.wb-hero{padding:56px 0 36px;background:linear-gradient(180deg,#fff 0%,var(--cream) 100%);border-bottom:1px solid rgba(11,61,46,.08)}
.wb-kicker{margin:0 0 6px;color:var(--gold);font-weight:700;letter-spacing:.04em}
.wb-h1{margin:0;color:var(--green);font-size:clamp(2rem,5vw,3rem);line-height:1.3}
.wb-lead{margin:12px 0 0;color:var(--muted);font-size:1.15rem;line-height:1.8;max-width:680px}
.wb-chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.wb-chips a{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:#fff;border:1px solid rgba(11,61,46,.14);color:var(--green);text-decoration:none;font-weight:600;font-size:.95rem;transition:background .2s ease,color .2s ease}
.wb-chips a small{opacity:.65;font-weight:500}
.wb-chips a:hover,.wb-chips a[aria-current]{background:var(--green);color:#fff;border-color:var(--green)}
.wb-list{padding:40px 0 72px}
.wb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
.wb-card{display:flex;flex-direction:column;background:#fff;border-radius:18px;overflow:hidden;border:1px solid rgba(11,61,46,.08);box-shadow:0 2px 10px rgba(11,61,46,.05);transition:transform .25s ease,box-shadow .25s ease}
.wb-card:hover{transform:translateY(-3px);box-shadow:0 14px 34px rgba(11,61,46,.12)}
.wb-card-img{display:block;aspect-ratio:16/10;background:linear-gradient(135deg,var(--green),#145c45);overflow:hidden}
.wb-card-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}
.wb-card:hover .wb-card-img img{transform:scale(1.04)}
.wb-ph{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:rgba(255,255,255,.9);font-size:3.2rem;font-weight:700;background:radial-gradient(circle at 30% 20%,rgba(212,160,23,.35),transparent 60%)}
.wb-card-b{display:flex;flex-direction:column;gap:10px;padding:20px 22px 22px;flex:1}
.wb-cats{display:flex;flex-wrap:wrap;gap:8px}
.wb-cats a{font-size:.8rem;font-weight:700;color:#8a6a0d;background:rgba(212,160,23,.14);padding:3px 10px;border-radius:999px;text-decoration:none}
.wb-card-t{margin:0;font-size:1.25rem;line-height:1.5}
.wb-card-t a{color:var(--ink);text-decoration:none;background-image:linear-gradient(var(--gold),var(--gold));background-size:0 2px;background-repeat:no-repeat;background-position:0 100%;transition:background-size .3s ease}
.wb-card-t a:hover{background-size:100% 2px}
.wb-card-x{margin:0;color:var(--muted);line-height:1.75;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wb-card-m{margin:auto 0 0;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.88rem;color:var(--muted)}
.wb-feat{grid-column:1/-1;flex-direction:row}
.wb-feat .wb-card-img{flex:0 0 56%;aspect-ratio:auto;min-height:320px}
.wb-feat .wb-card-b{padding:32px 36px;justify-content:center}
.wb-feat .wb-card-t{font-size:clamp(1.5rem,2.6vw,2rem)}
.wb-feat .wb-card-x{-webkit-line-clamp:4;font-size:1.05rem}
.wb-empty{text-align:center;padding:64px 20px;background:#fff;border-radius:20px;border:1px dashed rgba(11,61,46,.2)}
.wb-empty>span{font-size:2.6rem;color:var(--gold)}.wb-empty h2{color:var(--green);margin:8px 0}.wb-empty p{color:var(--muted);margin:0 0 20px}
.wb-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;margin-top:44px}
.wb-pg-nums{display:flex;gap:6px}
.wb-pager a,.wb-pager span[aria-current],.wb-gap{min-width:42px;height:42px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;text-decoration:none;font-weight:600}
.wb-pager a{background:#fff;color:var(--green);border:1px solid rgba(11,61,46,.14)}.wb-pager a:hover{border-color:var(--gold)}
.wb-pager span[aria-current]{background:var(--green);color:#fff}.wb-gap{color:var(--muted)}
.wb-head{padding:48px 0 28px}
.wb-head .wb-cats{margin-bottom:14px}
.wb-title{margin:0;color:var(--green);font-size:clamp(1.9rem,4.6vw,2.9rem);line-height:1.35;letter-spacing:-.005em}
.wb-head .wb-lead{font-size:1.2rem}
.wb-meta{display:flex;align-items:center;gap:12px;margin-top:24px}
.wb-av{flex:0 0 auto;width:46px;height:46px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--green);color:var(--gold);font-weight:700;font-size:1.2rem}
.wb-by{display:flex;flex-direction:column;line-height:1.5}.wb-by b{color:var(--ink)}.wb-by>span{color:var(--muted);font-size:.92rem}
.wb-dot{margin:0 8px;opacity:.6}
.wb-hero-img{max-width:1040px;margin:8px auto 8px;padding:0 24px}
.wb-hero-img img{display:block;width:100%;height:auto;max-height:560px;object-fit:cover;border-radius:22px;box-shadow:0 18px 50px rgba(11,61,46,.14)}
.wb-body .pb-root{font-size:1.125rem;line-height:1.9}
.wb-body .pb-flow{padding:28px 0}
.wb-body .pb-flow>.pb-in{max-width:var(--wb-n)}
.wb-body .pb-text p,.wb-body .pb-text li{line-height:1.95}
.wb-body .pb-heading h2{font-size:clamp(1.45rem,3vw,1.85rem);margin-top:.9em;line-height:1.45}
.wb-body .pb-heading h3{font-size:clamp(1.2rem,2.4vw,1.4rem);margin-top:.6em;line-height:1.5}
.wb-body [id]{scroll-margin-top:96px}
.wb-foot{padding:8px 0 48px}
.wb-tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px}
.wb-tags a{padding:6px 14px;border-radius:999px;background:#fff;border:1px solid rgba(11,61,46,.14);color:var(--green);text-decoration:none;font-size:.92rem;font-weight:600}
.wb-tags a:hover{border-color:var(--gold)}
.wb-share{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:18px 0;border-top:1px solid rgba(11,61,46,.1);border-bottom:1px solid rgba(11,61,46,.1)}
.wb-share>span{font-weight:700;color:var(--green);margin-right:6px}
.wb-share a{width:42px;height:42px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#fff;border:1px solid rgba(11,61,46,.14);color:var(--green);transition:background .2s ease,color .2s ease}
.wb-share a:hover{background:var(--green);color:#fff}
.wb-prevnext{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:28px}
.wb-pn{display:flex;flex-direction:column;gap:4px;padding:18px 20px;border-radius:16px;background:#fff;border:1px solid rgba(11,61,46,.1);text-decoration:none;color:var(--ink)}
.wb-pn:hover{border-color:var(--gold)}.wb-pn small{color:var(--muted)}.wb-pn b{line-height:1.5;color:var(--green)}.wb-pn.next{text-align:right}
.wb-related{padding:56px 0 72px;background:#fff;border-top:1px solid rgba(11,61,46,.08)}
.wb-related h2{margin:0 0 24px;color:var(--green);font-size:1.6rem}
@media (max-width:${T}px){.wb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wb-feat .wb-card-img{flex-basis:50%;min-height:260px}}
@media (max-width:${Mo}px){.wb-wrap{padding:0 18px}.wb-hero{padding:36px 0 26px}.wb-grid{grid-template-columns:1fr;gap:20px}
.wb-feat{flex-direction:column}.wb-feat .wb-card-img{flex-basis:auto;aspect-ratio:16/10;min-height:0}.wb-feat .wb-card-b{padding:20px 22px 22px}
.wb-head{padding:32px 0 20px}.wb-hero-img{padding:0 12px}.wb-hero-img img{border-radius:14px}.wb-body .pb-root{font-size:1.06rem}
.wb-prevnext{grid-template-columns:1fr}.wb-pn.next{text-align:left}.wb-pager{gap:8px}.wb-pg-btn{flex:1 1 40%}}
`.replace(/\n/g, "");
