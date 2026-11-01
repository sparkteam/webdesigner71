/**
 * WebDesigner71 site Worker (CMS Phase 2 + Phase 3 pages).
 *
 * Serves the static site from ./public (binding ASSETS). "/", "/index.html" and "/media/*" always run this
 * script (wrangler.jsonc → assets.run_worker_first). Every other path is served straight from assets when a
 * file exists — so /admin/, /old-homepage/, /cms/, /assets/ can never be shadowed — and only reaches this
 * script when NO asset matches. Those requests are handled by servePage (Phase 3, docs/cms-phase3.md):
 *   /<slug> and /<slug>/   published page from KV "pub:<slug>" inside the site's header/footer/CSS
 *   /sitemap.xml           homepage + published, indexable pages (from "pages:index") + /blog and visible posts
 *   /blog, /blog/page/N    blog list (Phase 4, docs/cms-phase4.md), 9 per page, from "posts:public" + "posts:terms"
 *   /blog/<slug>           published post "postpub:<slug>" (date in the future = scheduled = 404 until then;
 *                          "postredirect:<slug>" → 301). /blog/category/<slug>, /blog/tag/<slug>, /blog/feed.xml (RSS 2.0)
 *   /__page-preview        empty editor shell for the admin page builder (noindex, no-store, same-origin frames only)
 *   anything else          styled 404 ("redirect:<slug>" → 301 first). KV errors → the original asset 404.
 *
 * Homepage: reads KV CONTENT "content:homepage:v2" (+ "settings:site"; falls back to the Phase 1 key
 * "content:homepage" through migrateV1) and applies the shared plan from public/cms/model.js with HTMLRewriter.
 * Fields equal to the defaults produce no edit, so the seed renders the original page (+ the accent style tag).
 * Fail-safe: no content, bad data, or any KV/plan error → the original index.html, unchanged.
 * `?cms_preview=1` (the admin panel's live preview iframe) skips KV, adds noindex and no-store.
 *
 * /media/<key>: uploaded images from the MEDIA binding (Workers KV today; an R2 bucket also works — see
 * serveMedia). Long immutable cache; only image/jpeg|png|webp|gif is ever served.
 */
import * as PG from "../../public/cms/pages.js";
import * as PO from "../../public/cms/posts.js";
import { KEYS, cleanDoc, cleanSettings, migrateV1, seedDoc, DEFAULT_SETTINGS, plan, toHtml, cssText, MEDIA_KEY_RE, MEDIA_TYPES } from "../../public/cms/model.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const get = request.method === "GET" || request.method === "HEAD";
    if (get && url.pathname.startsWith("/media/")) return serveMedia(request, env, url);
    const isHome = url.pathname === "/" || url.pathname === "/index.html";
    if (!get) return env.ASSETS.fetch(request);
    if (!isHome) return servePage(request, env, url);

    // Always fetch the full page: a 304 for the static file would hide a KV content change.
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    headers.delete("if-modified-since");
    const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method, headers }));
    const type = asset.headers.get("content-type") || "";
    if (asset.status !== 200 || !type.includes("text/html")) return asset;

    const preview = url.searchParams.get("cms_preview") === "1";
    const res = new Response(asset.body, asset);
    res.headers.delete("etag");
    res.headers.delete("content-length");
    if (preview) {
      res.headers.set("cache-control", "no-store");
      res.headers.set("x-robots-tag", "noindex");
      return new HTMLRewriter()
        .on("head", { element(el) { el.append('<meta name="robots" content="noindex">', { html: true }); } })
        .transform(res);
    }
    res.headers.set("cache-control", "public, max-age=0, must-revalidate");

    let edits = null;
    try {
      edits = await buildEdits(env);
    } catch (err) {
      console.error(JSON.stringify({ msg: "cms_render_error", error: String(err && err.message ? err.message : err), field: err && err.field }));
      edits = null;
    }
    if (!edits) return res; // fail-safe: original page

    const rw = new HTMLRewriter();
    for (const e of edits.ops) {
      rw.on(e.sel, {
        element(el) {
          if (e.op === "inner") el.setInnerContent(e.html, { html: true });
          else if (e.op === "replace") el.replace(e.html, { html: true });
          else if (e.op === "remove") el.remove();
          else if (e.op === "append") el.append(e.html, { html: true });
          else if (e.op === "attr") el.setAttribute(e.name, e.value);
        },
      });
    }
    const style = '<style id="wd71-cms">' + edits.css + "</style>";
    rw.on("head", { element(el) { el.append(style, { html: true }); } });
    return rw.transform(res);
  },
};

