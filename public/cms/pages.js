/**
 * WebDesigner71 CMS — shared page-builder model, sanitizer & renderer (Phase 3; blog blocks + TOC anchors: Phase 4).
 *
 * ONE dependency-free module used by three places (no secrets — it is served publicly):
 *   • site-worker/src/index.js    imports it (bundled) and renders published pages server-side
 *   • public/cms/page-bridge.js   imports it inside the editor's preview iframe (same renderer → exact preview)
 *   • public/admin/index.html     loads it with import("/cms/pages.js") for the editor (schema, defaults, patterns)
 *   • public/cms/posts.js          the blog (Phase 4) builds on it: same blocks, same renderer
 *   • admin-worker/src/cms-pages.js is a byte-identical copy used to validate every write;
 *     site-worker/test/check.mjs fails if the two copies differ.
 *
 * Data model (KV CONTENT):
 *   "pages:index"        { pages:[ IndexEntry ] }                  list view (one read)
 *   "page:<id>"          Page (working copy = draft, version-checked)
 *   "page:<id>:prev"     Page before the last save (one-step undo)
 *   "pub:<slug>"         published snapshot — the ONLY key the public site reads, so drafts are never public
 *   "redirect:<slug>"    { to:<slug> } 301 left behind when a published page moves to a new slug
 *
 *   Page  = { id, title, slug, seo:{ title, description, image, noindex }, blocks:[ Block ], version, ... }
 *   Block = { id, type, hidden?, content:{…per type}, style:{…shared schema}, adv:{ anchor, cls, hide:{d,t,m} },
 *             children?:[ Block ] }   (section → any non-section block; columns → column; column → leaf blocks)
 *
 * Safety: every value is validated against an allow-list (no free CSS, no raw HTML except the rich-text
 * subset which is re-tokenised here), every string is escaped on output, links must be
 * http(s)/mailto/tel/#/relative, images must be /media/<key> or /assets/<file>, video only YouTube/Vimeo
 * through their privacy-friendly embed hosts.
 */

export const PAGE_SCHEMA = 1;
export const PKEYS = {
  index: "pages:index",
  page: (id) => "page:" + id,
  prev: (id) => "page:" + id + ":prev",
  pub: (slug) => "pub:" + slug,
  redirect: (slug) => "redirect:" + slug,
};
export const LIMITS = { blocks: 200, bytes: 256 * 1024, pages: 100, items: 24, rows: 30, cols: 8, depth: 3, redirects: 10 };
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 60;
/** Directories shipped in public/ (static assets always win over pages; check.mjs keeps this list honest). */
export const STATIC_DIRS = ["admin", "assets", "cms", "old-homepage"];
export const RESERVED_SLUGS = [...new Set([...STATIC_DIRS, "media", "api", "index", "index-html", "wrangler-jsonc",
  "sitemap", "sitemap-xml", "robots", "robots-txt", "favicon", "404", "login", "logout", "preview", "page-preview", "static", "www",
  "blog"])]; // Phase 4: /blog/* is the blog
export const PAGE_ID_RE = /^p[a-z0-9]{6,20}$/;
export const BLOCK_ID_RE = /^b[a-z0-9]{4,15}$/;
export const COLOR_HEX_RE = /^#[0-9A-Fa-f]{6}$/;
export const PHONE_RE = /^\+?[0-9 ()\-.]{3,30}$/;
export const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;
export const BREAKPOINTS = { tablet: 1024, mobile: 767 };

export class PageError extends Error {
  constructor(field, reason) { super("invalid_field"); this.field = field; this.reason = reason || "invalid"; }
}
const rnd = (n) => { let s = ""; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
export const newBlockId = () => "b" + rnd(8);
export const newPageId = () => "p" + rnd(10);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clen = (s) => [...s].length;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const escHtml = esc;

/* ------------------------------------------------------------------ primitive validators */
function str(v, path, max, o = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new PageError(path, "type");
  let t = o.multiline ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : v.replace(/\s+/g, " ").trim();
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (clen(t) > max) throw new PageError(path, "too_long");
  if (o.min && clen(t) < o.min) throw new PageError(path, "required");
  return t;
}
function num(v, path, min, max, def, step) {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PageError(path, "range");
  return step ? Math.round(v / step) * step : Math.round(v * 100) / 100;
}
function oneOf(v, path, list, def) {
  if (v === undefined || v === null || v === "") return def;
  if (!list.includes(v)) throw new PageError(path, "enum");
  return v;
}
const bool = (v) => v === true;
/** Allowed link targets: http(s)://, mailto:, tel:, #anchor, or a relative path (no scheme, no "//"). */
export function safeHref(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || clen(s) > 500 || /[\s<>"'`\\\u0000-\u001f]/.test(s)) return null;
  if (/^https?:\/\/[^/?#]+/i.test(s)) return s;
  if (/^mailto:[^@]+@[^@]+$/i.test(s)) return s;
  if (/^tel:\+?[0-9()\-.]{3,30}$/i.test(s)) return s;
  if (/^#[A-Za-z0-9_\-]*$/.test(s)) return s;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s) || s.startsWith("//")) return null;
  if (/^[A-Za-z0-9_\-./?=&%~+]+(?:#[A-Za-z0-9_\-]*)?$/.test(s)) return s;
  return null;
}
/** Allowed image sources: /media/<key> (uploads) or /assets/<file> (files shipped in the repo). */
export function safeImg(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s) && !s.includes("..")) return s;
  if (/^\/assets\/[A-Za-z0-9][A-Za-z0-9_\-/]{0,100}\.(?:svg|png|jpe?g|webp|gif)$/.test(s) && !s.includes("..")) return s;
  return null;
}
function href(v, path) {
  if (v === undefined || v === null || v === "") return "";
  const h = safeHref(v);
  if (h === null) throw new PageError(path, "url");
  return h;
}
function img(v, path) {
  if (v === undefined || v === null || v === "") return "";
  const s = safeImg(v);
  if (s === null) throw new PageError(path, "image");
  return s;
}
function list(v, path, max, one) {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v)) throw new PageError(path, "type");
  if (v.length > max) throw new PageError(path, "too_many");
  const seen = new Set();
  return v.map((it, i) => {
    if (!isObj(it)) throw new PageError(path + "." + i, "type");
    let id = typeof it.id === "string" && /^[a-z0-9]{1,16}$/i.test(it.id) && !seen.has(it.id) ? it.id : "i" + rnd(6);
    seen.add(id);
    return { id, ...one(it, path + "." + i) };
  });
}

/* ------------------------------------------------------------------ theme tokens, fonts, colours */
/** Theme colours follow Settings (accent/primary are CSS variables set by the homepage CMS). */
export const THEME_COLORS = {
  primary: { label: "প্রধান (সবুজ)", css: "var(--green)", hex: "#0B3D2E" },
  primary2: { label: "প্রধান হালকা", css: "var(--green-2)", hex: "#12543F" },
  accent: { label: "অ্যাকসেন্ট (সোনালি)", css: "var(--gold)", hex: "#D4A017" },
  accent2: { label: "অ্যাকসেন্ট হালকা", css: "var(--gold-2)", hex: "#E9B930" },
  ink: { label: "লেখা (গাঢ়)", css: "var(--ink)", hex: "#1B2620" },
  muted: { label: "হালকা লেখা", css: "var(--muted)", hex: "#4A5A52" },
  cream: { label: "ক্রিম", css: "var(--cream)", hex: "#FAF7F0" },
  cream2: { label: "ক্রিম গাঢ়", css: "var(--cream-2)", hex: "#F3EDDF" },
  white: { label: "সাদা", css: "#FFFFFF", hex: "#FFFFFF" },
  black: { label: "কালো", css: "#000000", hex: "#000000" },
};
function color(v, path) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "string" && THEME_COLORS[v]) return v;
  if (typeof v === "string" && COLOR_HEX_RE.test(v)) return v.toUpperCase();
  throw new PageError(path, "color");
}
export const colorCss = (v) => (THEME_COLORS[v] ? THEME_COLORS[v].css : v);
export const FONTS = {
  hind: { label: "হিন্দ শিলিগুড়ি (সাইটের ফন্ট)", css: "'Hind Siliguri',sans-serif", g: "" },
  noto: { label: "Noto Sans Bengali", css: "'Noto Sans Bengali',sans-serif", g: "Noto+Sans+Bengali:wght@400;500;600;700" },
  baloo: { label: "Baloo Da 2", css: "'Baloo Da 2',sans-serif", g: "Baloo+Da+2:wght@400;500;600;700" },
  tiro: { label: "Tiro Bangla (সেরিফ)", css: "'Tiro Bangla',serif", g: "Tiro+Bangla" },
  inter: { label: "Inter", css: "'Inter',sans-serif", g: "Inter:wght@300;400;500;600;700;800" },
  poppins: { label: "Poppins", css: "'Poppins',sans-serif", g: "Poppins:wght@300;400;500;600;700;800" },
  playfair: { label: "Playfair Display", css: "'Playfair Display',serif", g: "Playfair+Display:wght@400;500;600;700;800" },
  merri: { label: "Merriweather", css: "'Merriweather',serif", g: "Merriweather:wght@300;400;700" },
};
export const SHADOWS = {
  sm: { label: "হালকা", css: "0 2px 10px rgba(11,61,46,.08)" },
  md: { label: "মাঝারি", css: "0 10px 30px rgba(11,61,46,.12)" },
  lg: { label: "গভীর", css: "0 20px 50px rgba(11,61,46,.18)" },
  xl: { label: "খুব গভীর", css: "0 30px 70px rgba(11,61,46,.26)" },
  gold: { label: "সোনালি আভা", css: "0 12px 30px rgba(212,160,23,.35)" },
};

/* ------------------------------------------------------------------ the ONE style schema (every block) */
// kind: color | num(min,max,step) | enum(values) | img.  r: true → can be overridden per device (tablet/mobile).
const N = (min, max, step, r) => ({ kind: "num", min, max, step, r: !!r });
const E = (values, r) => ({ kind: "enum", values, r: !!r });
export const STYLE_PROPS = {
  color: { kind: "color" },
  bgType: E(["none", "color", "gradient", "image"]),
  bgColor: { kind: "color" }, bgFrom: { kind: "color" }, bgTo: { kind: "color" }, bgAngle: N(0, 360, 1),
  bgImage: { kind: "img" }, bgSize: E(["cover", "contain", "auto"]), bgPos: E(["center", "top", "bottom", "left", "right"]),
  overlay: N(0, 90, 1), overlayColor: { kind: "color" },
  font: E(Object.keys(FONTS)), size: N(10, 96, 1, true), weight: E([300, 400, 500, 600, 700, 800]),
  lh: N(1, 2.4, 0.05), ls: N(-2, 10, 0.1), align: E(["left", "center", "right", "justify"], true),
  pt: N(0, 240, 1, true), pr: N(0, 240, 1, true), pb: N(0, 240, 1, true), pl: N(0, 240, 1, true),
  mt: N(-120, 240, 1, true), mr: N(0, 240, 1, true), mb: N(-120, 240, 1, true), ml: N(0, 240, 1, true),
  bw: N(0, 20, 1), bs: E(["solid", "dashed", "dotted", "double"]), bc: { kind: "color" }, radius: N(0, 200, 1),
  shadow: E(Object.keys(SHADOWS)), w: N(10, 100, 1, true), maxw: N(80, 1600, 1, true), minh: N(0, 1200, 1, true),
  boxAlign: E(["left", "center", "right"], true),
};
export const RESPONSIVE_PROPS = Object.keys(STYLE_PROPS).filter((k) => STYLE_PROPS[k].r);
function cleanProps(raw, path, keys) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) throw new PageError(path, "type");
  for (const [k, v] of Object.entries(raw)) {
    if (k === "t" || k === "m") continue;
    const d = STYLE_PROPS[k];
    if (!d || !keys.includes(k)) throw new PageError(path + "." + k, "unknown");
    let val;
    if (d.kind === "color") val = color(v, path + "." + k);
    else if (d.kind === "num") val = num(v, path + "." + k, d.min, d.max, "", d.step);
    else if (d.kind === "enum") val = oneOf(v, path + "." + k, d.values, "");
    else val = img(v, path + "." + k);
    if (val !== "" && val !== undefined) out[k] = val;
  }
  return out;
}
export function cleanStyle(raw, path = "style") {
  const out = cleanProps(raw, path, Object.keys(STYLE_PROPS));
  for (const dev of ["t", "m"]) {
    const r = raw && raw[dev] !== undefined ? cleanProps(raw[dev], path + "." + dev, RESPONSIVE_PROPS) : {};
    if (Object.keys(r).length) out[dev] = r;
  }
  return out;
}
const ANCHOR_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CLASS_RE = /^[a-z][a-z0-9-]{0,29}$/;
export function cleanAdv(raw, path = "adv") {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new PageError(path, "type");
  const out = {};
  for (const k of Object.keys(raw)) if (!["anchor", "cls", "hide"].includes(k)) throw new PageError(path + "." + k, "unknown");
  if (raw.anchor) { if (typeof raw.anchor !== "string" || !ANCHOR_RE.test(raw.anchor) || raw.anchor === "top") throw new PageError(path + ".anchor", "format"); out.anchor = raw.anchor; }
  if (raw.cls) {
    if (typeof raw.cls !== "string") throw new PageError(path + ".cls", "format");
    const parts = raw.cls.trim().split(/\s+/).filter(Boolean);
    // custom classes can never collide with the builder's own (pb-*, b-*) or the site's layout classes
    if (parts.length > 3 || parts.some((c) => !CLASS_RE.test(c) || /^(pb|b|wd71)-/.test(c))) throw new PageError(path + ".cls", "format");
    if (parts.length) out.cls = parts.join(" ");
  }
  if (raw.hide !== undefined) {
    if (!isObj(raw.hide)) throw new PageError(path + ".hide", "type");
    const h = { d: bool(raw.hide.d), t: bool(raw.hide.t), m: bool(raw.hide.m) };
    if (h.d || h.t || h.m) out.hide = h;
  }
  return out;
}

