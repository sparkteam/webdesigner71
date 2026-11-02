/**
 * WebDesigner71 CMS — shared homepage model & renderer (Phase 2).
 *
 * ONE module used by three places (keep it dependency-free, no secrets — it is served publicly):
 *   • site-worker/src/index.js   imports it (bundled) and turns a "plan" into HTMLRewriter edits
 *   • public/admin/index.html    loads it with import("/cms/model.js") for the editors + live preview
 *   • admin-worker/src/cms-model.js is a byte-identical copy (the admin Worker is deployed on its own);
 *     site-worker/test/check.mjs fails if the two copies differ.
 *
 * Data model (KV CONTENT):
 *   "content:homepage:v2"  { schema:2, sections:[ Section ], updatedAt }
 *   Section = { id, hidden, fields:{ <key>: FieldValue }, extra:[ Element ], version, updatedAt, updatedBy }
 *   "settings:site"        { siteTitle, metaDescription, accentColor, primaryColor, contactPhone, contactEmail,
 *                            contactAddress, version, updatedAt, updatedBy }
 * Every field maps to an element in public/index.html marked data-cms="<section>.<key>"; a section root is
 * marked data-cms-section="<section>"; new elements go into data-cms-slot="<section>".
 *
 * Rendering rule that keeps the live page byte-identical: a field whose clean value equals DEFAULTS (the text
 * that is already in index.html) produces NO edit. Only changed fields are re-rendered. All text is escaped,
 * links must be http(s)/mailto/tel/#/relative, images must be /media/<key> or /assets/<file>.
 */

export const SCHEMA = 2;
export const KEYS = {
  doc: "content:homepage:v2",
  prev: (id) => "content:homepage:v2:prev:" + id,
  settings: "settings:site",
  settingsPrev: "settings:site:prev",
  v1: "content:homepage", // Phase 1 (hero only) — read as a fallback/migration source, never written by Phase 2
};
export const BUTTON_STYLES = ["gold", "green", "ghost", "outline"];
export const BUTTON_STYLE_LABELS = { gold: "সোনালি", green: "সবুজ", ghost: "স্বচ্ছ (গাঢ় ব্যাকগ্রাউন্ডে)", outline: "বর্ডার" };
export const EXTRA_TYPES = ["heading", "text", "image", "button"];
export const EXTRA_LABELS = { heading: "শিরোনাম", text: "প্যারাগ্রাফ", image: "ছবি", button: "বাটন" };
export const DEFAULT_ACCENT = "#D4A017";
export const DEFAULT_ACCENT_LIGHT = "#E9B930";
export const DEFAULT_PRIMARY = "#0B3D2E";
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const MEDIA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const MEDIA_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const BUILTIN_MEDIA = [
  { key: "builtin:hero-illustration", url: "/assets/hero-illustration.svg", alt: "একটি আধুনিক ওয়েবসাইট হোমপেজের অ্যানোটেটেড ডিজাইন", builtin: true, usedIn: "hero.image" },
];
const MAX = { buttons: 6, links: 8, list: 12, cards: 12, features: 15, extra: 12, href: 500, alt: 150, label: 60 };

