/**
 * WebDesigner71 site Worker (CMS Phase 1).
 *
 * Serves the static site from ./public (binding ASSETS). Only "/" and "/index.html" run this script
 * (wrangler.jsonc → assets.run_worker_first); every other path is served straight from assets.
 *
 * For the homepage it reads KV CONTENT "content:homepage" and rewrites, with HTMLRewriter:
 *   #hero-title  → heroTitle + " <em>heroHighlight</em>"
 *   #hero-sub    → heroSub
 *   </head>      → <style id="wd71-cms">:root{--gold:…;--gold-2:…}</style>
 * Fail-safe: missing key, bad data or any KV error → the original index.html, unchanged.
 * `?cms_preview=1` (the admin panel's live preview iframe) skips KV, adds noindex and no-store.
 */

/* CMS_TARGETS:BEGIN — field → element mapping. Keep identical to the copy in public/admin/index.html. */
const CMS_TARGETS = {
  heroTitle: { selector: "#hero-title", part: "text" },
  heroHighlight: { selector: "#hero-title", part: "em" },
  heroSub: { selector: "#hero-sub", fallback: ".hero .sub", part: "text" },
  accentColor: { cssVar: "--gold", lightVar: "--gold-2", flash: ".hero .btn-gold" },
};
const CMS_DEFAULT_ACCENT = "#D4A017";
const CMS_DEFAULT_ACCENT_LIGHT = "#E9B930";
// --gold-2 is the lighter hover/highlight shade: the site's original pair for the default, else 10% toward white.
function cmsLightShade(hex) {
  if (String(hex).toUpperCase() === CMS_DEFAULT_ACCENT) return CMS_DEFAULT_ACCENT_LIGHT;
  const n = parseInt(String(hex).slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * 0.1);
  return "#" + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("").toUpperCase();
}
/* CMS_TARGETS:END */

const CONTENT_KEY = "content:homepage";
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isHome = url.pathname === "/" || url.pathname === "/index.html";
    if (!isHome || (request.method !== "GET" && request.method !== "HEAD")) return env.ASSETS.fetch(request);

    // Always fetch the full page: a 304 for the static file would hide a KV content change.
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    headers.delete("if-modified-since");
    const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method, headers }));
    const type = asset.headers.get("content-type") || "";
    if (asset.status !== 200 || !type.includes("text/html")) return asset;

    const preview = url.searchParams.get("cms_preview") === "1";
    let content = null;
    if (!preview) {
      try {
        content = cleanContent(await env.CONTENT.get(CONTENT_KEY, { type: "json", cacheTtl: 60 }));
      } catch (err) {
        console.error(JSON.stringify({ msg: "cms_kv_error", error: String(err) }));
        content = null;
      }
    }

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
    if (!content) return res; // fail-safe: original page

    const t = CMS_TARGETS;
    const title = escText(content.heroTitle) + (content.heroHighlight ? " <em>" + escText(content.heroHighlight) + "</em>" : "");
    const accent = content.accentColor.toUpperCase();
    return new HTMLRewriter()
      .on(t.heroTitle.selector, { element(el) { el.setInnerContent(title, { html: true }); } })
      .on(t.heroSub.selector, { element(el) { el.setInnerContent(escText(content.heroSub), { html: true }); } })
      .on("head", {
        element(el) {
          el.append(`<style id="wd71-cms">:root{${t.accentColor.cssVar}:${accent};${t.accentColor.lightVar}:${cmsLightShade(accent)}}</style>`, { html: true });
        },
      })
      .transform(res);
  },
};

// Accepts only well-formed content; anything else → null (serve the original page).
function cleanContent(c) {
  if (!c || typeof c !== "object") return null;
  const str = (v, min, max) => typeof v === "string" && [...v].length >= min && [...v].length <= max;
  if (!str(c.heroTitle, 1, 120) || !str(c.heroHighlight ?? "", 0, 40) || !str(c.heroSub ?? "", 0, 300)) return null;
  if (typeof c.accentColor !== "string" || !COLOR_RE.test(c.accentColor)) return null;
  return { heroTitle: c.heroTitle, heroHighlight: c.heroHighlight ?? "", heroSub: c.heroSub ?? "", accentColor: c.accentColor };
}
