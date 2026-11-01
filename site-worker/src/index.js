/**
 * WebDesigner71 site Worker (CMS Phase 2).
 *
 * Serves the static site from ./public (binding ASSETS). Only "/", "/index.html" and "/media/*" run this
 * script (wrangler.jsonc → assets.run_worker_first); every other path is served straight from assets.
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
import { KEYS, cleanDoc, cleanSettings, migrateV1, seedDoc, DEFAULT_SETTINGS, plan, toHtml, cssText, MEDIA_KEY_RE, MEDIA_TYPES } from "../../public/cms/model.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const get = request.method === "GET" || request.method === "HEAD";
    if (get && url.pathname.startsWith("/media/")) return serveMedia(request, env, url);
    const isHome = url.pathname === "/" || url.pathname === "/index.html";
    if (!isHome || !get) return env.ASSETS.fetch(request);

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
  const ops = [];
  let css = "";
  for (const o of plan(doc, settings)) {
    if (o.op === "css") css = cssText(o.vars);
    else if (o.op === "restore") continue;
    else if (o.op === "attr") ops.push({ sel: o.sel, op: "attr", name: o.name, value: o.value });
    else ops.push({ sel: o.sel, op: o.op, html: o.nodes ? toHtml(o.nodes) : "" });
  }
  return { ops, css };
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