/* ------------------------------------------------------------------ helpers */
export class CmsError extends Error {
  constructor(field, msg) { super(msg || "invalid_field"); this.field = field; }
}
export const bnNum = (n) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);
const len = (s) => [...s].length;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function str(v, path, min, max) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new CmsError(path);
  const t = v.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new CmsError(path);
  const n = len(t);
  if (n < min || n > max) throw new CmsError(path);
  return t;
}
const bool = (v) => v === true;
/** Allowed link targets: http(s)://, mailto:, tel:, #anchor, or a relative path (no scheme, no "//"). */
export function safeHref(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || len(s) > MAX.href || /[\s<>"'`\\\u0000-\u001f]/.test(s)) return null;
  if (/^https?:\/\/[^/?#]+/i.test(s)) return s;
  if (/^mailto:[^@]+@[^@]+$/i.test(s)) return s;
  if (/^tel:\+?[0-9()\-.]{3,30}$/i.test(s)) return s;
  if (/^#[A-Za-z0-9_\-]*$/.test(s)) return s;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s) || s.startsWith("//")) return null;
  if (/^[A-Za-z0-9_\-./?=&%~+]+$/.test(s)) return s;
  return null;
}
/** Allowed image sources: /media/<key> (uploads) or /assets/<file> (files shipped in the repo). */
export function safeImg(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s)) return s;
  if (/^\/assets\/[A-Za-z0-9][A-Za-z0-9_\-/]{0,100}\.(?:svg|png|jpe?g|webp|gif)$/.test(s) && !s.includes("..")) return s;
  return null;
}
function href(v, path, required) {
  if ((v === undefined || v === null || v === "") && !required) return "";
  const h = safeHref(v);
  if (h === null) throw new CmsError(path);
  return h;
}
function img(v, path, required) {
  if ((v === undefined || v === null || v === "") && !required) return "";
  const s = safeImg(v);
  if (s === null) throw new CmsError(path);
  return s;
}
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
function items(v, path, max, one) {
  if (v === undefined) v = [];
  if (!Array.isArray(v) || v.length > max) throw new CmsError(path);
  const seen = new Set();
  return v.map((it, i) => {
    if (!isObj(it)) throw new CmsError(path + "." + i);
    const id = typeof it.id === "string" && ID_RE.test(it.id) && !seen.has(it.id) ? it.id : null;
    if (!id) throw new CmsError(path + "." + i + ".id");
    seen.add(id);
    return { id, ...one(it, path + "." + i), hidden: bool(it.hidden) };
  });
}
export function newId() { return "n" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); }

/* ------------------------------------------------------------------ schema */
// Field types: text | heroTitle | image | buttons | links | list | cards | link
const txt = (key, label, max, o = {}) => ({ key, type: "text", label, max, min: o.min || 0, rich: !!o.rich, hl: o.hl || "span", long: !!o.long, hideable: o.hideable !== false, hint: o.hint });
const CARD_KINDS = {
  pain: [
    { k: "icon", t: "s", label: "আইকন (ইমোজি)", max: 8 },
    { k: "title", t: "s", label: "শিরোনাম", max: 120, min: 1 },
    { k: "text", t: "s", label: "লেখা", max: 300, long: true },
  ],
  package: [
    { k: "popular", t: "b", label: "জনপ্রিয় হিসেবে হাইলাইট" },
    { k: "tag", t: "s", label: "ট্যাগ (যেমন: সবচেয়ে জনপ্রিয়)", max: 40 },
    { k: "name", t: "s", label: "প্যাকেজের নাম", max: 60, min: 1 },
    { k: "for", t: "s", label: "সংক্ষিপ্ত বিবরণ", max: 120 },
    { k: "price", t: "s", label: "দাম", max: 20, min: 1 },
    { k: "priceNote", t: "s", label: "দামের নোট", max: 30 },
    { k: "features", t: "list", label: "ফিচার", max: 120 },
    { k: "buttonLabel", t: "s", label: "বাটনের লেখা", max: 40 },
    { k: "buttonHref", t: "href", label: "বাটনের লিংক" },
    { k: "buttonStyle", t: "style", label: "বাটনের স্টাইল" },
  ],
  work: [
    { k: "theme", t: "n", label: "রঙের থিম", options: [1, 2, 3] },
    { k: "initial", t: "s", label: "লোগো অক্ষর", max: 4 },
    { k: "image", t: "img", label: "ছবি (ঐচ্ছিক)" },
    { k: "imageAlt", t: "s", label: "ছবির বিবরণ (alt)", max: MAX.alt },
    { k: "title", t: "s", label: "প্রজেক্টের নাম", max: 120, min: 1 },
    { k: "text", t: "s", label: "ধরন", max: 160 },
    { k: "buttonLabel", t: "s", label: "বাটনের লেখা", max: 40 },
    { k: "buttonHref", t: "href", label: "প্রজেক্টের লিংক" },
  ],
  step: [
    { k: "title", t: "s", label: "ধাপের নাম", max: 80, min: 1 },
    { k: "text", t: "s", label: "লেখা", max: 240, long: true },
  ],
  faq: [
    { k: "q", t: "s", label: "প্রশ্ন", max: 200, min: 1 },
    { k: "a", t: "s", label: "উত্তর", max: 800, min: 1, long: true, rich: true },
  ],
};
export { CARD_KINDS };

export const SECTIONS = [
  { id: "header", label: "হেডার ও মেনু", icon: "☰", slot: false, fields: [
    txt("logo", "লোগো", 40, { min: 1, rich: true, hideable: false, hint: "[[ ]] দিয়ে ঘেরা অংশ সোনালি হবে" }),
    { key: "nav", type: "links", label: "মেনু লিংক", max: MAX.links },
    { key: "cta", type: "buttons", label: "হেডারের বাটন", mode: "replace", max: 2 },
  ] },
  { id: "hero", label: "হিরো", icon: "★", slot: true, align: "start", fields: [
    txt("badge", "ব্যাজ", 60),
    { key: "title", type: "heroTitle", label: "শিরোনাম" },
    txt("sub", "সাব-টেক্সট", 300, { long: true }),
    { key: "buttons", type: "buttons", label: "বাটন", mode: "inner", max: MAX.buttons },
    { key: "trust", type: "list", label: "ভরসার পয়েন্ট", max: MAX.list, itemMax: 80 },
    { key: "image", type: "image", label: "হিরো ছবি", hint: "খালি রাখলে মূল ইলাস্ট্রেশন দেখাবে" },
  ] },
  { id: "problem", label: "সমস্যা ও সমাধান", icon: "?", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false }),
    { key: "pains", type: "cards", card: "pain", label: "সমস্যার কার্ড", max: MAX.cards, itemLabel: "কার্ড" },
    txt("solutionTitle", "সমাধানের শিরোনাম", 160, { rich: true, hint: "[[ ]] দিয়ে ঘেরা অংশ সোনালি হবে" }),
    txt("solutionText", "সমাধানের লেখা", 300, { long: true }),
    { key: "solutionButtons", type: "buttons", label: "সমাধানের বাটন", mode: "replace", max: 3 },
  ] },
  { id: "packages", label: "প্যাকেজ ও দাম", icon: "৳", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false }),
    txt("sub", "সাব-টেক্সট", 300, { long: true }),
    { key: "cards", type: "cards", card: "package", label: "প্যাকেজ", max: 6, itemLabel: "প্যাকেজ" },
    txt("note", "নিচের নোট", 300, { long: true }),
  ] },
  { id: "work", label: "কাজের নমুনা", icon: "▦", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false }),
    txt("sub", "সাব-টেক্সট", 300, { long: true }),
    { key: "items", type: "cards", card: "work", label: "প্রজেক্ট", max: MAX.cards, itemLabel: "প্রজেক্ট" },
  ] },
  { id: "how", label: "কীভাবে কাজ করি", icon: "➜", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false }),
    { key: "steps", type: "cards", card: "step", label: "ধাপ", max: 8, itemLabel: "ধাপ" },
  ] },
  { id: "faq", label: "প্রশ্নোত্তর", icon: "❔", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false }),
    { key: "items", type: "cards", card: "faq", label: "প্রশ্ন", max: 20, itemLabel: "প্রশ্ন" },
  ] },
  { id: "contact", label: "কল-টু-অ্যাকশন", icon: "✉", slot: true, align: "center", fields: [
    txt("eyebrow", "ছোট শিরোনাম", 80),
    txt("title", "শিরোনাম", 160, { min: 1, rich: true, hideable: false, hint: "[[ ]] দিয়ে ঘেরা অংশ সোনালি হবে" }),
    txt("lead", "লেখা", 300, { long: true }),
    { key: "primary", type: "buttons", label: "প্রধান বাটন", mode: "replace", max: 2, extraClass: "btn-xl" },
    { key: "buttons", type: "buttons", label: "যোগাযোগের বাটন", mode: "inner", max: MAX.buttons },
    txt("smallPrint", "ছোট লেখা", 200),
  ] },
  { id: "footer", label: "ফুটার", icon: "▁", slot: false, fields: [
    txt("logo", "লোগো", 40, { min: 1, rich: true, hideable: false, hint: "[[ ]] দিয়ে ঘেরা অংশ সোনালি হবে" }),
    txt("copyright", "কপিরাইট লেখা", 200),
    { key: "fab", type: "link", label: "ভাসমান মেসেঞ্জার বাটন" },
  ] },
];
export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const sectionDef = (id) => SECTIONS.find((s) => s.id === id) || null;