/* ------------------------------------------------------------------ style → CSS (only from validated values) */
const px = (v) => (v === 0 ? "0" : v + "px");
function propsCss(s, block) {
  const o = [];
  if (s.color) { const c = colorCss(s.color); o.push("color:" + c, "--pb-h:" + c, "--pb-t:" + c); }
  if (s.bgType === "color" && s.bgColor) o.push("background:" + colorCss(s.bgColor));
  else if (s.bgType === "gradient") o.push("background:linear-gradient(" + (s.bgAngle == null ? 135 : s.bgAngle) + "deg," + colorCss(s.bgFrom || "primary") + "," + colorCss(s.bgTo || "primary2") + ")");
  else if (s.bgType === "image" && s.bgImage) {
    const ov = s.overlay ? "linear-gradient(" + overlayRgba(s.overlayColor, s.overlay) + "," + overlayRgba(s.overlayColor, s.overlay) + ")," : "";
    o.push("background:" + ov + 'url("' + s.bgImage + '") ' + (s.bgPos || "center") + "/" + (s.bgSize || "cover") + " no-repeat");
  }
  if (s.font) o.push("font-family:" + FONTS[s.font].css);
  if (s.size != null) o.push("font-size:" + s.size + "px");
  if (s.weight) o.push("font-weight:" + s.weight);
  if (s.lh != null) o.push("line-height:" + s.lh);
  if (s.ls != null) o.push("letter-spacing:" + s.ls + "px");
  if (s.align) o.push("text-align:" + s.align);
  for (const [k, css] of [["pt", "padding-top"], ["pr", "padding-right"], ["pb", "padding-bottom"], ["pl", "padding-left"], ["mt", "margin-top"], ["mb", "margin-bottom"]]) if (s[k] != null) o.push(css + ":" + px(s[k]));
  if (s.boxAlign) o.push(s.boxAlign === "center" ? "margin-left:auto;margin-right:auto" : s.boxAlign === "right" ? "margin-left:auto;margin-right:0" : "margin-left:0;margin-right:auto");
  else { if (s.ml != null) o.push("margin-left:" + px(s.ml)); if (s.mr != null) o.push("margin-right:" + px(s.mr)); }
  if (s.bw) o.push("border:" + s.bw + "px " + (s.bs || "solid") + " " + (s.bc ? colorCss(s.bc) : "currentColor"));
  if (s.radius != null) o.push("border-radius:" + px(s.radius));
  if (s.shadow) o.push("box-shadow:" + SHADOWS[s.shadow].css);
  if (s.w != null) o.push("width:" + s.w + "%");
  if (s.maxw != null) o.push("max-width:" + s.maxw + "px");
  if (s.minh != null) o.push("min-height:" + px(s.minh));
  return o.join(";");
}
function overlayRgba(c, pct) {
  const hex = c ? (THEME_COLORS[c] ? THEME_COLORS[c].hex : c) : "#000000";
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + pct / 100 + ")";
}
const MQ = { t: "@media (max-width:" + BREAKPOINTS.tablet + "px)", m: "@media (max-width:" + BREAKPOINTS.mobile + "px)" };
const HIDE_MQ = { d: "@media (min-width:" + (BREAKPOINTS.tablet + 1) + "px)", t: "@media (min-width:" + (BREAKPOINTS.mobile + 1) + "px) and (max-width:" + BREAKPOINTS.tablet + "px)", m: MQ.m };

/* ------------------------------------------------------------------ rich text: tokenise → allow-list → re-serialise */
const RICH_MAP = { p: "p", div: "p", br: "br", strong: "strong", b: "strong", em: "em", i: "em", a: "a", ul: "ul", ol: "ol", li: "li" };
const RICH_DROP = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "textarea", "select", "title", "head", "xmp", "noembed", "noframes", "plaintext", "frameset", "frame", "applet", "audio", "video", "canvas", "form"]);
const INLINE = new Set(["strong", "em", "a"]);
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", "#39": "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);?/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENT[k] !== undefined) return ENT[k];
    let cp = NaN;
    if (k.startsWith("#x")) cp = parseInt(k.slice(2), 16); else if (k.startsWith("#")) cp = parseInt(k.slice(1), 10);
    if (Number.isFinite(cp) && cp > 31 && cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 127) return String.fromCodePoint(cp);
    return Number.isFinite(cp) ? "" : m;
  });
}
const escT = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
/**
 * Sanitise the rich-text subset (p, br, strong/b, em/i, a[href], ul/ol/li). Anything else is dropped (its text kept,
 * except for script-like elements whose content is dropped too). Output is canonical: sanitizeRich(sanitizeRich(x))
 * === sanitizeRich(x). Links go through safeHref; external links get rel="noopener nofollow".
 */
export function sanitizeRich(input, max = 8000) {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new PageError("text", "type");
  if (input.length > max * 4) throw new PageError("text", "too_long");
  const s = input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  let out = "", i = 0;
  const stack = [];
  const open = (t) => stack.includes(t);
  const closeTo = (t) => { while (stack.length) { const x = stack.pop(); out += "</" + x + ">"; if (x === t) break; } };
  const closeInline = () => { while (stack.length && INLINE.has(stack[stack.length - 1])) out += "</" + stack.pop() + ">"; };
  const text = (t) => { const d = decodeEntities(t).replace(/\s+/g, " "); if (d.trim() || (out && !/>$/.test(out)) || stack.length) out += escT(d); };
  const tagRe = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) { text(s.slice(i)); break; }
    if (lt > i) text(s.slice(i, lt));
    i = lt;
    if (s.startsWith("<!--", i)) { const e = s.indexOf("-->", i + 4); i = e === -1 ? s.length : e + 3; continue; }
    if (/^<[!?]/.test(s.slice(i, i + 2))) { const e = s.indexOf(">", i); i = e === -1 ? s.length : e + 1; continue; }
    const m = tagRe.exec(s.slice(i));
    if (!m) { text("<"); i += 1; continue; }
    i += m[0].length;
    const closing = !!m[1], name = m[2].toLowerCase();
    if (RICH_DROP.has(name)) {
      if (!closing) { const re = new RegExp("</" + name + "\\s*>", "i"); const r = re.exec(s.slice(i)); i = r ? i + r.index + r[0].length : s.length; }
      continue;
    }
    const t = RICH_MAP[name];
    if (!t) continue;
    if (closing) { if (t !== "br" && open(t)) closeTo(t); continue; }
    if (t === "br") { out += "<br>"; continue; }
    if (t === "p") { if (open("li")) continue; if (open("p")) closeTo("p"); else closeInline(); out += "<p>"; stack.push("p"); continue; }
    if (t === "ul" || t === "ol") { if (open("p")) closeTo("p"); else if (open("li")) closeInline(); else closeInline(); out += "<" + t + ">"; stack.push(t); continue; }
    if (t === "li") {
      if (!stack.some((x) => x === "ul" || x === "ol")) continue;
      while (stack.length && !["ul", "ol"].includes(stack[stack.length - 1])) out += "</" + stack.pop() + ">";
      out += "<li>"; stack.push("li"); continue;
    }
    if (stack.length && (stack[stack.length - 1] === "ul" || stack[stack.length - 1] === "ol")) continue; // inline directly in a list
    if (t === "a") {
      if (open("a")) closeTo("a");
      const hm = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(m[3]);
      const h = hm ? safeHref(decodeEntities(hm[1] ?? hm[2] ?? hm[3] ?? "")) : null;
      if (!h) continue;
      out += '<a href="' + esc(h) + '"' + (/^https?:/i.test(h) ? ' rel="noopener nofollow"' : "") + ">"; stack.push("a"); continue;
    }
    if (open(t)) continue; // no <strong> inside <strong>
    out += "<" + t + ">"; stack.push(t);
  }
  while (stack.length) out += "</" + stack.pop() + ">";
  out = out.replace(/<(strong|em|a)( [^>]*)?><\/\1>/g, "").replace(/<p>\s*<\/p>/g, "").replace(/<(ul|ol)><\/\1>/g, "").trim();
  if (clen(out) > max) throw new PageError("text", "too_long");
  return out;
}
/** Plain text → escaped HTML with [[highlight]] and **bold** (the same light markup as the homepage editor). */
export function inlineHtml(text, hl = "hl") {
  const t = String(text || "");
  let out = "", last = 0, m;
  const re = /\*\*([^*]+?)\*\*|\[\[([^\]]+?)\]\]/g;
  while ((m = re.exec(t))) {
    out += esc(t.slice(last, m.index));
    out += m[1] !== undefined ? "<strong>" + esc(m[1]) + "</strong>" : '<span class="' + hl + '">' + esc(m[2]) + "</span>";
    last = re.lastIndex;
  }
  return out + esc(t.slice(last)) ;
}
const nl2br = (t) => inlineHtml(t).replace(/\n/g, "<br>");