/** Reads KV and returns pre-rendered edits, or null when there is nothing stored. Throws on bad data. */
export async function buildEdits(env) {
  const cms = await loadCms(env);
  return cms ? editsFrom(cms.doc, cms.settings) : null;
}
/** { doc, settings } from KV (Phase 1 fallback included), or null when nothing is stored. Throws on bad data. */
export async function loadCms(env) {
  const opt = { type: "json", cacheTtl: 60 };
  const [rawDoc, rawSettings] = await Promise.all([env.CONTENT.get(KEYS.doc, opt), env.CONTENT.get(KEYS.settings, opt)]);
  let doc, settings = null;
  if (rawDoc) doc = cleanDoc(rawDoc);
  else {
    const v1 = await env.CONTENT.get(KEYS.v1, opt);
    if (v1) ({ doc, settings } = migrateV1(v1));
    else if (rawSettings) doc = cleanDoc(seedDoc());
    else return null;
  }
  settings = rawSettings ? cleanSettings(rawSettings) : settings || DEFAULT_SETTINGS;
  return { doc, settings };
}
export function editsFrom(doc, settings) {
  const ops = [];
  let css = "";
  for (const o of plan(doc, settings)) {
    if (o.op === "css") css = cssText(o.vars);
    else if (o.op === "restore") continue;
    else if (o.op === "attr") ops.push({ sel: o.sel, op: "attr", name: o.name, value: o.value, section: o.section });
    else ops.push({ sel: o.sel, op: o.op, html: o.nodes ? toHtml(o.nodes) : "", section: o.section });
  }
  return { ops, css, settings };
}

const MEDIA_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-site",
};
function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" } });
}
/** /media/<key> — KV (value = bytes, metadata.contentType) or R2 (if MEDIA is ever switched to an R2 binding). */
async function serveMedia(request, env, url) {
  let key;
  try { key = decodeURIComponent(url.pathname.slice(7)); } catch { return notFound(); }
  if (!MEDIA_KEY_RE.test(key) || !env.MEDIA) return notFound();
  const etag = '"' + key + '"'; // keys are random and never reused → immutable
  let body = null, type = null, size = null;
  try {
    if (typeof env.MEDIA.head === "function") {
      const obj = await env.MEDIA.get(key);
      if (!obj) return notFound();
      body = obj.body; type = obj.httpMetadata && obj.httpMetadata.contentType; size = obj.size;
    } else {
      const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: "stream", cacheTtl: 300 });
      if (!value) return notFound();
      body = value; type = metadata && metadata.contentType; size = metadata && metadata.size;
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "media_error", error: String(err) }));
    return new Response("Temporarily unavailable", { status: 503, headers: { "retry-after": "30" } });
  }
  if (!MEDIA_TYPES[type]) return notFound();
  const h = new Headers(MEDIA_HEADERS);
  h.set("content-type", type);
  h.set("etag", etag);
  if (request.headers.get("if-none-match") === etag) { if (body.cancel) body.cancel(); return new Response(null, { status: 304, headers: h }); }
  if (size) h.set("content-length", String(size));
  if (request.method === "HEAD") { if (body.cancel) body.cancel(); return new Response(null, { status: 200, headers: h }); }
  return new Response(body, { status: 200, headers: h });
}

/* ================================================================== Phase 3: pages */
const SLUG_PATH = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const APEX = "https://webdesigner71.com";
const PAGE_KV = { type: "json", cacheTtl: 60 };
const originFor = (url) => (/(^|\.)webdesigner71\.com$/.test(url.hostname) ? APEX : url.origin);
const logErr = (msg, err) => console.error(JSON.stringify({ msg, error: String(err && err.message ? err.message : err), field: err && err.field }));