/* ------------------------------------------------------------------ defaults (= what public/index.html shows) */
const B = (id, label, href, style, newTab) => ({ id, label, href, style, newTab: !!newTab, hidden: false });
const L = (id, text) => ({ id, text, hidden: false });
const t = (text) => ({ text, hidden: false });
const RAW_DEFAULTS = {
  header: {
    logo: t("WebDesigner[[71]]"),
    nav: { items: [
      { id: "n1", label: "প্যাকেজ", href: "#packages" }, { id: "n2", label: "কাজের নমুনা", href: "#work" },
      { id: "n3", label: "কীভাবে কাজ করি", href: "#how" }, { id: "n4", label: "প্রশ্নোত্তর", href: "#faq" },
    ] },
    cta: { items: [B("b1", "মেসেজ করুন", "#contact", "gold")] },
  },
  hero: {
    badge: t("ফ্রি ডোমেইন ও হোস্টিং"),
    title: { text: "আপনার ব্যবসার ওয়েবসাইট, মাত্র", highlight: "৩৯০০ টাকায়" },
    sub: t("ডোমেইন, হোস্টিং, ডিজাইন — সব এক প্যাকেজে"),
    buttons: { items: [B("b1", "অফার নিন →", "#packages", "gold"), B("b2", "কাজের নমুনা দেখুন", "#work", "ghost")] },
    trust: { items: [L("t1", "ই-কমার্স ও বিজনেস ওয়েবসাইট"), L("t2", "মোবাইল-ফ্রেন্ডলি ডিজাইন"), L("t3", "ডোমেইন আপনার নামে")] },
    image: { src: "", alt: "", hidden: false },
  },
  problem: {
    eyebrow: t("সমস্যাটা চেনা চেনা লাগছে?"),
    title: t("ব্যবসা আছে, কিন্তু অনলাইনে আপনি কোথায়?"),
    pains: { items: [
      { id: "p1", icon: "🏪", title: "দোকান আছে, অনলাইনে কেউ খুঁজে পাচ্ছে না", text: "গুগলে আপনার ব্যবসার নাম লিখলে কিছুই আসে না, আর কাস্টমার চলে যায় অন্যের কাছে।" },
      { id: "p2", icon: "📱", title: "ফেসবুকে পোস্ট করলেই বিক্রি, নিজের ঠিকানা নেই", text: "পেজ বন্ধ হলে বা রিচ কমলে সব শেষ। নিজের একটা স্থায়ী অনলাইন ঠিকানা দরকার।" },
      { id: "p3", icon: "🤝", title: "কাস্টমার ভরসা পায় না", text: "নিজের ওয়েবসাইট না থাকলে নতুন কাস্টমার বুঝতেই পারে না আপনি কতটা সিরিয়াস ব্যবসায়ী।" },
    ] },
    solutionTitle: t("সমাধান: [[এক প্যাকেজেই]] আপনার পুরো অনলাইন উপস্থিতি"),
    solutionText: t("ডিজাইন, ডোমেইন, হোস্টিং — সব আমরা সেটআপ করে দিই। আপনি শুধু ব্যবসায় মন দিন।"),
    solutionButtons: { items: [B("b1", "প্যাকেজ দেখুন", "#packages", "gold")] },
  },
  packages: {
    eyebrow: t("সহজ ও স্বচ্ছ দাম"),
    title: t("আপনার জন্য সঠিক প্যাকেজ বেছে নিন"),
    sub: t("কোনো লুকানো খরচ নেই। ই-কমার্স বা বিজনেস — দুই ধরনের ওয়েবসাইটই পাবেন।"),
    cards: { items: [
      { id: "c1", popular: true, tag: "সবচেয়ে জনপ্রিয়", name: "স্ট্যান্ডার্ড", for: "বিজনেস ওয়েবসাইট + ফ্রি ডোমেইন ও হোস্টিং", price: "৳৩৯০০", priceNote: "/ এককালীন",
        features: { items: [L("f1", "প্রফেশনাল ওয়েবসাইট ডিজাইন"), L("f2", "মোবাইল-ফ্রেন্ডলি লেআউট"), L("f3", "ফ্রি ডোমেইন (আপনার নামে)"), L("f4", "ফ্রি হোস্টিং")] },
        buttonLabel: "স্ট্যান্ডার্ড নিন", buttonHref: "#contact", buttonStyle: "gold" },
      { id: "c2", popular: false, tag: "", name: "প্রিমিয়াম", for: "ই-কমার্স ওয়েবসাইট + অনলাইন বিক্রি", price: "৳৪৯০০", priceNote: "/ এককালীন",
        features: { items: [
          L("f1", "প্রফেশনাল ওয়েবসাইট ডিজাইন"), L("f2", "মোবাইল-ফ্রেন্ডলি লেআউট"), L("f3", "ফ্রি ডোমেইন (আপনার নামে)"), L("f4", "ফ্রি হোস্টিং"),
          L("f5", "অনলাইন শপ ও পণ্য ক্যাটালগ"), L("f6", "কার্ট ও অর্ডার সিস্টেম"), L("f7", "bKash / Nagad / ক্যাশ অন ডেলিভারি"),
          L("f8", "WhatsApp-এ অর্ডার নোটিফিকেশন"), L("f9", "পণ্য ক্যাটাগরি ও সার্চ"), L("f10", "সোশ্যাল মিডিয়া সেটআপ"), L("f11", "১ মাস ফ্রি সাহায্য ও সাপোর্ট"),
        ] },
        buttonLabel: "ই-কমার্স নিন", buttonHref: "#contact", buttonStyle: "green" },
    ] },
    note: t("* সাপোর্ট ১ মাসের জন্য, আজীবন নয়। ফ্রি ডোমেইন ও হোস্টিং প্রথম বছরের জন্য।"),
  },
  work: {
    eyebrow: t("আমাদের কাজ"),
    title: t("কাজের নমুনা"),
    sub: t("বিভিন্ন ধরনের বাংলাদেশি ব্যবসার জন্য তৈরি ওয়েবসাইট।"),
    items: { items: [
      { id: "w1", theme: 1, initial: "D", image: "", imageAlt: "", title: "DTex BD — হোম টেক্সটাইল", text: "ই-কমার্স ওয়েবসাইট", buttonLabel: "দেখুন", buttonHref: "#" },
      { id: "w2", theme: 2, initial: "ঘ", image: "", imageAlt: "", title: "ঘরোয়া খাবার — হোম কিচেন", text: "অর্ডার ও মেনু ওয়েবসাইট", buttonLabel: "দেখুন", buttonHref: "#" },
      { id: "w3", theme: 3, initial: "R", image: "", imageAlt: "", title: "Rangdhanu Fashion — বুটিক", text: "বিজনেস ওয়েবসাইট", buttonLabel: "দেখুন", buttonHref: "#" },
    ] },
  },
  how: {
    eyebrow: t("সহজ ৪ ধাপ"),
    title: t("কীভাবে কাজ করি"),
    steps: { items: [
      { id: "s1", title: "অফার নিন", text: "পছন্দের প্যাকেজ বেছে নিয়ে আমাদের মেসেজ করুন।" },
      { id: "s2", title: "ব্যবসার কথা বলো", text: "আপনার ব্যবসা, পণ্য আর পছন্দের কথা জানান।" },
      { id: "s3", title: "ডিজাইন করে দিচ্ছি", text: "আমরা ওয়েবসাইট বানাই, আপনি দেখে মতামত দেন।" },
      { id: "s4", title: "লাইভ", text: "আপনার ওয়েবসাইট অনলাইনে চালু, সবাই খুঁজে পাবে।" },
    ] },
  },
  faq: {
    eyebrow: t("প্রশ্নোত্তর"),
    title: t("সাধারণ কিছু প্রশ্ন"),
    items: { items: [
      { id: "q1", q: "দাম কত?", a: "স্ট্যান্ডার্ড প্যাকেজ **৳৩৯০০** — ওয়েবসাইট, ফ্রি ডোমেইন ও ফ্রি হোস্টিং সহ। প্রিমিয়াম প্যাকেজ **৳৪৯০০** — এর সাথে সোশ্যাল মিডিয়া সেটআপ আর ১ মাসের সাপোর্ট। এটা এককালীন খরচ।" },
      { id: "q2", q: "কতদিনে ওয়েবসাইট পাব?", a: "সাধারণত **৫–৭ কর্মদিবসের** মধ্যে। আপনার কাছ থেকে প্রয়োজনীয় তথ্য (লোগো, পণ্যের ছবি, লেখা) পাওয়ার পর থেকে সময় গোনা শুরু হয়।" },
      { id: "q3", q: "ডোমেইন ও হোস্টিং কি সত্যিই ফ্রি?", a: "হ্যাঁ, স্ট্যান্ডার্ড ও প্রিমিয়াম প্যাকেজে **প্রথম বছরের** ডোমেইন ও হোস্টিং সম্পূর্ণ ফ্রি। পরের বছর থেকে নবায়ন ফি দিতে হবে, যা আমরা আগেই আপনাকে জানিয়ে দেব।" },
      { id: "q4", q: "কীভাবে পেমেন্ট করব?", a: "বিকাশ, নগদ, রকেট অথবা ব্যাংক ট্রান্সফারে পেমেন্ট করতে পারবেন। বিস্তারিত মেসেজে জানিয়ে দেব।" },
      { id: "q5", q: "ওয়েবসাইট কি আমার নিজের নামে থাকবে?", a: "**হ্যাঁ, অবশ্যই।** ডোমেইন রেজিস্টার হবে **আপনার নিজের নামে**, আর ওয়েবসাইট ও ডোমেইনের পূর্ণ মালিকানা থাকবে আপনার। আমরা শুধু সেটআপ করে দিই — এটা সম্পূর্ণ আপনার সম্পদ।" },
      { id: "q6", q: "১ মাস পরে সাপোর্ট পাব কি?", a: "প্রিমিয়াম প্যাকেজে **প্রথম ১ মাস** সাহায্য ও সাপোর্ট ফ্রি। এরপর কোনো পরিবর্তন বা সাপোর্ট লাগলে সাশ্রয়ী খরচে পেইড সাপোর্ট নিতে পারবেন। সাপোর্ট আজীবন ফ্রি নয়।" },
    ] },
  },
  contact: {
    eyebrow: t("আর দেরি নয়"),
    title: t("আজই আপনার ব্যবসাকে [[অনলাইনে]] আনুন"),
    lead: t("একটা মেসেজই যথেষ্ট। আপনার ব্যবসার কথা জানান, বাকিটা আমরা দেখছি।"),
    primary: { items: [B("b1", "💬 এখনই মেসেজ করুন", "https://m.me/YOUR_PAGE", "gold", true)] },
    buttons: { items: [B("b1", "ফেসবুক পেজ", "https://facebook.com/YOUR_PAGE", "ghost", true), B("b2", "হোয়াটসঅ্যাপ: +880 1XXX-XXXXXX", "https://wa.me/8801XXXXXXXXX", "ghost", true)] },
    smallPrint: t("সাধারণত কয়েক ঘণ্টার মধ্যে উত্তর দিই।"),
  },
  footer: {
    logo: t("WebDesigner[[71]]"),
    copyright: t("© ২০২৬ WebDesigner71 · বাংলাদেশি উদ্যোক্তাদের জন্য ওয়েবসাইট"),
    fab: { href: "https://m.me/YOUR_PAGE", label: "মেসেঞ্জারে মেসেজ করুন", hidden: false },
  },
};
export const DEFAULT_SETTINGS_RAW = {
  siteTitle: "মাত্র ৳৩৯০০-তে আপনার ব্যবসার ওয়েবসাইট | WebDesigner71",
  metaDescription: "বাংলাদেশি উদ্যোক্তাদের জন্য ই-কমার্স ও বিজনেস ওয়েবসাইট — ফ্রি ডোমেইন ও হোস্টিং সহ মাত্র ৳৩৯০০। সোশ্যাল মিডিয়া সেটআপ ও ১ মাস সাপোর্ট সহ প্রিমিয়াম ৳৪৯০০।",
  accentColor: DEFAULT_ACCENT,
  primaryColor: DEFAULT_PRIMARY,
  contactPhone: "",
  contactEmail: "",
  contactAddress: "",
};