/* ------------------------------------------------------------------ video allow-list */
/** YouTube / Vimeo only. Returns { provider, id, url (canonical), embed } or null. */
export function parseVideo(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtube-nocookie\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#][^\s<>"']*)?$/.exec(s);
  if (m) return { provider: "youtube", id: m[1], url: "https://www.youtube.com/watch?v=" + m[1], embed: "https://www.youtube-nocookie.com/embed/" + m[1] + "?rel=0" };
  m = /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?([0-9]{6,12})(?:[/?#][^\s<>"']*)?$/.exec(s);
  if (m) return { provider: "vimeo", id: m[1], url: "https://vimeo.com/" + m[1], embed: "https://player.vimeo.com/video/" + m[1] + "?dnt=1" };
  return null;
}

/* ------------------------------------------------------------------ built-in icons (static SVG, 24×24, stroke) */
export const ICONS = {
  check: { label: "টিক", d: "M20 6 9 17l-5-5" },
  star: { label: "তারা", d: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" },
  bolt: { label: "বিদ্যুৎ", d: "M13 2 3 14h9l-1 8 10-12h-9z" },
  shield: { label: "সুরক্ষা", d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
  heart: { label: "হৃদয়", d: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" },
  phone: { label: "ফোন", d: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" },
  mail: { label: "ইমেইল", d: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm18 2-10 7L2 6" },
  map: { label: "লোকেশন", d: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
  clock: { label: "ঘড়ি", d: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-16v6l4 2" },
  globe: { label: "ওয়েব", d: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" },
  cart: { label: "শপিং", d: "M9 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" },
  chat: { label: "চ্যাট", d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  users: { label: "মানুষ", d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" },
  rocket: { label: "রকেট", d: "M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" },
  gift: { label: "উপহার", d: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zm0 0h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" },
  leaf: { label: "পাতা", d: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10zM2 21c0-3 1.9-5.4 5.1-6" },
  code: { label: "কোড", d: "m16 18 6-6-6-6M8 6l-6 6 6 6" },
  layout: { label: "ডিজাইন", d: "M3 3h18v18H3zM3 9h18M9 21V9" },
  search: { label: "খোঁজ", d: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3" },
  award: { label: "পুরস্কার", d: "M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8.2 13.9 7 23l5-3 5 3-1.2-9.1" },
  bulb: { label: "আইডিয়া", d: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z" },
  info: { label: "তথ্য", d: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01" },
  alert: { label: "সতর্কতা", d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01" },
  edit: { label: "লেখা", d: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" },
};
export function iconSvg(name, cls = "pb-ico") {
  const ic = ICONS[name];
  if (!ic) return "";
  return '<svg class="' + cls + '" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + ic.d + '"/></svg>';
}

/* ------------------------------------------------------------------ slugs */
const BN_V = { "অ": "o", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u", "ঋ": "ri", "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou" };
const BN_K = { "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri", "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou" };
const BN_C = { "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng", "চ": "ch", "ছ": "chh", "জ": "j", "ঝ": "jh", "ঞ": "n", "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n",
  "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n", "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m", "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh", "স": "s", "হ": "h",
  "\uE001": "r", "\uE002": "rh", "\uE003": "y", "ৎ": "t", "ং": "ng", "ঃ": "h", "ঁ": "n" };
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Latin transliteration for Bengali (good-enough phonetic romanisation for URLs). */
export function transliterate(s) {
  const chars = [...String(s || "").normalize("NFC").replace(/\u09A1\u09BC|\u09DC/g, "\uE001").replace(/\u09A2\u09BC|\u09DD/g, "\uE002").replace(/\u09AF\u09BC|\u09DF/g, "\uE003")];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], nx = chars[i + 1];
    if (BN_DIGITS.includes(c)) out += BN_DIGITS.indexOf(c);
    else if (BN_V[c]) out += BN_V[c];
    else if (BN_C[c] !== undefined) {
      out += BN_C[c];
      // inherent "o" between consonants (কলম → kolom), never word-finally (আমাদের → amader) or before ্ / a vowel sign
      if (!["ং", "ঃ", "ঁ", "ৎ"].includes(c) && nx && BN_C[nx] !== undefined) out += "o";
    } else if (BN_K[c]) out += BN_K[c];
    else if (c === "্" && nx === "য" && BN_C[chars[i - 1]]) {
      // ya-phala doubles the consonant: মূল্য → mullo, বিদ্যা → biddya ≈ bidda
      out += BN_C[chars[i - 1]]; i++;
      if (!chars[i + 1] || !/[\u0980-\u09ff]/.test(chars[i + 1])) out += "o";
    } else if (c === "্") continue;
    else if (/[\u0980-\u09ff]/.test(c)) continue;
    else out += c;
  }
  return out;
}
export function slugify(title) {
  let s = transliterate(title).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  s = s.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+[^-]*$/, "") || s.slice(0, SLUG_MAX).replace(/-+$/, "");
  return s;
}
/** "" if ok, else a reason: required | too_long | format | reserved */
export function slugProblem(slug) {
  if (typeof slug !== "string" || !slug) return "required";
  if (slug.length > SLUG_MAX) return "too_long";
  if (!SLUG_RE.test(slug)) return "format";
  if (RESERVED_SLUGS.includes(slug)) return "reserved";
  return "";
}

/* ------------------------------------------------------------------ block content schema (drives validation AND the editor forms) */
const f = {
  s: (k, label, max, o = {}) => ({ k, t: "s", label, max, ...o }),
  rich: (k, label, max) => ({ k, t: "rich", label, max }),
  url: (k, label, o = {}) => ({ k, t: "url", label, ...o }),
  img: (k, label, o = {}) => ({ k, t: "img", label, ...o }),
  e: (k, label, values, labels, def, o = {}) => ({ k, t: "e", label, values, labels, def, ...o }),
  n: (k, label, min, max, def, o = {}) => ({ k, t: "n", label, min, max, def, ...o }),
  b: (k, label, def = false, o = {}) => ({ k, t: "b", label, def, ...o }),
  c: (k, label, o = {}) => ({ k, t: "c", label, ...o }),
  icon: (k, label) => ({ k, t: "icon", label }),
  video: (k, label) => ({ k, t: "video", label }),
  phone: (k, label) => ({ k, t: "phone", label }),
  email: (k, label) => ({ k, t: "email", label }),
  items: (k, label, max, fields, o = {}) => ({ k, t: "items", label, max, fields, ...o }),
  table: (k, label) => ({ k, t: "table", label }),
  code: (k, label, max) => ({ k, t: "code", label, max }),
};
export const CALLOUTS = ["tip", "info", "warn", "success", "note"];
const ALIGN3 = ["left", "center", "right"], ALIGN3_L = { left: "বামে", center: "মাঝে", right: "ডানে" };
export const BUTTON_VARIANTS = ["gold", "green", "outline", "ghost"];
const BTN_L = { gold: "সোনালি", green: "সবুজ", outline: "বর্ডার", ghost: "স্বচ্ছ (গাঢ় ব্যাকগ্রাউন্ডে)" };
const btnFields = [f.s("label", "বাটনের লেখা", 60, { min: 1 }), f.url("href", "লিংক", { def: "#" }), f.e("variant", "স্টাইল", BUTTON_VARIANTS, BTN_L, "gold"), f.b("newTab", "নতুন ট্যাবে খুলবে")];
const btnItems = (max) => f.items("buttons", "বাটন", max, btnFields, { itemLabel: "label", add: { label: "নতুন বাটন", href: "#", variant: "gold" } });
export const RATIOS = { "1-1": [1, 1], "1-2": [1, 2], "2-1": [2, 1], "1-3": [1, 3], "3-1": [3, 1], "1-1-1": [1, 1, 1], "1-2-1": [1, 2, 1], "2-1-1": [2, 1, 1], "1-1-2": [1, 1, 2], "1-1-1-1": [1, 1, 1, 1] };
const RATIO_L = Object.fromEntries(Object.keys(RATIOS).map((k) => [k, k.split("-").length + " কলাম · " + k.replace(/-/g, " : ")]));

/** Block registry. group: layout | basic | media | sections. kids: allowed child types (containers only). */
export const BLOCKS = {
  section: { label: "সেকশন", icon: "▭", group: "layout", desc: "ব্যাকগ্রাউন্ড ও প্যাডিংসহ একটি অংশ — ভেতরে অন্য ব্লক রাখুন",
    fields: [f.e("width", "কনটেন্টের প্রস্থ", ["narrow", "normal", "wide", "full"], { narrow: "সরু (৭৬০px)", normal: "সাধারণ (১১৪০px)", wide: "চওড়া (১৩২০px)", full: "পুরো স্ক্রিন জুড়ে" }, "normal"),
      f.n("gap", "ভেতরের ব্লকগুলোর ফাঁক (px)", 0, 120, 20), f.b("motif", "নকশি-কাঁথা প্যাটার্ন")] },
  columns: { label: "কলাম", icon: "▥", group: "layout", desc: "২–৪টি পাশাপাশি কলাম, মোবাইলে নিচে নিচে",
    fields: [f.e("ratio", "কলাম ও অনুপাত", Object.keys(RATIOS), RATIO_L, "1-1"), f.n("gap", "কলামের ফাঁক (px)", 0, 120, 24),
      f.e("stack", "নিচে নিচে দেখাবে", ["mobile", "tablet", "never"], { mobile: "মোবাইলে", tablet: "ট্যাবলেট ও মোবাইলে", never: "কখনো না" }, "mobile"),
      f.e("valign", "উল্লম্ব অবস্থান", ["top", "center", "bottom", "stretch"], { top: "উপরে", center: "মাঝে", bottom: "নিচে", stretch: "সমান উচ্চতা" }, "top"),
      f.b("reverse", "মোবাইলে উল্টো ক্রমে")] },
  column: { label: "কলাম ঘর", icon: "▯", group: "hidden", fields: [f.n("gap", "ভেতরের ব্লকগুলোর ফাঁক (px)", 0, 120, 16)] },
  breadcrumb: { label: "ব্রেডক্রাম্ব", icon: "›", group: "basic", desc: "হোম › এই পেজ — নেভিগেশনের পথ",
    fields: [f.e("mode", "ধরন", ["auto", "custom"], { auto: "স্বয়ংক্রিয় (হোম › পেজের নাম)", custom: "নিজে লিখুন" }, "auto"), f.s("home", "হোম লিংকের লেখা", 40, { def: "হোম" }),
      f.e("sep", "বিভাজক", ["chevron", "slash", "dot", "arrow"], { chevron: "›", slash: "/", dot: "•", arrow: "→" }, "chevron"),
      f.items("items", "আইটেম (শেষটি বর্তমান পেজ)", 6, [f.s("label", "লেখা", 60, { min: 1 }), f.url("href", "লিংক")], { itemLabel: "label", when: { mode: "custom" }, add: { label: "নতুন", href: "" } })] },
  hero: { label: "হিরো", icon: "★", group: "sections", desc: "বড় শিরোনাম, লেখা, বাটন ও ব্যাকগ্রাউন্ড",
    fields: [f.s("eyebrow", "ছোট ব্যাজ লেখা", 80), f.s("heading", "শিরোনাম", 160, { min: 1, hint: "[[ ]] এর ভেতরের লেখা সোনালি হবে" }), f.s("sub", "সাব-টাইটেল", 400, { multiline: true }), btnItems(3),
      f.img("image", "পাশের ছবি (ঐচ্ছিক)"), f.s("imageAlt", "ছবির বিবরণ (alt)", 150),
      f.e("theme", "রঙের থিম", ["green", "cream", "dark", "gold"], { green: "প্রধান রং", cream: "ক্রিম", dark: "গাঢ়", gold: "সোনালি" }, "green"),
      f.img("bgImage", "ব্যাকগ্রাউন্ড ছবি"), f.n("overlay", "ছবির উপর গাঢ় পর্দা (%)", 0, 90, 55), f.e("align", "লেখার অবস্থান", ["left", "center"], { left: "বামে", center: "মাঝে" }, "left"),
      f.e("height", "উচ্চতা", ["auto", "s", "m", "l", "full"], { auto: "লেখা অনুযায়ী", s: "ছোট", m: "মাঝারি", l: "বড়", full: "পুরো স্ক্রিন" }, "auto"),
      f.e("level", "শিরোনামের লেভেল", ["h1", "h2"], { h1: "H1 (পেজের মূল শিরোনাম)", h2: "H2" }, "h1")] },
  heading: { label: "শিরোনাম", icon: "H", group: "basic", desc: "H1–H6 শিরোনাম",
    fields: [f.s("text", "শিরোনাম", 300, { min: 1, hint: "[[ ]] = সোনালি, ** ** = বোল্ড" }), f.e("level", "লেভেল", ["h1", "h2", "h3", "h4", "h5", "h6"], { h1: "H1", h2: "H2", h3: "H3", h4: "H4", h5: "H5", h6: "H6" }, "h2"),
      f.s("eyebrow", "উপরের ছোট লেখা", 80)] },
  text: { label: "প্যারাগ্রাফ", icon: "¶", group: "basic", desc: "বোল্ড, ইটালিক, লিংক ও লিস্টসহ লেখা", fields: [f.rich("html", "লেখা", 8000)] },
  image: { label: "ছবি", icon: "🖼", group: "media", desc: "মিডিয়া লাইব্রেরি থেকে ছবি",
    fields: [f.img("src", "ছবি"), f.s("alt", "ছবির বিবরণ (alt)", 150), f.s("caption", "ক্যাপশন", 200), f.n("width", "প্রস্থ (%)", 10, 100, 100), f.n("radius", "কোণ গোল (px)", 0, 80, 14),
      f.e("ratio", "আকৃতি", ["auto", "1-1", "4-3", "3-2", "16-9", "3-4"], { auto: "আসল", "1-1": "বর্গ", "4-3": "৪:৩", "3-2": "৩:২", "16-9": "১৬:৯", "3-4": "৩:৪ (লম্বা)" }, "auto"),
      f.e("align", "অবস্থান", ALIGN3, ALIGN3_L, "center"), f.url("href", "ক্লিক করলে লিংক"), f.b("newTab", "নতুন ট্যাবে খুলবে")] },
  buttons: { label: "বাটন", icon: "⬭", group: "basic", desc: "এক বা একাধিক বাটন",
    fields: [btnItems(6), f.e("align", "অবস্থান", ALIGN3, ALIGN3_L, "left"), f.e("size", "আকার", ["sm", "md", "lg"], { sm: "ছোট", md: "মাঝারি", lg: "বড়" }, "md"), f.b("full", "মোবাইলে পুরো প্রস্থ")] },
  list: { label: "লিস্ট", icon: "☰", group: "basic", desc: "টিক/নম্বর/বুলেট লিস্ট",
    fields: [f.items("items", "আইটেম", 30, [f.s("text", "লেখা", 300, { min: 1 })], { itemLabel: "text", add: { text: "নতুন আইটেম" } }),
      f.e("icon", "চিহ্ন", ["check", "dot", "number", "arrow", "star"], { check: "✓ টিক", dot: "• বুলেট", number: "১. নম্বর", arrow: "→ তীর", star: "★ তারা" }, "check"),
      f.e("cols", "কলাম", [1, 2], { 1: "১ কলাম", 2: "২ কলাম" }, 1), f.c("iconColor", "চিহ্নের রং")] },
  table: { label: "টেবিল", icon: "▦", group: "basic", desc: "সারি ও কলাম, হেডার ও স্ট্রাইপ",
    fields: [f.table("rows", "টেবিল"), f.b("header", "প্রথম সারি হেডার", true), f.b("striped", "একটা বাদে একটা রং", true), f.b("bordered", "সব ঘরে বর্ডার"), f.s("caption", "ক্যাপশন", 200)] },
  spacer: { label: "ফাঁকা জায়গা", icon: "↕", group: "layout", desc: "ব্লকের মাঝে উল্লম্ব ফাঁক",
    fields: [f.n("h", "উচ্চতা (px)", 0, 400, 48), f.n("hm", "মোবাইলে উচ্চতা (px, খালি = একই)", 0, 400, "")] },
  divider: { label: "বিভাজক লাইন", icon: "—", group: "layout", desc: "সোজা, ড্যাশ বা নকশি সেলাই লাইন",
    fields: [f.e("variant", "ধরন", ["solid", "dashed", "dotted", "double", "stitch"], { solid: "সোজা", dashed: "ড্যাশ", dotted: "ডট", double: "ডাবল", stitch: "নকশি সেলাই" }, "solid"),
      f.n("thick", "পুরুত্ব (px)", 1, 12, 2), f.c("color", "রং"), f.n("width", "প্রস্থ (%)", 10, 100, 100), f.e("align", "অবস্থান", ALIGN3, ALIGN3_L, "center")] },
  cards: { label: "কার্ড গ্রিড", icon: "▤", group: "sections", desc: "আইকন/ছবি, শিরোনাম ও লেখাসহ ফিচার কার্ড",
    fields: [f.items("items", "কার্ড", 12, [f.icon("icon", "আইকন"), f.img("image", "ছবি (আইকনের বদলে)"), f.s("title", "শিরোনাম", 120, { min: 1 }), f.s("text", "লেখা", 600, { multiline: true }),
      f.url("href", "লিংক"), f.s("linkLabel", "লিংকের লেখা", 40)], { itemLabel: "title", add: { icon: "star", title: "নতুন কার্ড", text: "" } }),
      f.e("cols", "প্রতি সারিতে", [1, 2, 3, 4], { 1: "১টি", 2: "২টি", 3: "৩টি", 4: "৪টি" }, 3),
      f.e("variant", "কার্ডের ধরন", ["card", "bordered", "plain", "green", "cream"], { card: "সাদা কার্ড", bordered: "বর্ডার", plain: "সাধারণ", green: "প্রধান রং", cream: "ক্রিম" }, "card"),
      f.e("align", "লেখার অবস্থান", ["left", "center"], { left: "বামে", center: "মাঝে" }, "left")] },
  testimonial: { label: "রিভিউ", icon: "❝", group: "sections", desc: "গ্রাহকের মতামত ও রেটিং",
    fields: [f.items("items", "রিভিউ", 12, [f.s("quote", "মতামত", 600, { min: 1, multiline: true }), f.s("name", "নাম", 80), f.s("role", "পদবি / প্রতিষ্ঠান", 80), f.img("image", "ছবি"), f.n("rating", "রেটিং (০–৫)", 0, 5, 5)],
      { itemLabel: "name", add: { quote: "চমৎকার কাজ!", name: "নতুন গ্রাহক", rating: 5 } }),
      f.e("cols", "প্রতি সারিতে", [1, 2, 3], { 1: "১টি", 2: "২টি", 3: "৩টি" }, 2),
      f.e("variant", "ধরন", ["card", "plain", "green"], { card: "সাদা কার্ড", plain: "সাধারণ", green: "প্রধান রং" }, "card")] },
  faq: { label: "প্রশ্নোত্তর (FAQ)", icon: "?", group: "sections", desc: "খোলা-বন্ধ করা যায় এমন প্রশ্ন-উত্তর",
    fields: [f.items("items", "প্রশ্ন", 24, [f.s("q", "প্রশ্ন", 200, { min: 1 }), f.s("a", "উত্তর", 1500, { multiline: true, hint: "** ** = বোল্ড" })], { itemLabel: "q", add: { q: "নতুন প্রশ্ন?", a: "উত্তর লিখুন।" } }),
      f.b("openFirst", "প্রথমটি খোলা থাকবে")] },
  cta: { label: "কল-টু-অ্যাকশন", icon: "📣", group: "sections", desc: "রঙিন ব্যানারে শিরোনাম ও বাটন",
    fields: [f.s("eyebrow", "ছোট লেখা", 80), f.s("heading", "শিরোনাম", 160, { min: 1, hint: "[[ ]] এর ভেতরের লেখা সোনালি হবে" }), f.s("text", "লেখা", 400, { multiline: true }), btnItems(3),
      f.e("variant", "রঙ", ["green", "gold", "cream", "white", "dark"], { green: "প্রধান রং", gold: "সোনালি", cream: "ক্রিম", white: "সাদা", dark: "গাঢ়" }, "green"),
      f.e("align", "অবস্থান", ["center", "left"], { center: "মাঝে", left: "বামে" }, "center"), f.b("motif", "নকশি-কাঁথা প্যাটার্ন", true)] },
  video: { label: "ভিডিও", icon: "▶", group: "media", desc: "YouTube বা Vimeo (প্রাইভেসি মোডে)",
    fields: [f.video("url", "YouTube / Vimeo লিংক"), f.s("title", "ভিডিওর নাম (স্ক্রিন রিডারের জন্য)", 120, { def: "ভিডিও" }),
      f.e("ratio", "আকৃতি", ["16-9", "4-3", "1-1", "9-16"], { "16-9": "১৬:৯ (সাধারণ)", "4-3": "৪:৩", "1-1": "বর্গ", "9-16": "৯:১৬ (শর্টস)" }, "16-9"), f.s("caption", "ক্যাপশন", 200)] },
  quote: { label: "উক্তি", icon: "”", group: "basic", desc: "বড় করে দেখানো উদ্ধৃতি",
    fields: [f.s("text", "উক্তি", 600, { min: 1, multiline: true }), f.s("cite", "যার উক্তি", 120),
      f.e("variant", "ধরন", ["line", "big", "card"], { line: "বামে লাইন", big: "বড় ও মাঝে", card: "কার্ড" }, "line")] },
  contact: { label: "যোগাযোগ তথ্য", icon: "☎", group: "sections", desc: "ফোন, ইমেইল, ঠিকানা — সেটিংস থেকে স্বয়ংক্রিয়",
    fields: [f.s("title", "শিরোনাম", 120), f.b("useSettings", "খালি ঘরে সেটিংসের তথ্য বসবে", true), f.phone("phone", "ফোন"), f.phone("whatsapp", "হোয়াটসঅ্যাপ নম্বর"), f.email("email", "ইমেইল"),
      f.s("address", "ঠিকানা", 200), f.s("hours", "সময়", 120), f.url("map", "ম্যাপ লিংক (Google Maps)"),
      f.e("layout", "সাজানো", ["list", "grid"], { list: "লিস্ট", grid: "কার্ড গ্রিড" }, "list")] },
  /* Phase 4 — blog-friendly blocks (work on pages too) */
  toc: { label: "সূচিপত্র", icon: "≡", group: "blog", desc: "লেখার H2/H3 শিরোনাম থেকে নিজে থেকেই তৈরি হয়",
    fields: [f.s("title", "শিরোনাম", 80, { def: "এই লেখায় যা আছে" }), f.e("levels", "যে শিরোনামগুলো দেখাবে", ["h2", "h2-h3"], { h2: "শুধু H2", "h2-h3": "H2 ও H3" }, "h2-h3"),
      f.b("numbered", "নম্বরসহ", true), f.b("collapsible", "খোলা-বন্ধ করা যাবে")] },
  callout: { label: "কলআউট বক্স", icon: "💡", group: "blog", desc: "টিপস, তথ্য, সতর্কতা বা সফলতার রঙিন বক্স",
    fields: [f.e("variant", "ধরন", CALLOUTS, { tip: "💡 টিপস", info: "ℹ️ তথ্য", warn: "⚠️ সতর্কতা", success: "✅ সফলতা", note: "📝 নোট" }, "tip"),
      f.s("title", "শিরোনাম", 120), f.s("text", "লেখা", 1500, { min: 1, multiline: true, hint: "** ** = বোল্ড" })] },
  code: { label: "কোড", icon: "</>", group: "blog", desc: "কোড বা কমান্ড — যেমন লেখা তেমনই দেখাবে",
    fields: [f.code("code", "কোড", 20000), f.s("lang", "ভাষা (যেমন HTML, CSS, JS)", 24), f.s("caption", "ক্যাপশন", 200), f.b("wrap", "লম্বা লাইন ভেঙে দেখাবে")] },
  gallery: { label: "গ্যালারি", icon: "▦", group: "blog", desc: "একাধিক ছবি গ্রিডে, ক্যাপশনসহ",
    fields: [f.items("items", "ছবি", 24, [f.img("image", "ছবি"), f.s("alt", "ছবির বিবরণ (alt)", 150), f.s("caption", "ক্যাপশন", 200)], { itemLabel: "caption", add: { image: "/assets/hero-illustration.svg", alt: "", caption: "" } }),
      f.e("cols", "প্রতি সারিতে", [2, 3, 4], { 2: "২টি", 3: "৩টি", 4: "৪টি" }, 3), f.e("ratio", "আকৃতি", ["1-1", "4-3", "3-2", "16-9", "auto"], { "1-1": "বর্গ", "4-3": "৪:৩", "3-2": "৩:২", "16-9": "১৬:৯", auto: "আসল" }, "4-3"), f.b("zoom", "ক্লিক করলে বড় ছবি খুলবে", true)] },
};
export const BLOCK_TYPES = Object.keys(BLOCKS);
export const CONTAINERS = ["section", "columns", "column"];
const LEAVES = BLOCK_TYPES.filter((t) => !CONTAINERS.includes(t));
/** Which child types a parent accepts ("root" = top level of the page). */
export function accepts(parentType, childType) {
  if (parentType === "root") return childType !== "column";
  if (parentType === "section") return childType !== "section" && childType !== "column";
  if (parentType === "columns") return childType === "column";
  if (parentType === "column") return LEAVES.includes(childType) && childType !== "hero";
  return false;
}

/* ------------------------------------------------------------------ validation (server) — returns canonical copies */
function rethrow(e, path) { if (e instanceof PageError && e.field === "text") throw new PageError(path, e.reason); throw e; }
function cleanField(fd, v, path) {
  switch (fd.t) {
    case "s": return str(v === undefined && fd.def !== undefined ? fd.def : v, path, fd.max, { multiline: fd.multiline, min: fd.min });
    case "rich": try { return sanitizeRich(v, fd.max); } catch (e) { return rethrow(e, path); }
    case "url": return href(v === undefined ? fd.def || "" : v, path);
    case "img": return img(v, path);
    case "e": return oneOf(v, path, fd.values, fd.def);
    case "n": return num(v, path, fd.min, fd.max, fd.def, fd.step);
    case "b": if (v === undefined || v === null) return fd.def; if (typeof v !== "boolean") throw new PageError(path, "type"); return v;
    case "c": return color(v, path);
    case "icon": if (v === undefined || v === null || v === "") return ""; if (typeof v !== "string" || !ICONS[v]) throw new PageError(path, "enum"); return v;
    case "video": { if (v === undefined || v === null || v === "") return ""; const p = parseVideo(v); if (!p) throw new PageError(path, "video"); return p.url; }
    case "phone": { const t = str(v, path, 30); if (t && !PHONE_RE.test(t)) throw new PageError(path, "phone"); return t; }
    case "email": { const t = str(v, path, 120); if (t && !EMAIL_RE.test(t)) throw new PageError(path, "email"); return t; }
    case "items": return list(v, path, fd.max, (it, p) => cleanFields(fd.fields, it, p, ["id"]));
    case "code": {
      // whitespace is meaningful in code: only normalise newlines, drop control characters (tab kept) and blank edges
      if (v === undefined || v === null) v = "";
      if (typeof v !== "string") throw new PageError(path, "type");
      const t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/^\s*\n/, "").replace(/\s+$/, "");
      if (clen(t) > fd.max) throw new PageError(path, "too_long");
      return t;
    }
    case "table": {
      if (v === undefined || v === null) v = [["", ""], ["", ""]];
      if (!Array.isArray(v) || !v.length) throw new PageError(path, "type");
      if (v.length > LIMITS.rows) throw new PageError(path, "too_many");
      let w = 1;
      for (const [i, r] of v.entries()) { if (!Array.isArray(r) || !r.length || r.length > LIMITS.cols) throw new PageError(path + "." + i, r && r.length > LIMITS.cols ? "too_many" : "type"); w = Math.max(w, r.length); }
      return v.map((r, i) => Array.from({ length: w }, (_, j) => str(r[j] === undefined ? "" : r[j], path + "." + i + "." + j, 300)));
    }
  }
  throw new PageError(path, "schema");
}
function cleanFields(fields, raw, path, extra = []) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new PageError(path, "type");
  const known = new Set([...fields.map((x) => x.k), ...extra]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new PageError(path + "." + k, "unknown");
  const out = {};
  for (const fd of fields) out[fd.k] = cleanField(fd, raw[fd.k], path + "." + fd.k);
  return out;
}
const BLOCK_KEYS = new Set(["id", "type", "hidden", "content", "style", "adv", "children"]);
function cleanBlock(raw, path, parentType, st) {
  if (!isObj(raw)) throw new PageError(path, "type");
  if (++st.n > LIMITS.blocks) throw new PageError("blocks", "too_many");
  for (const k of Object.keys(raw)) if (!BLOCK_KEYS.has(k)) throw new PageError(path + "." + k, "unknown");
  const type = raw.type;
  if (typeof type !== "string" || !BLOCKS[type]) throw new PageError(path + ".type", "enum");
  if (!accepts(parentType, type)) throw new PageError(path + ".type", "not_allowed");
  if (typeof raw.id !== "string" || !BLOCK_ID_RE.test(raw.id)) throw new PageError(path + ".id", "format");
  if (st.ids.has(raw.id)) throw new PageError(path + ".id", "duplicate");
  st.ids.add(raw.id);
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") throw new PageError(path + ".hidden", "type");
  const b = { id: raw.id, type };
  if (raw.hidden) b.hidden = true;
  b.content = cleanFields(BLOCKS[type].fields, raw.content, path + ".content");
  b.style = cleanStyle(raw.style, path + ".style");
  b.adv = cleanAdv(raw.adv, path + ".adv");
  if (CONTAINERS.includes(type)) {
    b.children = cleanBlockList(raw.children, path + ".children", type, st);
    if (type === "columns" && b.children.length !== RATIOS[b.content.ratio].length) throw new PageError(path + ".children", "columns");
  } else if (raw.children !== undefined) throw new PageError(path + ".children", "not_allowed");
  return b;
}
function cleanBlockList(v, path, parentType, st) {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v)) throw new PageError(path, "type");
  if (v.length > LIMITS.blocks) throw new PageError("blocks", "too_many");
  return v.map((b, i) => cleanBlock(b, path + "." + i, parentType, st));
}
/** Validate a block tree. Throws PageError(field-path, reason). */
export function cleanBlocks(v, path = "blocks") { return cleanBlockList(v, path, "root", { n: 0, ids: new Set() }); }
export function countBlocks(blocks) { let n = 0; const walk = (l) => { for (const b of l || []) { n++; walk(b.children); } }; walk(blocks); return n; }
export function cleanSeo(raw, path = "seo") {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new PageError(path, "type");
  for (const k of Object.keys(raw)) if (!["title", "description", "image", "noindex"].includes(k)) throw new PageError(path + "." + k, "unknown");
  if (raw.noindex !== undefined && typeof raw.noindex !== "boolean") throw new PageError(path + ".noindex", "type");
  return { title: str(raw.title, path + ".title", 120), description: str(raw.description, path + ".description", 300), image: img(raw.image, path + ".image"), noindex: raw.noindex === true };
}
export function cleanSlug(v, path = "slug") {
  const s = typeof v === "string" ? v.trim() : v;
  const why = slugProblem(s);
  if (why) throw new PageError(path, why);
  return s;
}
export const jsonBytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
/** The editable part of a page: { title, slug, seo, blocks }. Throws PageError. */
export function cleanPageInput(raw) {
  if (!isObj(raw)) throw new PageError("page", "type");
  const out = { title: str(raw.title, "title", 120, { min: 1 }), slug: cleanSlug(raw.slug), seo: cleanSeo(raw.seo), blocks: cleanBlocks(raw.blocks) };
  if (jsonBytes(out) > LIMITS.bytes) throw new PageError("blocks", "too_large");
  return out;
}

/* ------------------------------------------------------------------ new blocks (editor) */
const S = {
  breadcrumb: {},
  hero: { eyebrow: "WebDesigner71", heading: "আপনার ব্যবসার জন্য [[সুন্দর]] ওয়েবসাইট", sub: "এখানে আপনার মূল বার্তাটি লিখুন — এক-দুই লাইনে।", buttons: [{ label: "যোগাযোগ করুন", href: "/#contact", variant: "gold" }] },
  heading: { text: "নতুন শিরোনাম", level: "h2" },
  text: { html: "<p>এখানে আপনার লেখা লিখুন। <strong>বোল্ড</strong>, <em>ইটালিক</em> ও লিংক ব্যবহার করা যায়।</p>" },
  image: { src: "/assets/hero-illustration.svg", alt: "ইলাস্ট্রেশন" },
  buttons: { buttons: [{ label: "আরও জানুন", href: "#", variant: "gold" }, { label: "যোগাযোগ", href: "/#contact", variant: "outline" }] },
  list: { items: [{ text: "প্রথম সুবিধা" }, { text: "দ্বিতীয় সুবিধা" }, { text: "তৃতীয় সুবিধা" }] },
  table: { rows: [["সেবা", "সময়", "মূল্য"], ["ল্যান্ডিং পেজ", "৩ দিন", "৳৫,০০০"], ["বিজনেস সাইট", "৭ দিন", "৳১৫,০০০"]] },
  cards: { items: [{ icon: "bolt", title: "দ্রুত", text: "ঝটপট লোড হয় এমন সাইট।" }, { icon: "shield", title: "নিরাপদ", text: "আধুনিক নিরাপত্তা।" }, { icon: "heart", title: "যত্নশীল", text: "কাজ শেষেও সাপোর্ট।" }] },
  testimonial: { items: [{ quote: "অসাধারণ কাজ, সময়মতো ডেলিভারি।", name: "রহিম উদ্দিন", role: "ব্যবসায়ী", rating: 5 }, { quote: "খুবই পেশাদার ও আন্তরিক।", name: "সাবরিনা আক্তার", role: "উদ্যোক্তা", rating: 5 }] },
  faq: { items: [{ q: "কাজ শেষ হতে কত দিন লাগে?", a: "সাধারণত **৩–৭ দিন**।" }, { q: "পেমেন্ট কীভাবে করব?", a: "বিকাশ, নগদ বা ব্যাংকে।" }], openFirst: true },
  cta: { heading: "আজই শুরু করুন [[আপনার ওয়েবসাইট]]", text: "ফ্রি পরামর্শের জন্য মেসেজ দিন।", buttons: [{ label: "মেসেজ দিন", href: "/#contact", variant: "gold" }] },
  video: { url: "" },
  quote: { text: "ভালো ডিজাইন মানে ভালো ব্যবসা।", cite: "WebDesigner71" },
  contact: { title: "যোগাযোগ করুন" },
  toc: {},
  callout: { variant: "tip", title: "টিপস", text: "এখানে পাঠকের জন্য **গুরুত্বপূর্ণ** একটি কথা লিখুন।" },
  code: { code: "<a class=\"btn\" href=\"/#contact\">যোগাযোগ</a>", lang: "HTML" },
  gallery: { items: [{ image: "/assets/hero-illustration.svg", alt: "ছবি ১" }, { image: "/assets/hero-illustration.svg", alt: "ছবি ২" }, { image: "/assets/hero-illustration.svg", alt: "ছবি ৩" }] },
};
/** A new block of `type` with sample content and fresh ids (columns come with their column children). */
export function newBlock(type, ratio) {
  const b = { id: newBlockId(), type, content: cleanFields(BLOCKS[type].fields, clone(S[type] || {}), type), style: {}, adv: {} };
  if (type === "columns") { if (ratio) b.content.ratio = ratio; b.children = RATIOS[b.content.ratio].map(() => newBlock("column")); }
  else if (CONTAINERS.includes(type)) b.children = [];
  return b;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
/** Deep copy with fresh block ids (duplicate / paste / pattern insert). */
export function cloneBlock(b) { const c = clone(b); const walk = (x) => { x.id = newBlockId(); (x.children || []).forEach(walk); }; walk(c); return c; }
/** Change a columns block's ratio: add empty columns, or move children of removed columns into the last one kept. */
export function setColumnsRatio(b, ratio) {
  const n = RATIOS[ratio].length;
  b.content.ratio = ratio;
  while (b.children.length < n) b.children.push(newBlock("column"));
  if (b.children.length > n) { const extra = b.children.splice(n); for (const c of extra) b.children[n - 1].children.push(...c.children); }
  return b;
}

/* ------------------------------------------------------------------ HTML renderer (worker + preview iframe use the SAME code) */
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "").map(([k, v]) => (v === true ? " " + k : " " + k + '="' + esc(v) + '"')).join("");
function wrapAttrs(b, extra = "", more = {}) {
  const cls = ["pb", "pb-" + b.type, "b-" + b.id, extra, b.adv && b.adv.cls].filter(Boolean).join(" ");
  return attrs({ class: cls, id: b.adv && b.adv.anchor, ...more });
}
const linkA = (h, newTab) => attrs({ href: h, target: newTab ? "_blank" : "", rel: newTab ? "noopener" : /^https?:/i.test(h) ? "noopener" : "" });
const btnsHtml = (items, cls = "pb-btns") => (items && items.length ? '<div class="' + cls + '">' + items.map((x) => "<a" + linkA(x.href || "#", x.newTab) + ' class="btn btn-' + x.variant + '">' + esc(x.label) + "</a>").join("") + "</div>" : "");
const editorPh = (ctx, b, text) => (ctx.editor ? '<div class="pb pb-ph b-' + b.id + '" data-ph="' + b.type + '">' + esc(text) + "</div>" : "");
const RENDER = {
  section: (b, c, ctx, kids) => "<section" + wrapAttrs(b, "w-" + c.width + (c.motif ? " pb-motif" : "")) + '><div class="pb-in">' + kids + "</div></section>",
  columns: (b, c, ctx, kids) => "<div" + wrapAttrs(b, "st-" + c.stack) + ">" + kids + "</div>",
  column: (b, c, ctx, kids) => "<div" + wrapAttrs(b) + ">" + kids + "</div>",
  breadcrumb: (b, c, ctx) => {
    const items = c.mode === "custom" && c.items.length ? c.items : [{ label: c.home || "হোম", href: "/" }, { label: ctx.page.title || "", href: "" }];
    return "<nav" + wrapAttrs(b, "sep-" + c.sep, { "aria-label": "ব্রেডক্রাম্ব" }) + "><ol>" + items.map((it, i) => i === items.length - 1 || !it.href ? '<li aria-current="page">' + esc(it.label) + "</li>" : "<li><a" + linkA(it.href) + ">" + esc(it.label) + "</a></li>").join("") + "</ol></nav>";
  },
  hero: (b, c) => "<section" + wrapAttrs(b, ["th-" + c.theme, "al-" + c.align, "ht-" + c.height, c.image ? "has-img" : "", c.bgImage ? "has-bg" : ""].filter(Boolean).join(" ")) + '><div class="pb-hero-in"><div class="pb-hero-txt">' +
    (c.eyebrow ? '<span class="pb-badge">' + esc(c.eyebrow) + "</span>" : "") + "<" + c.level + ">" + inlineHtml(c.heading) + "</" + c.level + ">" + (c.sub ? '<p class="pb-sub">' + nl2br(c.sub) + "</p>" : "") + btnsHtml(c.buttons) + "</div>" +
    (c.image ? '<div class="pb-hero-img"><img' + attrs({ src: c.image, alt: c.imageAlt, loading: "eager", decoding: "async" }) + "></div>" : "") + "</div></section>",
  heading: (b, c, ctx) => "<div" + wrapAttrs(b, "l" + c.level.slice(1)) + ">" + (c.eyebrow ? '<p class="pb-eyebrow">' + esc(c.eyebrow) + "</p>" : "") + "<" + c.level +
    (ctx.toc && ctx.toc.ids[b.id] && !(b.adv && b.adv.anchor) ? ' id="' + ctx.toc.ids[b.id] + '"' : "") + ">" + inlineHtml(c.text) + "</" + c.level + "></div>",
  text: (b, c, ctx) => (c.html ? "<div" + wrapAttrs(b) + ">" + c.html + "</div>" : editorPh(ctx, b, "খালি প্যারাগ্রাফ — ডানে লেখা যোগ করুন")),
  image: (b, c, ctx) => {
    if (!c.src) return editorPh(ctx, b, "🖼 ছবি বাছুন");
    const im = "<img" + attrs({ src: c.src, alt: c.alt, loading: "lazy", decoding: "async" }) + ">";
    return "<figure" + wrapAttrs(b, "al-" + c.align + (c.ratio !== "auto" ? " r-" + c.ratio : "")) + '><div class="pb-imgw">' + (c.href ? "<a" + linkA(c.href, c.newTab) + ">" + im + "</a>" : im) + "</div>" + (c.caption ? "<figcaption>" + esc(c.caption) + "</figcaption>" : "") + "</figure>";
  },
  buttons: (b, c, ctx) => (c.buttons.length ? "<div" + wrapAttrs(b, "al-" + c.align + " sz-" + c.size + (c.full ? " full" : "")) + ">" + btnsHtml(c.buttons, "pb-btns") + "</div>" : editorPh(ctx, b, "বাটন যোগ করুন")),
  list: (b, c, ctx) => {
    if (!c.items.length) return editorPh(ctx, b, "লিস্টে আইটেম যোগ করুন");
    const tag = c.icon === "number" ? "ol" : "ul";
    return "<" + tag + wrapAttrs(b, "ic-" + c.icon + " cols-" + c.cols) + ">" + c.items.map((x) => "<li>" + inlineHtml(x.text) + "</li>").join("") + "</" + tag + ">";
  },
  table: (b, c) => {
    const rows = c.rows, head = c.header && rows.length > 1;
    const tr = (r, cell) => "<tr>" + r.map((x) => "<" + cell + (cell === "th" ? ' scope="col"' : "") + ">" + inlineHtml(x) + "</" + cell + ">").join("") + "</tr>";
    return "<div" + wrapAttrs(b) + '><table class="' + [c.striped ? "striped" : "", c.bordered ? "bordered" : ""].filter(Boolean).join(" ") + '">' + (c.caption ? "<caption>" + esc(c.caption) + "</caption>" : "") +
      (head ? "<thead>" + tr(rows[0], "th") + "</thead>" : "") + "<tbody>" + (head ? rows.slice(1) : rows).map((r) => tr(r, "td")).join("") + "</tbody></table></div>";
  },
  spacer: (b) => "<div" + wrapAttrs(b, "", { "aria-hidden": "true" }) + "></div>",
  divider: (b, c) => "<hr" + wrapAttrs(b, "dv-" + c.variant + " al-" + c.align) + ">",
  cards: (b, c, ctx) => {
    if (!c.items.length) return editorPh(ctx, b, "কার্ড যোগ করুন");
    return "<div" + wrapAttrs(b, "cols-" + c.cols + " v-" + c.variant + " al-" + c.align) + ">" + c.items.map((x) => '<article class="pb-card">' +
      (x.image ? '<img class="pb-card-img"' + attrs({ src: x.image, alt: "", loading: "lazy", decoding: "async" }) + ">" : x.icon ? '<span class="pb-card-ic">' + iconSvg(x.icon) + "</span>" : "") +
      "<h3>" + (x.href && !x.linkLabel ? "<a" + linkA(x.href) + ">" + esc(x.title) + "</a>" : esc(x.title)) + "</h3>" + (x.text ? "<p>" + nl2br(x.text) + "</p>" : "") +
      (x.href && x.linkLabel ? '<a class="pb-more"' + linkA(x.href) + ">" + esc(x.linkLabel) + ' <span aria-hidden="true">→</span></a>' : "") + "</article>").join("") + "</div>";
  },
  testimonial: (b, c, ctx) => {
    if (!c.items.length) return editorPh(ctx, b, "রিভিউ যোগ করুন");
    return "<div" + wrapAttrs(b, "cols-" + c.cols + " v-" + c.variant) + ">" + c.items.map((x) => '<figure class="pb-testi">' +
      (x.rating ? '<div class="pb-stars" role="img" aria-label="' + esc("রেটিং " + bnDigits(x.rating) + "/৫") + '">' + "★".repeat(Math.round(x.rating)) + '<span class="off">' + "★".repeat(5 - Math.round(x.rating)) + "</span></div>" : "") +
      "<blockquote><p>" + nl2br(x.quote) + "</p></blockquote>" + (x.name || x.role || x.image ? "<figcaption>" + (x.image ? "<img" + attrs({ src: x.image, alt: "", loading: "lazy", width: 48, height: 48 }) + ">" : "") +
      "<span>" + (x.name ? "<strong>" + esc(x.name) + "</strong>" : "") + (x.role ? "<small>" + esc(x.role) + "</small>" : "") + "</span></figcaption>" : "") + "</figure>").join("") + "</div>";
  },
  faq: (b, c, ctx) => (c.items.length ? "<div" + wrapAttrs(b) + ">" + c.items.map((x, i) => '<details class="pb-qa"' + (c.openFirst && i === 0 ? " open" : "") + "><summary><span>" + esc(x.q) + '</span><i class="pm" aria-hidden="true">+</i></summary><div class="pb-qa-a"><p>' + nl2br(x.a) + "</p></div></details>").join("") + "</div>" : editorPh(ctx, b, "প্রশ্ন যোগ করুন")),
  cta: (b, c) => "<section" + wrapAttrs(b, "v-" + c.variant + " al-" + c.align + (c.motif ? " pb-motif" : "")) + '><div class="pb-cta-in">' + (c.eyebrow ? '<p class="pb-eyebrow">' + esc(c.eyebrow) + "</p>" : "") +
    "<h2>" + inlineHtml(c.heading) + "</h2>" + (c.text ? '<p class="pb-lead">' + nl2br(c.text) + "</p>" : "") + btnsHtml(c.buttons) + "</div></section>",
  video: (b, c, ctx) => {
    const v = parseVideo(c.url);
    if (!v) return editorPh(ctx, b, "▶ YouTube / Vimeo লিংক দিন");
    return "<figure" + wrapAttrs(b) + '><div class="pb-frame r-' + c.ratio + '"><iframe' + attrs({ src: v.embed, title: c.title || "ভিডিও", loading: "lazy", allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen", allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin", sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups" }) + "></iframe></div>" + (c.caption ? "<figcaption>" + esc(c.caption) + "</figcaption>" : "") + "</figure>";
  },
  quote: (b, c) => "<figure" + wrapAttrs(b, "v-" + c.variant) + "><blockquote><p>" + nl2br(c.text) + "</p></blockquote>" + (c.cite ? "<figcaption>— " + esc(c.cite) + "</figcaption>" : "") + "</figure>",
  contact: (b, c, ctx) => {
    const st = (c.useSettings && ctx.settings) || {};
    const phone = c.phone || st.contactPhone || "", email = c.email || st.contactEmail || "", address = c.address || st.contactAddress || "";
    const rows = [];
    const tel = (p) => safeHref("tel:" + p.replace(/[\s]/g, ""));
    if (phone && PHONE_RE.test(phone)) rows.push(["phone", "ফোন", phone, tel(phone)]);
    if (c.whatsapp) rows.push(["chat", "হোয়াটসঅ্যাপ", c.whatsapp, "https://wa.me/" + c.whatsapp.replace(/[^0-9]/g, "")]);
    if (email && EMAIL_RE.test(email)) rows.push(["mail", "ইমেইল", email, safeHref("mailto:" + email)]);
    if (address) rows.push(["map", "ঠিকানা", address, c.map || ""]);
    if (c.hours) rows.push(["clock", "সময়", c.hours, ""]);
    if (!rows.length && !c.title) return editorPh(ctx, b, "যোগাযোগের তথ্য দিন (বা সেটিংসে যোগ করুন)");
    return "<div" + wrapAttrs(b, "lay-" + c.layout) + ">" + (c.title ? "<h3>" + esc(c.title) + "</h3>" : "") + "<ul>" + rows.map(([ic, label, val, h]) => '<li><span class="pb-ci">' + iconSvg(ic) + "</span><span><small>" + esc(label) + "</small>" +
      (h ? "<a" + linkA(h, /^https?:/.test(h)) + ">" + esc(val) + "</a>" : "<span>" + esc(val) + "</span>") + "</span></li>").join("") + "</ul></div>";
  },
};
Object.assign(RENDER, {
  toc: (b, c, ctx) => {
    const items = ((ctx.toc && ctx.toc.items) || []).filter((x) => x.level === "h2" || c.levels === "h2-h3");
    if (!items.length) return editorPh(ctx, b, "≡ সূচিপত্র — লেখায় H2/H3 শিরোনাম যোগ করলে এখানে নিজে থেকে দেখাবে");
    const tag = c.numbered ? "ol" : "ul";
    const list = "<" + tag + ">" + items.map((x) => '<li class="lv' + x.level.slice(1) + '"><a href="#' + esc(x.id) + '">' + esc(x.text) + "</a></li>").join("") + "</" + tag + ">";
    const title = c.title || "সূচিপত্র";
    return "<nav" + wrapAttrs(b, c.numbered ? "num" : "", { "aria-label": title }) + ">" + (c.collapsible ? "<details open><summary>" + esc(title) + "</summary>" + list + "</details>" : '<p class="pb-toc-t">' + esc(title) + "</p>" + list) + "</nav>";
  },
  callout: (b, c) => "<aside" + wrapAttrs(b, "v-" + c.variant, { role: "note" }) + '><span class="pb-co-ic" aria-hidden="true">' + iconSvg(CALLOUT_ICON[c.variant]) + "</span><div>" +
    (c.title ? '<p class="pb-co-t">' + esc(c.title) + "</p>" : "") + "<p>" + nl2br(c.text) + "</p></div></aside>",
  code: (b, c, ctx) => (c.code ? "<figure" + wrapAttrs(b, c.wrap ? "wrap" : "") + ">" + (c.lang ? '<div class="pb-code-bar"><span>' + esc(c.lang) + "</span></div>" : "") +
    '<pre dir="ltr" tabindex="0"><code>' + esc(c.code) + "</code></pre>" + (c.caption ? "<figcaption>" + esc(c.caption) + "</figcaption>" : "") + "</figure>" : editorPh(ctx, b, "</> কোড লিখুন")),
  gallery: (b, c, ctx) => {
    const items = c.items.filter((x) => x.image);
    if (!items.length) return editorPh(ctx, b, "▦ গ্যালারিতে ছবি যোগ করুন");
    return "<div" + wrapAttrs(b, "cols-" + c.cols + " r-" + c.ratio) + ">" + items.map((x) => {
      const im = "<img" + attrs({ src: x.image, alt: x.alt, loading: "lazy", decoding: "async" }) + ">";
      return "<figure>" + (c.zoom ? "<a" + attrs({ href: x.image, target: "_blank", rel: "noopener" }) + ">" + im + "</a>" : im) + (x.caption ? "<figcaption>" + esc(x.caption) + "</figcaption>" : "") + "</figure>";
    }).join("") + "</div>";
  },
});
const CALLOUT_ICON = { tip: "bulb", info: "info", warn: "alert", success: "check", note: "edit" };
const bnDigits = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);
/** Plain text of [[hl]] / **bold** markup. */
export const plainInline = (t) => String(t || "").replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\[\[([^\]]+?)\]\]/g, "$1");
/** Table of contents for a block tree: null unless it contains a toc block (so pages without one render exactly as before). */
export function buildToc(blocks) {
  let has = false;
  walkBlocks(blocks, (b) => { if (b.type === "toc" && !b.hidden) has = true; });
  if (!has) return null;
  const items = [], ids = {};
  walkBlocks(blocks, (b) => {
    if (b.hidden || b.type !== "heading" || !b.content || (b.content.level !== "h2" && b.content.level !== "h3")) return;
    const id = (b.adv && b.adv.anchor) || "h-" + b.id;
    ids[b.id] = id;
    items.push({ id, level: b.content.level, text: plainInline(b.content.text) });
  });
  return { items, ids };
}
/** All readable text of a block tree (reading time, excerpts) — driven by the field schema. */
export function blockText(blocks) {
  const out = [];
  const take = (fields, c) => {
    for (const fd of fields) {
      const v = c && c[fd.k];
      if (fd.t === "s" && !/^(lang|alt|imageAlt|bgAlt)$/.test(fd.k)) out.push(plainInline(v));
      else if (fd.t === "rich") out.push(String(v || "").replace(/<(?:\/?(?:p|li|ul|ol|h\d|blockquote|div)|br)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      else if (fd.t === "code") out.push(v);
      else if (fd.t === "items" && Array.isArray(v)) for (const it of v) take(fd.fields, it);
      else if (fd.t === "table" && Array.isArray(v)) for (const r of v) out.push(r.map(plainInline).join(" "));
    }
  };
  walkBlocks(blocks, (b) => { if (!b.hidden && b.type !== "toc" && BLOCKS[b.type]) take(BLOCKS[b.type].fields, b.content); });
  return out.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
/** Every /media/<key> URL referenced anywhere inside a value (media library "used by" counts). */
export function mediaRefs(v, out = new Set()) {
  if (typeof v === "string") { if (/^\/media\/[A-Za-z0-9]/.test(v)) out.add(v); }
  else if (Array.isArray(v)) for (const x of v) mediaRefs(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) mediaRefs(x, out);
  return out;
}
/**
 * Blocks → HTML. ctx = { page:{ title, slug }, settings, editor }. editor:true ONLY adds placeholders for empty
 * blocks / empty containers (so they can be clicked and dropped into); all other output is identical.
 */
export function renderBlocks(blocks, ctx = {}) {
  ctx = { page: {}, settings: null, editor: false, ...ctx };
  const one = (b) => {
    if (b.hidden) return ctx.editor ? '<div class="pb pb-ph pb-hidden b-' + b.id + '" data-ph="hidden">' + esc((BLOCKS[b.type] || {}).label || "") + " — লুকানো</div>" : "";
    const r = RENDER[b.type];
    if (!r) return "";
    let kids = "";
    if (b.children) {
      kids = b.children.map(one).join("");
      if (ctx.editor && !b.children.length && b.type !== "columns") kids = '<div class="pb-drop" data-drop="' + b.id + '">+ এখানে ব্লক টেনে আনুন</div>';
    }
    return r(b, b.content || {}, ctx, kids);
  };
  return (blocks || []).map(one).join("\n");
}

/* ------------------------------------------------------------------ CSS. Base rules are at most (0,2,0) and come first; per-block rules are ".pb.b-<id>" (0,2,0) and come last, so user styles always win. */
const T = BREAKPOINTS.tablet, Mo = BREAKPOINTS.mobile;
export const BASE_CSS = `
.pb-root{display:block}
.pb-flow{padding:40px 0}
.pb-in{width:100%;max-width:1140px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:20px}
.pb-section{padding:72px 0;position:relative;color:var(--pb-t,inherit)}
.pb-section.w-narrow>.pb-in{max-width:760px}.pb-section.w-wide>.pb-in{max-width:1320px}.pb-section.w-full>.pb-in{max-width:none}
.pb-motif{background-image:radial-gradient(circle at 50% 50%,rgba(212,160,23,.22) 2px,transparent 2.5px),linear-gradient(45deg,transparent 46%,rgba(212,160,23,.12) 47%,rgba(212,160,23,.12) 53%,transparent 54%),linear-gradient(-45deg,transparent 46%,rgba(212,160,23,.12) 47%,rgba(212,160,23,.12) 53%,transparent 54%);background-size:28px 28px}
.pb-columns{display:grid;gap:24px;align-items:start}
.pb-column{display:flex;flex-direction:column;gap:16px;min-width:0}
.pb-heading{color:var(--pb-h,var(--green));font-weight:700;line-height:1.3}
.pb-heading>h1,.pb-heading>h2,.pb-heading>h3,.pb-heading>h4,.pb-heading>h5,.pb-heading>h6{font:inherit;color:inherit;letter-spacing:inherit;margin:0}
.pb-heading.l1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.25}.pb-heading.l2{font-size:clamp(1.6rem,4.5vw,2.4rem)}.pb-heading.l3{font-size:clamp(1.3rem,3vw,1.7rem)}
.pb-heading.l4{font-size:1.25rem}.pb-heading.l5{font-size:1.1rem}.pb-heading.l6{font-size:1rem;text-transform:uppercase;letter-spacing:.04em}
.pb-eyebrow{color:var(--gold);font-weight:600;font-size:.95rem;line-height:1.4;margin-bottom:6px;letter-spacing:.02em}
.pb .hl{color:var(--gold)}
.pb-text{color:var(--pb-t,inherit)}
.pb-text p+p,.pb-text p+ul,.pb-text p+ol,.pb-text ul+p,.pb-text ol+p{margin-top:.8em}
.pb-text ul,.pb-text ol{padding-left:1.4em}.pb-text li+li{margin-top:.3em}
.pb-text a,.pb-list a,.pb-table a,.pb-faq a{color:inherit;text-decoration:underline;text-decoration-color:var(--gold);text-underline-offset:3px}
.pb-image{display:flex;flex-direction:column;gap:8px}
.pb-image.al-center{align-items:center}.pb-image.al-left{align-items:flex-start}.pb-image.al-right{align-items:flex-end}
.pb-imgw{max-width:100%;overflow:hidden}.pb-imgw img{width:100%;height:auto}
.pb-image.r-1-1 img{aspect-ratio:1/1;object-fit:cover}.pb-image.r-4-3 img{aspect-ratio:4/3;object-fit:cover}.pb-image.r-3-2 img{aspect-ratio:3/2;object-fit:cover}
.pb-image.r-16-9 img{aspect-ratio:16/9;object-fit:cover}.pb-image.r-3-4 img{aspect-ratio:3/4;object-fit:cover}
.pb-image figcaption,.pb-video figcaption{font-size:.9rem;color:var(--muted);text-align:center}
.pb-btns{display:flex;flex-wrap:wrap;gap:12px}
.pb-buttons.al-center .pb-btns{justify-content:center}.pb-buttons.al-right .pb-btns{justify-content:flex-end}
.pb-buttons.sz-sm .btn{padding:8px 18px;font-size:.92rem}.pb-buttons.sz-lg .btn{padding:17px 36px;font-size:1.15rem}
.pb-btns .btn{width:auto}
.pb-list{list-style:none;display:grid;gap:10px;padding:0}
.pb-list.cols-2{grid-template-columns:1fr 1fr;column-gap:28px}
.pb-list li{position:relative;padding-left:30px}
.pb-list li::before{position:absolute;left:0;top:0;width:22px;text-align:center;color:var(--pb-ic,var(--gold));font-weight:700}
.pb-list.ic-check li::before{content:"✓"}.pb-list.ic-dot li::before{content:"•";font-size:1.3em;line-height:1.2}.pb-list.ic-arrow li::before{content:"→"}.pb-list.ic-star li::before{content:"★"}
.pb-list.ic-number{counter-reset:pbn}.pb-list.ic-number li{counter-increment:pbn}.pb-list.ic-number li::before{content:counter(pbn,bengali) "."}
.pb-table{overflow-x:auto;-webkit-overflow-scrolling:touch}
.pb-table table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:.97rem}
.pb-table th,.pb-table td{padding:12px 16px;text-align:left;vertical-align:top;border-bottom:1px solid rgba(11,61,46,.1)}
.pb-table th{background:var(--green);color:#fff;font-weight:600}
.pb-table .striped tbody tr:nth-child(even){background:var(--cream)}
.pb-table .bordered th,.pb-table .bordered td{border:1px solid rgba(11,61,46,.15)}
.pb-table caption{caption-side:bottom;padding-top:8px;font-size:.9rem;color:var(--muted)}
.pb-spacer{height:48px}
.pb-divider{border:0;border-top:2px solid rgba(11,61,46,.15);width:100%;margin:0 auto}
.pb-divider.al-left{margin-left:0}.pb-divider.al-right{margin-right:0}
.pb-cards{display:grid;gap:22px;grid-template-columns:repeat(3,minmax(0,1fr))}
.pb-cards.cols-1{grid-template-columns:1fr}.pb-cards.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-cards.cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.pb-card{display:flex;flex-direction:column;gap:10px;padding:26px;border-radius:var(--radius)}
.pb-cards.v-card .pb-card{background:#fff;box-shadow:var(--shadow)}
.pb-cards.v-bordered .pb-card{border:1.5px solid rgba(11,61,46,.14);background:transparent}
.pb-cards.v-plain .pb-card{padding:0}
.pb-cards.v-green .pb-card{background:var(--green);color:#fff;--pb-h:#fff}
.pb-cards.v-cream .pb-card{background:var(--cream-2)}
.pb-cards.al-center .pb-card{text-align:center;align-items:center}
.pb-card h3{color:var(--pb-h,var(--green));font-size:1.2rem;line-height:1.35}.pb-card h3 a{color:inherit;text-decoration:none}
.pb-card p{color:inherit;opacity:.88}
.pb-card-ic{display:inline-flex;width:52px;height:52px;border-radius:14px;align-items:center;justify-content:center;background:rgba(212,160,23,.16);color:var(--gold)}
.pb-card-img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:12px}
.pb-ico{width:26px;height:26px;display:block}
.pb-more{color:var(--gold);font-weight:600;text-decoration:none;margin-top:auto}
.pb-testimonial{display:grid;gap:22px;grid-template-columns:repeat(2,minmax(0,1fr))}
.pb-testimonial.cols-1{grid-template-columns:1fr}.pb-testimonial.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.pb-testi{display:flex;flex-direction:column;gap:12px;padding:26px;border-radius:var(--radius)}
.pb-testimonial.v-card .pb-testi{background:#fff;box-shadow:var(--shadow)}
.pb-testimonial.v-plain .pb-testi{padding:0}
.pb-testimonial.v-green .pb-testi{background:var(--green);color:#fff}
.pb-stars{color:var(--gold);letter-spacing:2px}.pb-stars .off{opacity:.25}
.pb-testi blockquote{font-size:1.05rem}
.pb-testi figcaption{display:flex;align-items:center;gap:12px}.pb-testi figcaption img{width:48px;height:48px;border-radius:50%;object-fit:cover}
.pb-testi figcaption span{display:flex;flex-direction:column;line-height:1.35}.pb-testi small{opacity:.75}
.pb-faq{display:flex;flex-direction:column;gap:12px}
.pb-qa{background:#fff;border-radius:14px;box-shadow:0 4px 16px rgba(11,61,46,.06);color:var(--ink)}
.pb-qa summary{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 22px;cursor:pointer;font-weight:600;color:var(--green);list-style:none}
.pb-qa summary::-webkit-details-marker{display:none}
.pb-qa .pm{font-style:normal;font-size:1.4rem;line-height:1;color:var(--gold);transition:transform .2s}
.pb-qa[open] .pm{transform:rotate(45deg)}
.pb-qa-a{padding:0 22px 18px;color:var(--muted)}
.pb-cta{padding:64px 0;border-radius:0}
.pb-cta-in{max-width:820px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:14px}
.pb-cta.al-center .pb-cta-in{text-align:center;align-items:center}.pb-cta.al-left .pb-cta-in{max-width:1140px}
.pb-cta h2{font-size:clamp(1.6rem,4.5vw,2.4rem);line-height:1.3;color:var(--pb-h,inherit)}
.pb-cta .pb-lead{font-size:1.08rem;opacity:.9}
.pb-cta.v-green{background-color:var(--green);color:#fff}.pb-cta.v-green .hl{color:var(--gold-2)}
.pb-cta.v-dark{background-color:#071F17;color:#fff}.pb-cta.v-dark .hl{color:var(--gold-2)}
.pb-cta.v-gold{background-color:var(--gold);color:var(--green)}.pb-cta.v-gold .hl{color:#fff}
.pb-cta.v-cream{background-color:var(--cream-2);color:var(--ink);--pb-h:var(--green)}
.pb-cta.v-white{background-color:#fff;color:var(--ink);--pb-h:var(--green)}
.pb-in>.pb-cta,.pb-column>.pb-cta{border-radius:var(--radius);padding:48px 0}
.pb-hero{position:relative;padding:88px 0;display:flex;align-items:center;background-size:cover;background-position:center}
.pb-hero.th-green{background-color:var(--green);color:#fff;background-image:linear-gradient(160deg,var(--green) 0%,var(--green-3) 100%)}
.pb-hero.th-dark{background-color:#071F17;color:#fff}
.pb-hero.th-gold{background-color:var(--gold);color:var(--green)}
.pb-hero.th-cream{background-color:var(--cream-2);color:var(--ink)}
.pb-hero.ht-s{min-height:320px}.pb-hero.ht-m{min-height:460px}.pb-hero.ht-l{min-height:620px}.pb-hero.ht-full{min-height:calc(100vh - 64px)}
.pb-hero-in{width:100%;max-width:1140px;margin:0 auto;padding:0 20px;display:grid;gap:40px;align-items:center}
.pb-hero.has-img .pb-hero-in{grid-template-columns:1.1fr .9fr}
.pb-hero-txt{display:flex;flex-direction:column;gap:14px;align-items:flex-start}
.pb-hero.al-center .pb-hero-txt{align-items:center;text-align:center;max-width:820px;margin:0 auto}
.pb-hero h1,.pb-hero h2{font-size:clamp(2rem,6.5vw,3.3rem);line-height:1.25;margin:0;font-weight:700}
.pb-hero.th-green .hl,.pb-hero.th-dark .hl{color:var(--gold-2)}.pb-hero.th-gold .hl{color:#fff}
.pb-hero .pb-sub{font-size:1.12rem;opacity:.92;max-width:640px}
.pb-hero .pb-btns{margin-top:8px}
.pb-hero.al-center .pb-btns{justify-content:center}
.pb-hero-img img{width:100%;height:auto;border-radius:var(--radius)}
.pb-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(212,160,23,.15);border:1px solid rgba(212,160,23,.6);color:var(--gold-2);padding:6px 16px;border-radius:999px;font-weight:600;font-size:.95rem}
.pb-hero.th-cream .pb-badge,.pb-hero.th-gold .pb-badge{color:var(--green)}
.pb-video{display:flex;flex-direction:column;gap:8px}
.pb-frame{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--radius);overflow:hidden;background:#000}
.pb-frame.r-4-3{aspect-ratio:4/3}.pb-frame.r-1-1{aspect-ratio:1/1}.pb-frame.r-9-16{aspect-ratio:9/16;max-width:420px;margin:0 auto}
.pb-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.pb-quote blockquote{font-size:1.2rem;line-height:1.6}
.pb-quote figcaption{margin-top:10px;color:var(--muted);font-weight:600}
.pb-quote.v-line{border-left:4px solid var(--gold);padding:6px 0 6px 22px}
.pb-quote.v-big{text-align:center}.pb-quote.v-big blockquote{font-size:clamp(1.4rem,3.6vw,2rem);color:var(--green);font-weight:600}
.pb-quote.v-big blockquote::before{content:"“";display:block;font-size:3.5rem;line-height:.8;color:var(--gold)}
.pb-quote.v-card{background:#fff;box-shadow:var(--shadow);border-radius:var(--radius);padding:28px}
.pb-contact h3{color:var(--pb-h,var(--green));font-size:1.35rem;margin-bottom:14px}
.pb-contact ul{list-style:none;display:grid;gap:14px}
.pb-contact.lay-grid ul{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.pb-contact.lay-grid li{background:#fff;border-radius:14px;padding:16px;box-shadow:0 4px 16px rgba(11,61,46,.06)}
.pb-contact li{display:flex;gap:14px;align-items:flex-start}
.pb-contact li>span:last-child{display:flex;flex-direction:column;line-height:1.45;min-width:0;overflow-wrap:anywhere}
.pb-contact small{color:var(--muted);font-size:.85rem}
.pb-contact a{color:inherit;font-weight:600;text-decoration:none}
.pb-ci{flex:0 0 auto;display:inline-flex;width:42px;height:42px;border-radius:12px;align-items:center;justify-content:center;background:rgba(212,160,23,.16);color:var(--gold)}
.pb-ci .pb-ico{width:22px;height:22px}
.pb-breadcrumb ol{list-style:none;display:flex;flex-wrap:wrap;gap:6px;font-size:.92rem;color:var(--muted)}
.pb-breadcrumb li+li::before{margin-right:6px;opacity:.6}
.pb-breadcrumb.sep-chevron li+li::before{content:"›"}.pb-breadcrumb.sep-slash li+li::before{content:"/"}.pb-breadcrumb.sep-dot li+li::before{content:"•"}.pb-breadcrumb.sep-arrow li+li::before{content:"→"}
.pb-breadcrumb a{color:var(--green);text-decoration:none;font-weight:600}
.pb-404{padding:96px 0;text-align:center}
.pb-404 .pb-in{align-items:center;max-width:680px}
.pb-404 .code{font-size:clamp(4rem,14vw,7rem);font-weight:700;color:var(--gold);line-height:1}
.pb-404 h1{color:var(--green);font-size:clamp(1.6rem,4.5vw,2.3rem);margin:0}
.pb-toc{background:#fff;border:1px solid rgba(11,61,46,.12);border-left:4px solid var(--gold);border-radius:14px;padding:18px 22px}
.pb-toc-t,.pb-toc summary{font-weight:700;color:var(--green);font-size:1.05rem;margin:0 0 8px;cursor:pointer}
.pb-toc ol,.pb-toc ul{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px;line-height:1.5}
.pb-toc li.lv3{margin-left:18px;font-size:.95em}
.pb-toc a{color:var(--ink);text-decoration:none;border-bottom:1px dashed rgba(11,61,46,.25)}
.pb-toc a:hover{color:var(--green);border-bottom-color:var(--gold)}
.pb-callout{display:flex;gap:14px;align-items:flex-start;padding:18px 20px;border-radius:14px;border:1px solid;line-height:1.75}
.pb-callout p{margin:0}.pb-callout .pb-co-t{font-weight:700;margin-bottom:4px}
.pb-co-ic{flex:0 0 auto;display:inline-flex;width:36px;height:36px;border-radius:10px;align-items:center;justify-content:center;background:rgba(255,255,255,.7)}
.pb-co-ic .pb-ico{width:20px;height:20px}
.pb-callout.v-tip{background:#fdf6e3;border-color:rgba(212,160,23,.45);color:#5c4708}.pb-callout.v-tip .pb-co-ic{color:#a57a06}
.pb-callout.v-info{background:#eaf3fb;border-color:#b9d5ee;color:#1d4466}.pb-callout.v-info .pb-co-ic{color:#2468a8}
.pb-callout.v-warn{background:#fdeeee;border-color:#f0c2c2;color:#6b1f1f}.pb-callout.v-warn .pb-co-ic{color:#b42318}
.pb-callout.v-success{background:#e8f5ee;border-color:#b5dcc6;color:#0b3d2e}.pb-callout.v-success .pb-co-ic{color:#14804a}
.pb-callout.v-note{background:#f5f4f0;border-color:#dcd8cc;color:#3b3a36}.pb-callout.v-note .pb-co-ic{color:#6b6758}
.pb-code{margin:0;border-radius:14px;overflow:hidden;background:#0f1f1a;color:#e8efe9;box-shadow:0 1px 0 rgba(0,0,0,.04)}
.pb-code-bar{display:flex;justify-content:space-between;padding:8px 16px;background:#16302a;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:#a8c2b8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pb-code pre{margin:0;padding:16px 18px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:.9rem;line-height:1.65;tab-size:2;text-align:left}
.pb-code.wrap pre{white-space:pre-wrap;overflow-wrap:anywhere}
.pb-code figcaption{padding:8px 16px;font-size:.85rem;color:#a8c2b8;background:#16302a}
.pb-gallery{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr))}
.pb-gallery.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-gallery.cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.pb-gallery figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.pb-gallery a{display:block;border-radius:12px;overflow:hidden}
.pb-gallery img{display:block;width:100%;height:auto;border-radius:12px;object-fit:cover;background:#efe9dc;transition:transform .3s ease}
.pb-gallery a:hover img{transform:scale(1.03)}
.pb-gallery.r-1-1 img{aspect-ratio:1/1}.pb-gallery.r-4-3 img{aspect-ratio:4/3}.pb-gallery.r-3-2 img{aspect-ratio:3/2}.pb-gallery.r-16-9 img{aspect-ratio:16/9}
.pb-gallery figcaption{font-size:.88rem;color:var(--muted);text-align:center;line-height:1.5}
@media (max-width:${T}px){.pb-cards.cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-testimonial.cols-3{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-hero.has-img .pb-hero-in{grid-template-columns:1fr}}
@media (max-width:${Mo}px){.pb-section{padding:48px 0}.pb-hero{padding:56px 0}.pb-cta{padding:44px 0}.pb-flow{padding:28px 0}
.pb-cards,.pb-cards.cols-2,.pb-cards.cols-4,.pb-testimonial,.pb-testimonial.cols-3,.pb-list.cols-2{grid-template-columns:1fr}
.pb-buttons.full .btn{width:100%}.pb-table th,.pb-table td{padding:10px 12px}.pb-card,.pb-testi{padding:22px}
.pb-gallery,.pb-gallery.cols-3,.pb-gallery.cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-callout{padding:14px 16px}}
`.replace(/\n/g, "");
/** Editor-only additions (placeholders, drop markers, selection) — injected by the preview bridge, never served publicly. */
export const EDITOR_CSS = `
.pb-ph{border:2px dashed rgba(11,61,46,.25);border-radius:12px;padding:22px;text-align:center;color:var(--muted);font-weight:600;background:rgba(255,255,255,.6);min-height:64px}
.pb-ph.pb-hidden{opacity:.55;font-weight:500;padding:10px}
.pb-drop{border:2px dashed rgba(212,160,23,.6);border-radius:12px;padding:18px;text-align:center;color:#8a6a0d;background:rgba(212,160,23,.07);font-size:.95rem}
.pb-empty{max-width:640px;margin:80px auto;text-align:center;padding:40px 20px;border:2px dashed rgba(11,61,46,.2);border-radius:20px;color:var(--muted)}
.pb-empty b{display:block;color:var(--green);font-size:1.3rem;margin-bottom:6px}
.pb{cursor:default}.pb a,.pb summary{cursor:pointer}
.pbx-hover{outline:2px dashed rgba(212,160,23,.9)!important;outline-offset:-2px}
.pbx-sel{outline:2.5px solid #D4A017!important;outline-offset:-2.5px}
.pbx-drag{opacity:.4}
#pbx-line{position:fixed;z-index:9999;pointer-events:none;background:#D4A017;border-radius:3px;box-shadow:0 0 0 2px #fff;display:none}
#pbx-box{position:fixed;z-index:9998;pointer-events:none;border:2.5px dashed #D4A017;background:rgba(212,160,23,.08);border-radius:10px;display:none}
#pbx-tag{position:fixed;z-index:10000;pointer-events:none;background:#D4A017;color:#0B3D2E;font:600 12px/1.6 'Hind Siliguri',sans-serif;padding:0 8px;border-radius:6px 6px 0 0;display:none;white-space:nowrap}
`.replace(/\n/g, "");
const VALIGN = { top: "start", center: "center", bottom: "end", stretch: "stretch" };
const DIV_DEF = { solid: "rgba(11,61,46,.15)", dashed: "rgba(11,61,46,.25)", dotted: "rgba(11,61,46,.3)", double: "rgba(11,61,46,.2)", stitch: "var(--gold)" };
function contentCss(b, sel) {
  const c = b.content || {}, o = [];
  switch (b.type) {
    case "section": if (c.gap !== 20) o.push(sel + ">.pb-in{gap:" + px(c.gap) + "}"); break;
    case "column": if (c.gap !== 16) o.push(sel + "{gap:" + px(c.gap) + "}"); break;
    case "columns": {
      o.push(sel + "{grid-template-columns:" + RATIOS[c.ratio].map((x) => "minmax(0," + x + "fr)").join(" ") + ";gap:" + px(c.gap) + ";align-items:" + VALIGN[c.valign] + "}");
      if (c.stack !== "never") o.push(MQ[c.stack === "tablet" ? "t" : "m"] + "{" + sel + "{grid-template-columns:minmax(0,1fr)" + (c.reverse ? ";display:flex;flex-direction:column-reverse" : "") + "}}");
      break;
    }
    case "image": o.push(sel + " .pb-imgw{width:" + c.width + "%;border-radius:" + px(c.radius) + "}"); break;
    case "spacer": o.push(sel + "{height:" + px(c.h) + "}"); if (c.hm !== "" && c.hm != null) o.push(MQ.m + "{" + sel + "{height:" + px(c.hm) + "}}"); break;
    case "divider": {
      const col = c.color ? colorCss(c.color) : DIV_DEF[c.variant];
      const style = c.variant === "stitch" ? "dashed" : c.variant;
      o.push(sel + "{border-top:" + (c.variant === "double" ? Math.max(3, c.thick) : c.thick) + "px " + style + " " + col + ";width:" + c.width + "%}");
      break;
    }
    case "list": if (c.iconColor) o.push(sel + "{--pb-ic:" + colorCss(c.iconColor) + "}"); break;
    case "hero": if (c.bgImage) {
      const ov = c.overlay / 100, rgb = c.theme === "cream" ? "250,247,240" : c.theme === "gold" ? "212,160,23" : "6,30,22";
      o.push(sel + '{background-image:linear-gradient(rgba(' + rgb + "," + ov + "),rgba(" + rgb + "," + ov + ')),url("' + c.bgImage + '")}');
    } break;
  }
  return o.join("");
}
function blockCss(b) {
  const sel = ".pb.b-" + b.id, s = b.style || {};
  let out = contentCss(b, sel);
  const base = propsCss(s, b);
  if (base) out += sel + "{" + base + "}";
  for (const d of ["t", "m"]) if (s[d]) { const r = propsCss(s[d], b); if (r) out += MQ[d] + "{" + sel + "{" + r + "}}"; }
  const h = b.adv && b.adv.hide;
  if (h) for (const d of ["d", "t", "m"]) if (h[d]) out += HIDE_MQ[d] + "{" + sel + "{display:none!important}}";
  return out;
}
const walkBlocks = (blocks, fn) => { for (const b of blocks || []) { fn(b); walkBlocks(b.children, fn); } };
/** All CSS for a page. Built only from validated tokens/numbers/paths, so it can never contain "<" (asserted). */
export function pageCss(blocks, { base = true } = {}) {
  let css = base ? BASE_CSS : "";
  walkBlocks(blocks, (b) => { if (!b.hidden) css += blockCss(b); });
  if (/[<\\]/.test(css)) throw new Error("unsafe_css");
  return css;
}
export function blocksCss(blocks) { return pageCss(blocks, { base: false }); }
/** Google Fonts stylesheet URL for the fonts a page uses ("" when only the site font is used). */
export function fontsHref(blocks) {
  const used = new Set();
  walkBlocks(blocks, (b) => { if (b.style && b.style.font && FONTS[b.style.font].g) used.add(FONTS[b.style.font].g); });
  return used.size ? "https://fonts.googleapis.com/css2?" + [...used].sort().map((g) => "family=" + g).join("&") + "&display=swap" : "";
}
const FULL_WIDTH = new Set(["section", "hero", "cta"]);
/** <main> inner HTML: full-width blocks stand alone; runs of other top-level blocks are wrapped in a centred container. */
export function renderMain(blocks, ctx = {}) {
  if (ctx.toc === undefined) ctx = { ...ctx, toc: buildToc(blocks) };
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push('<div class="pb-flow"><div class="pb-in">' + renderBlocks(run, ctx) + "</div></div>"); run = []; };
  for (const b of blocks || []) {
    if (FULL_WIDTH.has(b.type) && !b.hidden) { flush(); out.push(renderBlocks([b], ctx)); } else run.push(b);
  }
  flush();
  if (ctx.editor && !(blocks || []).length) out.push('<div class="pb-empty"><b>পেজটি এখনো খালি</b>বাম পাশের লাইব্রেরি থেকে ব্লক বা প্যাটার্ন টেনে আনুন, অথবা ক্লিক করে যোগ করুন।</div>');
  return '<div class="pb-root">' + out.join("\n") + "</div>";
}
/**
 * Everything the site worker needs to serve a published page. `page` is the published snapshot
 * { title, slug, seo, blocks } — re-validated here so a bad KV write can never reach HTML unescaped.
 */
export function renderPage(page, settings = null, { editor = false } = {}) {
  const clean = { title: str(page.title, "title", 120), slug: page.slug, seo: cleanSeo(page.seo), blocks: cleanBlocks(page.blocks) };
  const ctx = { page: { title: clean.title, slug: clean.slug }, settings, editor };
  return {
    title: clean.seo.title || clean.title,
    description: clean.seo.description,
    noindex: clean.seo.noindex,
    ogImage: clean.seo.image,
    css: pageCss(clean.blocks),
    fontsHref: fontsHref(clean.blocks),
    main: renderMain(clean.blocks, ctx),
  };
}
export function renderNotFound() {
  return {
    title: "পেজটি পাওয়া যায়নি",
    description: "",
    noindex: true,
    css: BASE_CSS,
    main: '<div class="pb-root"><section class="pb pb-404"><div class="pb-in"><div class="code">৪০৪</div><h1>দুঃখিত, এই পেজটি পাওয়া যায়নি</h1>' +
      '<p>লিংকটি ভুল হতে পারে, অথবা পেজটি সরিয়ে নেওয়া হয়েছে।</p><div class="pb-btns"><a href="/" class="btn btn-gold">হোমপেজে যান</a><a href="/#contact" class="btn btn-outline">যোগাযোগ করুন</a></div></div></section></div>',
  };
}

/* ------------------------------------------------------------------ patterns (ready-made sections) and page templates — always built with fresh ids */
function mk(type, content = {}, style = {}, children) {
  const b = { id: newBlockId(), type, content: cleanFields(BLOCKS[type].fields, content, type), style: cleanStyle(style), adv: {} };
  if (CONTAINERS.includes(type)) b.children = children || (type === "columns" ? RATIOS[b.content.ratio].map(() => mk("column")) : []);
  return b;
}
const sec = (children, content = {}, style = {}) => mk("section", content, style, children);
const cols = (ratio, columns, content = {}) => mk("columns", { ratio, ...content }, {}, columns.map((kids) => mk("column", {}, {}, kids)));
const H = (text, level = "h2", eyebrow = "", style = {}) => mk("heading", { text, level, eyebrow }, style);
const P = (html, style = {}) => mk("text", { html }, style);
const CENTER = { align: "center" };
export const PATTERNS = {
  "page-header": { label: "পেজ হেডার", desc: "ব্রেডক্রাম্ব, শিরোনাম ও ভূমিকা", build: (t = "পেজের শিরোনাম") => [sec([mk("breadcrumb"), H(t, "h1"), P("<p>এই পেজে কী আছে তা এক-দুই লাইনে লিখুন।</p>", { size: 18, color: "muted", maxw: 720 })], { width: "normal", gap: 12 }, { bgType: "color", bgColor: "cream2", pt: 56, pb: 48, m: { pt: 36, pb: 32 } })] },
  hero: { label: "হিরো ব্যানার", desc: "বড় শিরোনাম ও বাটন", build: () => [mk("hero", { eyebrow: "WebDesigner71", heading: "আপনার ব্যবসার জন্য [[সুন্দর]] ওয়েবসাইট", sub: "এক লাইনে আপনার প্রস্তাব — কেন আপনাকেই বেছে নেবে।", buttons: [{ label: "যোগাযোগ করুন", href: "/#contact", variant: "gold" }, { label: "আরও জানুন", href: "#more", variant: "ghost" }] })] },
  features: { label: "ফিচার কার্ড", desc: "শিরোনাম ও ৩টি কার্ড", build: () => [sec([H("কেন আমরা?", "h2", "আমাদের বৈশিষ্ট্য", CENTER), P("<p>আপনার গ্রাহককে তিনটি কারণ দেখান।</p>", { align: "center", color: "muted", maxw: 640, boxAlign: "center" }),
    mk("cards", { cols: 3, items: [{ icon: "bolt", title: "দ্রুত ডেলিভারি", text: "৩–৭ দিনের মধ্যে আপনার সাইট লাইভ।" }, { icon: "layout", title: "মোবাইল ফ্রেন্ডলি", text: "সব স্ক্রিনে সুন্দর দেখায়।" }, { icon: "chat", title: "সাপোর্ট", text: "কাজ শেষেও আমরা পাশে আছি।" }] })])] },
  "about-split": { label: "ছবি ও লেখা", desc: "বামে ছবি, ডানে লেখা", build: () => [sec([cols("1-1", [[mk("image", { src: "/assets/hero-illustration.svg", alt: "আমাদের টিম", radius: 18 })],
    [H("আমাদের গল্প", "h2", "আমাদের সম্পর্কে"), P("<p>আমরা ছোট ও মাঝারি ব্যবসার জন্য সহজ, দ্রুত ও সুন্দর ওয়েবসাইট বানাই।</p><p>আমাদের লক্ষ্য — প্রতিটি ব্যবসাকে অনলাইনে নিয়ে আসা।</p>"),
      mk("list", { items: [{ text: "৫০০+ সন্তুষ্ট গ্রাহক" }, { text: "বাংলায় সাপোর্ট" }, { text: "সাশ্রয়ী মূল্য" }] })]], { valign: "center", gap: 48 })])] },
  stats: { label: "সংখ্যায় আমরা", desc: "৪টি বড় সংখ্যা", build: () => [sec([cols("1-1-1-1", [["৫০০+", "সন্তুষ্ট গ্রাহক"], ["৭ দিন", "গড় ডেলিভারি"], ["২৪/৭", "সাপোর্ট"], ["৫★", "রেটিং"]].map(([n, l]) => [H(n, "h3", "", { align: "center", size: 40, color: "accent", m: { size: 32 } }), P("<p>" + l + "</p>", { align: "center", mt: -8 })]), { stack: "never", gap: 16 })], {}, { bgType: "color", bgColor: "primary", color: "white", pt: 48, pb: 48 })] },
  services: { label: "সেবা ও মূল্য", desc: "সেবার টেবিল", build: () => [sec([H("সেবা ও মূল্য", "h2", "প্যাকেজ"), mk("table", { rows: [["সেবা", "কী থাকছে", "মূল্য"], ["ল্যান্ডিং পেজ", "১ পেজ, মোবাইল ফ্রেন্ডলি", "৳৩,৯০০"], ["বিজনেস ওয়েবসাইট", "৫ পেজ, ডোমেইন ও হোস্টিং", "৳১২,০০০"], ["ই-কমার্স", "পণ্য, অর্ডার ও পেমেন্ট", "৳২৫,০০০"]], header: true, striped: true })], { width: "narrow" })] },
  testimonials: { label: "গ্রাহকের মতামত", desc: "২টি রিভিউ", build: () => [sec([H("গ্রাহকরা যা বলেন", "h2", "রিভিউ", CENTER), mk("testimonial", { cols: 2, items: [{ quote: "অসাধারণ কাজ, সময়মতো ডেলিভারি।", name: "রহিম উদ্দিন", role: "ব্যবসায়ী", rating: 5 }, { quote: "খুবই পেশাদার ও আন্তরিক টিম।", name: "সাবরিনা আক্তার", role: "উদ্যোক্তা", rating: 5 }] })], {}, { bgType: "color", bgColor: "cream2" })] },
  faq: { label: "প্রশ্নোত্তর", desc: "শিরোনাম ও FAQ", build: () => [sec([H("সাধারণ প্রশ্ন", "h2", "FAQ", CENTER), mk("faq", { openFirst: true, items: [{ q: "কাজ শেষ হতে কত দিন লাগে?", a: "সাধারণত **৩–৭ দিন**।" }, { q: "পেমেন্ট কীভাবে করব?", a: "বিকাশ, নগদ বা ব্যাংক ট্রান্সফারে।" }, { q: "পরে কিছু বদলানো যাবে?", a: "হ্যাঁ, অ্যাডমিন প্যানেল থেকে নিজেই বদলাতে পারবেন।" }] })], { width: "narrow" })] },
  cta: { label: "কল-টু-অ্যাকশন", desc: "রঙিন ব্যানার ও বাটন", build: () => [mk("cta", { eyebrow: "আর দেরি নয়", heading: "আজই শুরু করুন [[আপনার ওয়েবসাইট]]", text: "ফ্রি পরামর্শের জন্য এখনই মেসেজ দিন।", buttons: [{ label: "মেসেজ দিন", href: "/#contact", variant: "gold" }] })] },
  contact: { label: "যোগাযোগ", desc: "যোগাযোগের তথ্য ও লেখা", build: () => [sec([cols("1-1", [[H("চলুন কথা বলি", "h2", "যোগাযোগ"), P("<p>প্রশ্ন, পরামর্শ বা অর্ডার — যেকোনো প্রয়োজনে যোগাযোগ করুন। সাধারণত ১ ঘণ্টার মধ্যে উত্তর দিই।</p>"), mk("buttons", { buttons: [{ label: "হোমপেজের ফর্ম", href: "/#contact", variant: "gold" }] })],
    [mk("contact", { title: "যোগাযোগের তথ্য", hours: "শনি–বৃহস্পতি, সকাল ১০টা – রাত ৮টা" }, { bgType: "color", bgColor: "white", pt: 28, pr: 28, pb: 28, pl: 28, radius: 18, shadow: "md" })]], { gap: 40 })])] },
};
export const TEMPLATES = {
  blank: { label: "খালি পেজ", desc: "শূন্য থেকে শুরু করুন", build: () => [] },
  about: { label: "আমাদের সম্পর্কে", desc: "গল্প, সংখ্যা, রিভিউ ও CTA", build: (t) => [...PATTERNS["page-header"].build(t || "আমাদের সম্পর্কে"), ...PATTERNS["about-split"].build(), ...PATTERNS.stats.build(), ...PATTERNS.testimonials.build(), ...PATTERNS.cta.build()] },
  services: { label: "সেবাসমূহ", desc: "ফিচার, মূল্য, FAQ ও CTA", build: (t) => [...PATTERNS["page-header"].build(t || "আমাদের সেবা"), ...PATTERNS.features.build(), ...PATTERNS.services.build(), ...PATTERNS.faq.build(), ...PATTERNS.cta.build()] },
  contact: { label: "যোগাযোগ", desc: "যোগাযোগের তথ্য ও FAQ", build: (t) => [...PATTERNS["page-header"].build(t || "যোগাযোগ"), ...PATTERNS.contact.build(), ...PATTERNS.faq.build()] },
};

/* ------------------------------------------------------------------ KV documents */
/** The small per-page summary kept in pages:index (the list screen and sitemap read only this). */
export function indexEntry(doc) {
  return { id: doc.id, title: doc.title, slug: doc.slug, status: doc.status, publishedSlug: doc.publishedSlug || "", changed: doc.status === "published" && doc.version !== doc.publishedVersion,
    blocks: countBlocks(doc.blocks), noindex: !!(doc.seo && doc.seo.noindex), updatedAt: doc.updatedAt, publishedAt: doc.publishedAt || null, version: doc.version,
    media: [...mediaRefs([doc.seo, doc.blocks])] }; // Phase 4: media library "used by"
}
/** The published snapshot stored at pub:<slug> (what the site renders). */
export function publishedSnapshot(doc, now) {
  return { schema: PAGE_SCHEMA, id: doc.id, slug: doc.slug, title: doc.title, seo: doc.seo, blocks: doc.blocks, version: doc.version, publishedAt: now };
}