async function servePage(request, env, url) {
  const p = url.pathname;
  if (p === "/sitemap.xml") return sitemap(request, env, url);
  if (p === "/__page-preview") return previewShell(request, env, url);
  if (p === "/blog" || p.startsWith("/blog/")) return serveBlog(request, env, url);
  const m = SLUG_PATH.exec(p);
  // Reserved first segments keep their original behaviour exactly (assets decide; we never render there).
  const first = p.split("/")[1] || "";
  if (PG.RESERVED_SLUGS.includes(first) || p.startsWith("/media/") || p.startsWith("/cms/")) return env.ASSETS.fetch(request);
  if (/\.[A-Za-z0-9]{1,8}$/.test(p)) return env.ASSETS.fetch(request); // missing files keep the plain asset 404
  if (!m || m[1].length > PG.SLUG_MAX) return notFoundPage(request, env, url);
  const slug = m[1];
  let pub, redirect = null;
  try {
    pub = await env.CONTENT.get(PG.PKEYS.pub(slug), PAGE_KV);
    if (!pub) redirect = await env.CONTENT.get(PG.PKEYS.redirect(slug), PAGE_KV);
  } catch (err) { logErr("page_kv_error", err); return env.ASSETS.fetch(request); }
  if (!pub) {
    if (redirect && typeof redirect.to === "string" && !PG.slugProblem(redirect.to) && redirect.to !== slug)
      return new Response(null, { status: 301, headers: { location: "/" + redirect.to + url.search, "cache-control": "public, max-age=300" } });
    return notFoundPage(request, env, url);
  }
  let cms = null;
  try { cms = await loadCms(env); } catch (err) { logErr("cms_render_error", err); }
  let r;
  try { r = PG.renderPage(pub, cms ? cms.settings : DEFAULT_SETTINGS); }
  catch (err) { logErr("page_render_error", err); return notFoundPage(request, env, url); }
  // Trailing slash: same page, one canonical URL (no slash).
  return shell(request, env, url, r, { status: 200, canonical: originFor(url) + "/" + slug, cms, cache: "public, max-age=0, must-revalidate" });
}

async function notFoundPage(request, env, url) {
  let cms = null;
  try { cms = await loadCms(env); } catch (err) { logErr("cms_render_error", err); }
  try { return await shell(request, env, url, PG.renderNotFound(), { status: 404, cms, cache: "public, max-age=60" }); }
  catch (err) { logErr("notfound_error", err); return env.ASSETS.fetch(request); }
}