/* ------------------------------------------------------------------ cleaning / validation */
function cleanCardItem(kind, it, path) {
  const out = {};
  for (const f of CARD_KINDS[kind]) {
    const p = path + "." + f.k, v = it[f.k];
    if (f.t === "s") out[f.k] = str(v, p, f.min || 0, f.max);
    else if (f.t === "b") out[f.k] = bool(v);
    else if (f.t === "href") out[f.k] = href(v, p, false);
    else if (f.t === "img") out[f.k] = img(v, p, false);
    else if (f.t === "style") { if (v !== undefined && !BUTTON_STYLES.includes(v)) throw new CmsError(p); out[f.k] = v || "gold"; }
    else if (f.t === "n") { const n = v === undefined ? f.options[0] : v; if (!f.options.includes(n)) throw new CmsError(p); out[f.k] = n; }
    else if (f.t === "list") {
      const raw = isObj(v) ? v.items : v;
      out[f.k] = { items: items(raw, p + ".items", MAX.features, (x, pp) => ({ text: str(x.text, pp + ".text", 1, f.max) })) };
    }
  }
  if (out.buttonLabel !== undefined && out.buttonLabel && !out.buttonHref) throw new CmsError(path + ".buttonHref");
  return out;
}
function cleanButton(b, p) {
  if (b.style !== undefined && !BUTTON_STYLES.includes(b.style)) throw new CmsError(p + ".style");
  return { label: str(b.label, p + ".label", 1, MAX.label), href: href(b.href, p + ".href", true), style: b.style || "gold", newTab: bool(b.newTab) };
}
function cleanField(def, v, path) {
  if (v === undefined) v = {};
  if (!isObj(v)) throw new CmsError(path);
  switch (def.type) {
    case "text": return { text: str(v.text, path + ".text", def.min, def.max), hidden: def.hideable ? bool(v.hidden) : false };
    case "heroTitle": return { text: str(v.text, path + ".text", 1, 120), highlight: str(v.highlight, path + ".highlight", 0, 40) };
    case "image": return { src: img(v.src, path + ".src", false), alt: str(v.alt, path + ".alt", 0, MAX.alt), hidden: bool(v.hidden) };
    case "link": return { href: href(v.href, path + ".href", true), label: str(v.label, path + ".label", 1, MAX.label), hidden: bool(v.hidden) };
    case "buttons": return { items: items(v.items, path + ".items", def.max, cleanButton) };
    case "links": return { items: items(v.items, path + ".items", def.max, (x, p) => ({ label: str(x.label, p + ".label", 1, MAX.label), href: href(x.href, p + ".href", true) })) };
    case "list": return { items: items(v.items, path + ".items", def.max, (x, p) => ({ text: str(x.text, p + ".text", 1, def.itemMax || 120) })) };
    case "cards": return { items: items(v.items, path + ".items", def.max, (x, p) => cleanCardItem(def.card, x, p)) };
  }
  throw new CmsError(path);
}
function cleanExtra(list, path) {
  return items(list, path, MAX.extra, (e, p) => {
    if (!EXTRA_TYPES.includes(e.type)) throw new CmsError(p + ".type");
    if (e.type === "heading") return { type: "heading", text: str(e.text, p + ".text", 1, 160) };
    if (e.type === "text") return { type: "text", text: str(e.text, p + ".text", 1, 800) };
    if (e.type === "image") return { type: "image", src: img(e.src, p + ".src", true), alt: str(e.alt, p + ".alt", 0, MAX.alt) };
    return { type: "button", ...cleanButton(e, p) };
  });
}
/** Clean one section's editable content. Missing fields → defaults. Throws CmsError(field path) when invalid. */
export function cleanSection(id, raw) {
  const def = sectionDef(id);
  if (!def) throw new CmsError("section");
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new CmsError("section");
  const rf = raw.fields === undefined ? {} : raw.fields;
  if (!isObj(rf)) throw new CmsError("fields");
  const fields = {};
  for (const f of def.fields) fields[f.key] = cleanField(f, rf[f.key] === undefined ? RAW_DEFAULTS[id][f.key] : rf[f.key], f.key);
  const extra = def.slot ? cleanExtra(raw.extra, "extra") : [];
  if (!def.slot && Array.isArray(raw.extra) && raw.extra.length) throw new CmsError("extra");
  return { id, hidden: bool(raw.hidden), fields, extra };
}
export function cleanSettings(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new CmsError("settings");
  const v = (k) => (raw[k] === undefined ? DEFAULT_SETTINGS_RAW[k] : raw[k]);
  const color = (k) => { const c = v(k); if (typeof c !== "string" || !COLOR_RE.test(c)) throw new CmsError(k); return c.toUpperCase(); };
  const out = {
    siteTitle: str(v("siteTitle"), "siteTitle", 1, 120),
    metaDescription: str(v("metaDescription"), "metaDescription", 0, 300),
    accentColor: color("accentColor"),
    primaryColor: color("primaryColor"),
    contactPhone: str(v("contactPhone"), "contactPhone", 0, 40),
    contactEmail: str(v("contactEmail"), "contactEmail", 0, 120),
    contactAddress: str(v("contactAddress"), "contactAddress", 0, 160),
  };
  if (out.contactPhone && !/^\+?[0-9 ()\-.]{3,30}$/.test(out.contactPhone)) throw new CmsError("contactPhone");
  if (out.contactEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(out.contactEmail)) throw new CmsError("contactEmail");
  return out;
}
export const DEFAULTS = Object.fromEntries(SECTION_IDS.map((id) => [id, cleanSection(id, { fields: RAW_DEFAULTS[id] })]));
export const DEFAULT_SETTINGS = cleanSettings(DEFAULT_SETTINGS_RAW);

