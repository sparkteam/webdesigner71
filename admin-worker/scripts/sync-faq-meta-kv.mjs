/**
 * Push FAQ section + settings meta to production CONTENT KV.
 * Run from admin-worker/:  node scripts/sync-faq-meta-kv.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as CMS from "../src/cms-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function wranglerKv(...args) {
  return execFileSync(process.execPath, [wrangler, "kv", "key", ...args, "--binding", "CONTENT", "--remote"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const at = new Date().toISOString();
const homeKey = "content:homepage:v2";
const raw = wranglerKv("get", homeKey);
const doc = JSON.parse(raw);
const cleaned = CMS.cleanDoc(doc);
const fi = cleaned.sections.findIndex((s) => s.id === "faq");
const prev = cleaned.sections[fi];
cleaned.sections[fi] = {
  ...prev,
  fields: JSON.parse(JSON.stringify(CMS.DEFAULTS.faq.fields)),
  version: (prev.version || 0) + 1,
  updatedAt: at,
  updatedBy: "sync-faq-meta-kv",
};
cleaned.updatedAt = at;
wranglerKv("put", homeKey, JSON.stringify(cleaned));

const settingsKey = "settings:site";
const sRaw = wranglerKv("get", settingsKey);
const settings = sRaw ? CMS.cleanSettings(JSON.parse(sRaw)) : CMS.DEFAULT_SETTINGS;
const nextSettings = { ...settings, metaDescription: CMS.DEFAULT_SETTINGS_RAW.metaDescription, updatedAt: at, updatedBy: "sync-faq-meta-kv" };
wranglerKv("put", settingsKey, JSON.stringify(nextSettings));

console.log("OK faq v" + cleaned.sections[fi].version + ", settings meta updated");