/** The site's own index.html with <main> replaced: same header, footer, fonts and CMS colours as the homepage. */
async function shell(request, env, url, r, o) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), { method: "GET" }));
  const type = asset.headers.get("content-type") || "";
  if (asset.status !== 200 || !type.includes("text/html")) throw new Error("shell_asset");
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": o.cache, "x-content-type-options": "nosniff" });
  if (r.noindex || o.preview) headers.set("x-robots-tag", "noindex");
  if (o.preview) headers.set("content-security-policy", "frame-ancestors 'self'");
  const res = new Response(asset.body, { status: o.status, headers });
  const fixHref = (h) => (h === "#top" || h === "#" ? "/" : h && h[0] === "#" ? "/" + h : h);
  const rw = new HTMLRewriter();
  // 1. header/footer edits from the homepage CMS (never anything inside <main>, never the homepage's title/description)
  const edits = o.cms ? editsFrom(o.cms.doc, o.cms.settings) : null;
  if (edits) for (const e of edits.ops) {
    if (!["header", "footer", "settings"].includes(e.section) || e.sel === "head > title" || e.sel === 'meta[name="description"]') continue;
    const html = (e.html || "").replace(/href="#([^"]*)"/g, (_, a) => 'href="' + fixHref("#" + a) + '"');
    rw.on(e.sel, {
      element(el) {
        if (e.op === "inner") el.setInnerContent(html, { html: true });
        else if (e.op === "replace") el.replace(html, { html: true });
        else if (e.op === "remove") el.remove();
        else if (e.op === "append") el.append(html, { html: true });
        else if (e.op === "attr") el.setAttribute(e.name, e.name === "href" ? fixHref(e.value) : e.value);
      },
    });
  }
  // 2. in-page anchors of the homepage now point back to it
  const anchors = { element(el) { const h = el.getAttribute("href"); if (h && h[0] === "#") el.setAttribute("href", fixHref(h)); } };
  rw.on('header a[href^="#"]', anchors).on('footer a[href^="#"]', anchors).on('a.fab[href^="#"]', anchors);
  // 3. head: title, description, social tags, canonical, fonts, styles
  const title = r.title ? (r.title.includes("WebDesigner71") ? r.title : r.title + " | WebDesigner71") : "WebDesigner71";
  rw.on("head > title", { element(el) { el.setInnerContent(title); } });
  rw.on('meta[property="og:title"]', { element(el) { el.setAttribute("content", title); } });
  if (r.description) {
    rw.on('meta[name="description"]', { element(el) { el.setAttribute("content", r.description); } });
    rw.on('meta[property="og:description"]', { element(el) { el.setAttribute("content", r.description); } });
  }
  if (r.ogType) rw.on('meta[property="og:type"]', { element(el) { el.setAttribute("content", r.ogType); } });
  rw.on('meta[property="og:url"]', { element(el) { if (o.canonical) el.setAttribute("content", o.canonical); else el.remove(); } });
  const esc = PG.escHtml;
  let head = "";
  if (o.canonical) head += '<link rel="canonical" href="' + esc(o.canonical) + '">';
  if (r.noindex || o.preview) head += '<meta name="robots" content="noindex">';
  if (r.ogImage) head += '<meta property="og:image" content="' + esc(originFor(url) + r.ogImage) + '">';
  head += '<link id="wd71-fonts" rel="stylesheet" href="' + esc(r.fontsHref || "") + '"' + (r.fontsHref ? "" : " disabled") + ">";
  if (edits) head += '<style id="wd71-cms">' + edits.css + "</style>";
  head += '<style id="wd71-page">' + r.css + "</style>";
  if (r.headExtra) head += r.headExtra; // trusted, pre-escaped by the renderer (RSS link, article meta, JSON-LD)
  if (o.preview) head += '<script type="module" src="/cms/page-bridge.js"></script>';
  rw.on("head", { element(el) { el.append(head, { html: true }); } });
  // 4. the page itself
  rw.on("main#top", { element(el) { el.setInnerContent(r.main, { html: true }); el.setAttribute("class", "pb-page"); } });
  const out = rw.transform(res);
  if (request.method === "HEAD") return new Response(null, { status: out.status, headers: out.headers });
  return out;
}

/** Editor canvas: empty page shell; public/cms/page-bridge.js renders drafts sent by the admin panel via postMessage. */
async function previewShell(request, env, url) {
  let cms = null;
  try { cms = await loadCms(env); } catch (err) { logErr("cms_render_error", err); }
  const r = { title: "প্রিভিউ", description: "", noindex: true, css: PG.BASE_CSS, fontsHref: "", main: '<div class="pb-root"></div>' };
  return shell(request, env, url, r, { status: 200, cms, preview: true, cache: "no-store" });
}

async function sitemap(request, env, url) {
  let index = null;
  try { index = await env.CONTENT.get(PG.PKEYS.index, PAGE_KV); } catch (err) { logErr("sitemap_kv_error", err); }
  const origin = originFor(url);
  const urls = [{ loc: origin + "/", lastmod: null }];
  for (const p of (index && Array.isArray(index.pages) ? index.pages : [])) {
    if (p && p.status === "published" && !p.noindex && typeof p.publishedSlug === "string" && !PG.slugProblem(p.publishedSlug))
      urls.push({ loc: origin + "/" + p.publishedSlug, lastmod: typeof p.publishedAt === "string" ? p.publishedAt.slice(0, 10) : null });
  }
  let posts = [];
  try { posts = PO.visibleEntries(await readBlogList(env)); } catch (err) { logErr("sitemap_kv_error", err); }
  if (posts.length) {
    urls.push({ loc: origin + "/blog", lastmod: String(posts[0].date || "").slice(0, 10) });
    for (const e of posts) if (!e.noindex && !PO.postSlugProblem(e.slug)) urls.push({ loc: origin + "/blog/" + e.slug, lastmod: String(e.updatedAt || e.date || "").slice(0, 10) });
  }
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => "  <url><loc>" + PG.escHtml(u.loc) + "</loc>" + (u.lastmod && /^\d{4}-\d\d-\d\d$/.test(u.lastmod) ? "<lastmod>" + u.lastmod + "</lastmod>" : "") + "</url>").join("\n") + "\n</urlset>\n";
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}