/** Clean a whole stored doc; unknown sections are dropped, missing ones get defaults. Throws on invalid data. */
export function cleanDoc(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA || !Array.isArray(doc.sections)) throw new CmsError("doc");
  const byId = {};
  for (const s of doc.sections) if (isObj(s) && SECTION_IDS.includes(s.id)) byId[s.id] = s;
  return {
    schema: SCHEMA,
    sections: SECTION_IDS.map((id) => {
      const s = byId[id];
      const c = cleanSection(id, s);
      return { ...c, version: s && Number.isInteger(s.version) ? s.version : 0, updatedAt: (s && s.updatedAt) || null, updatedBy: (s && s.updatedBy) || null };
    }),
  };
}
/** Phase 1 → v2: { heroTitle, heroHighlight, heroSub, accentColor } becomes hero.title/hero.sub + settings.accentColor. */
export function migrateV1(v1) {
  if (!isObj(v1)) throw new CmsError("v1");
  const hero = JSON.parse(JSON.stringify(RAW_DEFAULTS.hero));
  hero.title = { text: v1.heroTitle, highlight: v1.heroHighlight || "" };
  hero.sub = { text: v1.heroSub || "", hidden: false };
  const doc = cleanDoc({ schema: SCHEMA, sections: [{ id: "hero", fields: hero, version: 1, updatedAt: v1.updatedAt || null, updatedBy: v1.updatedBy || null }] });
  for (const s of doc.sections) if (s.id !== "hero") s.version = 1;
  const settings = cleanSettings({ ...DEFAULT_SETTINGS_RAW, accentColor: v1.accentColor });
  return { doc, settings };
}
export function seedDoc(by = "seed", at = new Date().toISOString()) {
  return { schema: SCHEMA, sections: SECTION_IDS.map((id) => ({ ...JSON.parse(JSON.stringify(DEFAULTS[id])), version: 1, updatedAt: at, updatedBy: by })), updatedAt: at };
}
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ node trees (safe by construction) */
const VOID = new Set(["img", "br"]);
const TAGS = new Set(["a", "span", "em", "strong", "small", "p", "h3", "div", "article", "ul", "li", "img", "i", "button", "figure"]);
const el = (t, a, ...c) => ({ t, a: a || {}, c: c.flat().filter((x) => x !== null && x !== undefined && x !== false) });
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Serialize a node tree to HTML (worker side). Strings are always escaped. */
export function toHtml(nodes) {
  let out = "";
  for (const n of [].concat(nodes)) {
    if (typeof n === "string") { out += escText(n); continue; }
    if (!TAGS.has(n.t)) continue;
    out += "<" + n.t;
    for (const [k, v] of Object.entries(n.a)) if (/^[a-z][a-z0-9-]*$/.test(k)) out += v === true ? " " + k : " " + k + '="' + escAttr(v) + '"';
    out += ">";
    if (VOID.has(n.t)) continue;
    out += toHtml(n.c) + "</" + n.t + ">";
  }
  return out;
}
/** Build DOM nodes from a node tree (preview side) — createElement/textContent only, never innerHTML. */
export function toDom(nodes, doc) {
  const frag = doc.createDocumentFragment();
  for (const n of [].concat(nodes)) {
    if (typeof n === "string") { frag.append(doc.createTextNode(n)); continue; }
    if (!TAGS.has(n.t)) continue;
    const e = doc.createElement(n.t);
    for (const [k, v] of Object.entries(n.a)) if (/^[a-z][a-z0-9-]*$/.test(k)) e.setAttribute(k, v === true ? "" : String(v));
    if (!VOID.has(n.t)) e.append(toDom(n.c, doc));
    frag.append(e);
  }
  return frag;
}
/** Inline text: **bold** → <strong>, [[x]] → highlight tag. Everything else is plain text. */
export function inline(text, rich, hl = "span") {
  if (!rich) return [text];
  const out = [];
  const re = /\*\*([^*]+?)\*\*|\[\[([^\]]+?)\]\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? el("strong", null, m[1]) : el(hl, null, m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const DELAY = ["", " d1", " d2", " d3"];
const nl = (arr) => arr.flatMap((x, i) => (i ? ["\n", x] : [x]));
function linkAttrs(b, cls) {
  const a = { href: b.href, class: cls };
  if (b.newTab) { a.target = "_blank"; a.rel = "noopener"; }
  return a;
}
const buttonNode = (b, extraClass) => el("a", linkAttrs(b, "btn btn-" + b.style + (extraClass ? " " + extraClass : "")), b.label);
const visible = (list) => list.filter((x) => !x.hidden);
const CARD_RENDER = {
  pain: (it, i) => el("article", { class: "pain reveal" + DELAY[i % 3] }, el("div", { class: "ic", "aria-hidden": "true" }, it.icon), el("h3", null, it.title), el("p", null, it.text)),
  package: (it, i) => el("article", { class: "card" + (it.popular ? " popular" : "") + " reveal" + DELAY[i % 3] },
    it.popular && it.tag ? el("span", { class: "pop-tag" }, it.tag) : null,
    el("h3", null, it.name), it.for ? el("p", { class: "for" }, it.for) : null,
    el("p", { class: "price" }, it.price, it.priceNote ? [" ", el("small", null, it.priceNote)] : null),
    el("ul", null, visible(it.features.items).map((f) => el("li", null, el("span", { class: "check", "aria-hidden": "true" }, "✓"), f.text))),
    it.buttonLabel ? el("a", { href: it.buttonHref, class: "btn btn-" + it.buttonStyle }, it.buttonLabel) : null),
  work: (it, i) => el("article", { class: "work reveal" + DELAY[i % 3] },
    el("div", { class: "work-thumb w" + it.theme, "aria-hidden": "true" },
      it.image ? el("img", { src: it.image, alt: it.imageAlt || "", loading: "lazy", style: "position:absolute;inset:0;width:100%;height:100%;object-fit:cover" }) : null,
      el("div", { class: "motif", style: "position:absolute;inset:0;opacity:.5" }),
      el("div", { class: "bar" }, el("i"), el("i"), el("i")),
      !it.image && it.initial ? el("span", { class: "initial" }, it.initial) : null),
    el("div", { class: "work-body" }, el("div", null, el("h3", null, it.title), it.text ? el("p", null, it.text) : null),
      it.buttonLabel ? el("a", { href: it.buttonHref || "#", class: "btn btn-outline" }, it.buttonLabel) : null)),
  step: (it, i) => el("li", { class: "step reveal" + DELAY[i % 4] }, el("div", { class: "num" }, bnNum(i + 1)), el("h3", null, it.title), it.text ? el("p", null, it.text) : null),
  faq: (it, i) => el("div", { class: "faq-item reveal" },
    el("button", { class: "faq-q", "aria-expanded": "false", "aria-controls": "fa" + (i + 1), id: "fq" + (i + 1) }, it.q, el("span", { class: "pm", "aria-hidden": "true" }, "+")),
    el("div", { class: "faq-a", id: "fa" + (i + 1), role: "region", "aria-labelledby": "fq" + (i + 1) }, el("div", null, el("p", null, inline(it.a, true))))),
};
const EXTRA_RENDER = {
  heading: (e) => el("h3", { style: "font-size:1.35rem;line-height:1.35;margin:0" }, inline(e.text, true)),
  text: (e) => el("p", { style: "margin:0" }, inline(e.text, true)),
  image: (e) => el("img", { src: e.src, alt: e.alt || "", loading: "lazy", style: "max-width:100%;height:auto;border-radius:14px" }),
  button: (e) => buttonNode(e),
};

/* ------------------------------------------------------------------ plan: content → list of element edits */
const sel = (sid, key) => '[data-cms="' + sid + "." + key + '"]';
function fieldOps(sid, def, v) {
  const s = sel(sid, def.key);
  switch (def.type) {
    case "text": return v.hidden ? [{ sel: s, op: "remove" }] : [{ sel: s, op: "inner", nodes: inline(v.text, def.rich, def.hl) }];
    case "heroTitle": return [{ sel: s, op: "inner", nodes: [v.text, v.highlight ? [" ", el("em", null, v.highlight)] : []].flat() }];
    case "image":
      if (v.hidden) return [{ sel: s, op: "remove" }];
      if (!v.src) return [{ sel: s, op: "restore" }];
      return [{ sel: s, op: "inner", nodes: [el("img", { src: v.src, alt: v.alt, style: "width:100%;height:auto;border-radius:18px;display:block" })] }];
    case "link": return v.hidden ? [{ sel: s, op: "remove" }] : [{ sel: s, op: "attr", name: "href", value: v.href }, { sel: s, op: "attr", name: "aria-label", value: v.label }];
    case "buttons": {
      const nodes = nl(visible(v.items).map((b) => buttonNode(b, def.extraClass)));
      if (def.mode === "replace") return nodes.length ? [{ sel: s, op: "replace", nodes }] : [{ sel: s, op: "remove" }];
      return [{ sel: s, op: "inner", nodes }];
    }
    case "links": return [{ sel: s, op: "inner", nodes: nl(visible(v.items).map((l) => el("a", { href: l.href }, l.label))) }];
    case "list": return [{ sel: s, op: "inner", nodes: nl(visible(v.items).map((x) => el("span", null, x.text))) }];
    case "cards": return [{ sel: s, op: "inner", nodes: nl(visible(v.items).map((it, i) => CARD_RENDER[def.card](it, i))) }];
  }
  return [];
}
const lighten = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (sh) => Math.round(((n >> sh) & 255) + (255 - ((n >> sh) & 255)) * f);
  return "#" + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("").toUpperCase();
};
/** --gold-2: the site's original pair for the default accent, otherwise 10% toward white (same as Phase 1). */
export const accentLight = (hex) => (hex.toUpperCase() === DEFAULT_ACCENT ? DEFAULT_ACCENT_LIGHT : lighten(hex, 0.1));
export function cssVars(settings) {
  const v = { "--gold": settings.accentColor, "--gold-2": accentLight(settings.accentColor) };
  if (settings.primaryColor !== DEFAULT_PRIMARY) Object.assign(v, { "--green": settings.primaryColor, "--green-2": lighten(settings.primaryColor, 0.12), "--green-3": lighten(settings.primaryColor, 0.06) });
  return v;
}
/**
 * plan(doc, settings, {force}) →  (force: also render fields equal to the defaults — used by tests)
 *   [{ sel, op, nodes?, name?, value?, section }]
 *   op: inner (replace children) | replace (replace element) | remove | append | attr | restore (preview only: keep original)
 *   plus one { op:"css", vars } for the <style id="wd71-cms"> tag.
 */
export function plan(doc, settings, opts = {}) {
  const ops = [];
  for (const s of doc.sections) {
    const def = sectionDef(s.id), dflt = DEFAULTS[s.id];
    if (s.hidden) { ops.push({ sel: '[data-cms-section="' + s.id + '"]', op: "remove", section: s.id }); continue; }
    for (const f of def.fields) {
      if (!opts.force && sameValue(s.fields[f.key], dflt.fields[f.key])) continue;
      for (const o of fieldOps(s.id, f, s.fields[f.key])) ops.push({ ...o, section: s.id, field: f.key });
    }
    const ex = visible(s.extra);
    if (def.slot && ex.length) {
      const align = def.align === "center" ? "center" : "flex-start";
      ops.push({ sel: '[data-cms-slot="' + s.id + '"]', op: "append", section: s.id, field: "extra",
        nodes: [el("div", { class: "cms-extra", style: "margin-top:28px;display:flex;flex-direction:column;gap:14px;align-items:" + align + ";text-align:" + (align === "center" ? "center" : "left") }, ex.map((e) => EXTRA_RENDER[e.type](e)))] });
    }
  }
  const st = settings, d = DEFAULT_SETTINGS;
  if (st.siteTitle !== d.siteTitle) ops.push({ sel: "head > title", op: "inner", nodes: [st.siteTitle], section: "settings" });
  if (st.metaDescription !== d.metaDescription) ops.push({ sel: 'meta[name="description"]', op: "attr", name: "content", value: st.metaDescription, section: "settings" });
  if (st.primaryColor !== d.primaryColor) ops.push({ sel: 'meta[name="theme-color"]', op: "attr", name: "content", value: st.primaryColor, section: "settings" });
  const contact = [
    st.contactPhone ? el("a", { href: "tel:" + st.contactPhone.replace(/[^0-9+]/g, "") }, st.contactPhone) : null,
    st.contactEmail ? el("a", { href: "mailto:" + st.contactEmail }, st.contactEmail) : null,
    st.contactAddress || null,
  ].filter(Boolean);
  const footer = doc.sections.find((s) => s.id === "footer");
  if (contact.length && !(footer && footer.hidden)) ops.push({ sel: '[data-cms-slot="footer"]', op: "append", section: "settings", nodes: [el("p", { class: "cms-contact" }, contact.flatMap((c, i) => (i ? [" · ", c] : [c])))] });
  ops.push({ op: "css", vars: cssVars(st), section: "settings" });
  return ops;
}
export const cssText = (vars) => ":root{" + Object.entries(vars).map(([k, v]) => k + ":" + v).join(";") + "}";

/* ------------------------------------------------------------------ preview (admin iframe, DOM only) */
/**
 * previewController(doc) snapshots the pristine page once, then apply(plan) restores every section from the
 * snapshot and applies the same plan the site Worker uses — so the preview always equals "original + plan".
 */
export function previewController(doc) {
  const roots = [...doc.querySelectorAll("[data-cms-section]")].map((n) => ({ cur: n, pristine: n.cloneNode(true) }));
  const titleEl = doc.querySelector("head > title"), titleText = titleEl ? titleEl.textContent : "";
  const metas = [...doc.querySelectorAll('meta[name="description"],meta[name="theme-color"]')].map((m) => [m, m.getAttribute("content")]);
  function bindFaq(scope) {
    scope.querySelectorAll(".faq-q").forEach((b) => b.addEventListener("click", () => {
      const open = b.parentElement.classList.toggle("open"); b.setAttribute("aria-expanded", open ? "true" : "false");
    }));
  }
  return {
    apply(ops) {
      for (const r of roots) { const fresh = r.pristine.cloneNode(true); r.cur.replaceWith(fresh); r.cur = fresh; }
      if (titleEl) titleEl.textContent = titleText;
      for (const [m, c] of metas) m.setAttribute("content", c);
      const rootStyle = doc.documentElement.style;
      for (const p of ["--gold", "--gold-2", "--green", "--green-2", "--green-3"]) rootStyle.removeProperty(p);
      for (const o of ops) {
        if (o.op === "css") { for (const [k, v] of Object.entries(o.vars)) rootStyle.setProperty(k, v); continue; }
        for (const n of doc.querySelectorAll(o.sel)) {
          if (o.op === "remove") n.style.display = "none";
          else if (o.op === "inner") { n.textContent = ""; n.append(toDom(o.nodes, doc)); }
          else if (o.op === "append") n.append(toDom(o.nodes, doc));
          else if (o.op === "attr") n.setAttribute(o.name, o.value);
          else if (o.op === "replace") {
            const frag = toDom(o.nodes, doc), first = frag.firstElementChild;
            if (first) first.setAttribute("data-cms-pv", n.getAttribute("data-cms") || "");
            n.replaceWith(frag);
          }
        }
      }
      doc.querySelectorAll(".reveal").forEach((n) => n.classList.add("in"));
      roots.forEach((r) => bindFaq(r.cur));
    },
    find(sid, key) {
      const k = sid + "." + key;
      return doc.querySelector('[data-cms="' + k + '"]') || doc.querySelector('[data-cms-pv="' + k + '"]') ||
        (key === "extra" ? doc.querySelector('[data-cms-slot="' + sid + '"] .cms-extra') : null) || doc.querySelector('[data-cms-section="' + sid + '"]');
    },
  };
}
