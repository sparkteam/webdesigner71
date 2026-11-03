/**
 * Push packages section defaults to production CONTENT KV (content:homepage:v2).
 * Run from admin-worker/:  node scripts/sync-packages-kv.mjs
 * Requires: wrangler login OR CLOUDFLARE_API_TOKEN with Workers KV Edit.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as CMS from "../src/cms-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const KV_KEY = "content:homepage:v2";

function wranglerKv(...args) {
  return execFileSync(process.execPath, [wrangler, "kv", "key", ...args, "--binding", "CONTENT", "--remote"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const raw = wranglerKv("get", KV_KEY);
if (!raw) {
  console.error("KV key missing:", KV_KEY);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch {
  console.error("Invalid JSON in KV");
  process.exit(1);
}

const at = new Date().toISOString();
const cleaned = CMS.cleanDoc(doc);
const i = cleaned.sections.findIndex((s) => s.id === "packages");
const prev = cleaned.sections[i];
const nextFields = CMS.DEFAULTS.packages.fields;
const next = {
  ...prev,
  fields: JSON.parse(JSON.stringify(nextFields)),
  version: (prev.version || 0) + 1,
  updatedAt: at,
  updatedBy: "sync-packages-kv",
};
cleaned.sections[i] = next;
cleaned.updatedAt = at;

const payload = JSON.stringify(cleaned);
wranglerKv("put", KV_KEY, payload);

console.log("OK packages section v" + next.version + " -> production KV");
console.log("Premium for:", next.fields.cards.items[1]?.for);
console.log("Premium features:", next.fields.cards.items[1]?.features?.items?.length);