/* ================================================================== Phase 4: blog */
const BLOG_RE = /^\/blog(?:\/(?:page\/(\d{1,4})|(category|tag)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/page\/(\d{1,4}))?|([a-z0-9]+(?:-[a-z0-9]+)*)))?\/?$/;
async function readBlogList(env) {
  const raw = await env.CONTENT.get(PO.QKEYS.list, PAGE_KV);
  return raw && Array.isArray(raw.posts) ? raw.posts.filter((e) => e && typeof e === "object" && PO.POST_ID_RE.test(e.id) && typeof e.slug === "string" && !PO.postSlugProblem(e.slug)) : [];
}
const moved = (to, url) => new Response(null, { status: 301, headers: { location: to + url.search, "cache-control": "public, max-age=300" } });

async function serveBlog(request, env, url) {
  const p = url.pathname;
  if (p === "/blog/feed.xml") return blogFeed(request, env, url);
  const m = BLOG_RE.exec(p);
  if (!m) return notFoundPage(request, env, url);
  const [, listPage, kind, termSlug, termPage, postSlug] = m;
  const canonicalPath = p.length > 5 && p.endsWith("/") ? p.slice(0, -1) : p;
  const origin = originFor(url);
  let list, terms, cms = null;
  try {
    [list, terms] = await Promise.all([readBlogList(env), env.CONTENT.get(PO.QKEYS.terms, PAGE_KV)]);
    terms = PO.cleanTerms(terms);
  } catch (err) { logErr("blog_kv_error", err); return notFoundPage(request, env, url); }
  const now = Date.now();
  const visible = PO.visibleEntries(list, now);
  try { cms = await loadCms(env); } catch (err) { logErr("cms_render_error", err); }
  const settings = cms ? cms.settings : DEFAULT_SETTINGS;
  const cache = "public, max-age=0, must-revalidate";

  if (postSlug) {
    if (PO.postSlugProblem(postSlug)) return notFoundPage(request, env, url);
    let snap, redirect = null;
    try {
      snap = await env.CONTENT.get(PO.QKEYS.pub(postSlug), PAGE_KV);
      if (!snap) redirect = await env.CONTENT.get(PO.QKEYS.redirect(postSlug), PAGE_KV);
    } catch (err) { logErr("post_kv_error", err); return notFoundPage(request, env, url); }
    if (!snap) {
      if (redirect && typeof redirect.to === "string" && !PO.postSlugProblem(redirect.to) && redirect.to !== postSlug) return moved("/blog/" + redirect.to, url);
      return notFoundPage(request, env, url);
    }
    // Scheduled: published with a future date stays hidden until then (checked on every request; KV cache ≤ 60 s).
    if (!snap.date || !(Date.parse(snap.date) <= now) || !Array.isArray(snap.blocks)) return notFoundPage(request, env, url);
    let r;
    try { r = PO.renderPost(snap, { terms, list: visible, origin, settings }); }
    catch (err) { logErr("post_render_error", err); return notFoundPage(request, env, url); }
    return shell(request, env, url, r, { status: 200, canonical: origin + "/blog/" + postSlug, cms, cache });
  }

  let page = 1, term = null, k = "all";
  if (listPage || termPage) {
    page = Number(listPage || termPage);
    if (page === 1) return moved(canonicalPath.replace(/\/page\/1$/, ""), url);
  }
  if (kind) {
    k = kind;
    term = (kind === "category" ? terms.categories : terms.tags).find((t) => t.slug === termSlug);
    if (!term) return notFoundPage(request, env, url);
  }
  let r;
  try { r = PO.renderBlogList({ list: visible, terms, page, term, kind: k, origin }); }
  catch (err) { logErr("blog_render_error", err); return notFoundPage(request, env, url); }
  if (!r) return notFoundPage(request, env, url);
  return shell(request, env, url, r, { status: 200, canonical: origin + canonicalPath, cms, cache });
}

async function blogFeed(request, env, url) {
  let list = [], terms = null;
  try { [list, terms] = await Promise.all([readBlogList(env), env.CONTENT.get(PO.QKEYS.terms, PAGE_KV)]); }
  catch (err) { logErr("feed_kv_error", err); }
  const body = PO.renderFeed(PO.visibleEntries(list), PO.cleanTerms(terms), originFor(url));
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
