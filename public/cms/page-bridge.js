/**
 * Page builder canvas bridge (runs inside /__page-preview, an iframe of the admin panel on the SAME origin).
 * The admin posts the draft; we render it with the exact public renderer (pages.js) and report clicks,
 * hovers and drag-and-drop moves back. Messages from any other origin/window are ignored.
 *
 * parent → iframe  { type:"pb:render", page:{ title, slug, blocks }, settings, selected }
 *                  { type:"pb:select", id }   { type:"pb:drag", payload|null }   { type:"pb:scroll", id }
 * iframe → parent  { type:"pb:ready" }  { type:"pb:select", id }  { type:"pb:hover", id }
 *                  { type:"pb:drop", payload, target, pos }   pos: before | after | inside
 *                  { type:"pb:error", field, reason }   { type:"pb:key", key, shift, meta }
 */
import * as PG from "./pages.js";

const parentWin = window.parent;
const ORIGIN = location.origin;
const send = (m) => { if (parentWin && parentWin !== window) parentWin.postMessage(m, ORIGIN); };
const main = document.querySelector("main#top");
const style = document.getElementById("wd71-page");
const fonts = document.getElementById("wd71-fonts");
const ed = document.createElement("style");
ed.id = "wd71-editor";
ed.textContent = PG.EDITOR_CSS;
document.head.append(ed);
for (const id of ["pbx-line", "pbx-box", "pbx-tag"]) { const d = document.createElement("div"); d.id = id; document.body.append(d); }
const line = document.getElementById("pbx-line"), box = document.getElementById("pbx-box"), tag = document.getElementById("pbx-tag");

let tree = [], selected = null, hovered = null, dragPayload = null, types = {};
const ID_RE = /(?:^|\s)b-(b[a-z0-9]{4,15})(?:\s|$)/;
const idOf = (el) => { const m = el && el.className && typeof el.className === "string" && ID_RE.exec(el.className); return m ? m[1] : null; };
const blockEl = (start) => { for (let el = start; el && el !== main; el = el.parentElement) if (idOf(el)) return el; return null; };
const elOf = (id) => (id ? main.querySelector(".b-" + id) : null);
const indexTypes = (list) => { for (const b of list || []) { types[b.id] = b.type; indexTypes(b.children); } };

function render(msg) {
  let blocks;
  try { blocks = PG.cleanBlocks(msg.page.blocks || []); }
  catch (e) { send({ type: "pb:error", field: e.field || "blocks", reason: e.reason || "invalid" }); return; }
  tree = blocks; types = {}; indexTypes(tree);
  const y = window.scrollY;
  main.innerHTML = PG.renderMain(blocks, { editor: true, page: { title: msg.page.title || "", slug: msg.page.slug || "" }, settings: msg.settings || null });
  style.textContent = PG.pageCss(blocks);
  const fh = PG.fontsHref(blocks);
  if (fonts) { if (fh) { if (fonts.getAttribute("href") !== fh) fonts.setAttribute("href", fh); fonts.disabled = false; } else fonts.disabled = true; }
  window.scrollTo(0, y);
  setSelected(msg.selected || null, false);
}
function setSelected(id, scroll) {
  main.querySelectorAll(".pbx-sel").forEach((e) => e.classList.remove("pbx-sel"));
  selected = id;
  const el = elOf(id);
  if (!el) return;
  el.classList.add("pbx-sel");
  if (scroll) { const r = el.getBoundingClientRect(); if (r.top < 60 || r.top > innerHeight - 80) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function setHover(el) {
  if (hovered === el) return;
  if (hovered) hovered.classList.remove("pbx-hover");
  hovered = el;
  if (!el) { tag.style.display = "none"; return; }
  el.classList.add("pbx-hover");
  const id = idOf(el), def = PG.BLOCKS[types[id]];
  const r = el.getBoundingClientRect();
  tag.textContent = def ? def.label : "";
  tag.style.display = "block";
  tag.style.left = Math.max(0, r.left) + "px";
  tag.style.top = Math.max(0, r.top - 20) + "px";
}

addEventListener("message", (ev) => {
  if (ev.origin !== ORIGIN || ev.source !== parentWin) return;
  const m = ev.data || {};
  if (m.type === "pb:render") render(m);
  else if (m.type === "pb:select") setSelected(m.id, true);
  else if (m.type === "pb:scroll") setSelected(m.id, true);
  else if (m.type === "pb:drag") dragPayload = m.payload || null;
});

/* ---- clicks select, links never navigate inside the editor */
main.addEventListener("click", (ev) => {
  const a = ev.target.closest("a, button");
  if (a) ev.preventDefault();
  const el = blockEl(ev.target);
  const drop = ev.target.closest(".pb-drop");
  const id = el ? idOf(el) : drop ? drop.getAttribute("data-drop") : null;
  if (ev.target.closest("summary")) { /* let FAQ open/close, but also select */ } else if (!a) ev.preventDefault();
  send({ type: "pb:select", id: id || null });
}, true);
document.addEventListener("click", (ev) => { if (!main.contains(ev.target)) { const a = ev.target.closest("a"); if (a) ev.preventDefault(); } }, true);
document.addEventListener("submit", (ev) => ev.preventDefault(), true);
main.addEventListener("mouseover", (ev) => setHover(blockEl(ev.target)));
main.addEventListener("mouseleave", () => setHover(null));
addEventListener("keydown", (ev) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  if (((ev.ctrlKey || ev.metaKey) && ["z", "y", "s", "d", "c", "v"].includes(k)) || k === "delete" || k === "escape") {
    ev.preventDefault();
    send({ type: "pb:key", key: k, shift: ev.shiftKey, meta: ev.ctrlKey || ev.metaKey });
  }
});

/* ---- drag & drop: move blocks inside the canvas, or drop new blocks / patterns dragged from the admin library */
main.addEventListener("dragstart", (ev) => {
  const el = blockEl(ev.target);
  if (!el) return;
  const id = idOf(el);
  dragPayload = { kind: "move", id };
  el.classList.add("pbx-drag");
  ev.dataTransfer.effectAllowed = "move";
  try { ev.dataTransfer.setData("text/plain", "pb:" + id); } catch {}
  ev.stopPropagation();
});
main.addEventListener("dragend", () => { main.querySelectorAll(".pbx-drag").forEach((e) => e.classList.remove("pbx-drag")); hideMarks(); dragPayload = null; });
let dropAt = null;
function hideMarks() { line.style.display = "none"; box.style.display = "none"; dropAt = null; }
function computeDrop(ev) {
  const t = ev.target.nodeType === 1 ? ev.target : ev.target.parentElement;
  const zone = t && t.closest(".pb-drop");
  if (zone) return { target: zone.getAttribute("data-drop"), pos: "inside", el: zone };
  let el = blockEl(t);
  if (!el) {
    // below the last block / empty page → append at the end of the page
    const blocks = [...main.querySelectorAll(".pb-root > .pb, .pb-root > .pb-flow > .pb-in > .pb")];
    const last = blocks[blocks.length - 1];
    return last ? { target: idOf(last), pos: "after", el: last } : { target: null, pos: "inside", el: main };
  }
  if (dragPayload && dragPayload.kind === "move" && dragPayload.id && el.closest(".b-" + dragPayload.id)) return null; // into itself
  const r = el.getBoundingClientRect();
  const horizontal = types[idOf(el)] === "column";
  const f = horizontal ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
  return { target: idOf(el), pos: f < 0.5 ? "before" : "after", el, horizontal };
}
main.addEventListener("dragover", (ev) => {
  if (!dragPayload) return;
  const d = computeDrop(ev);
  if (!d) { hideMarks(); return; }
  ev.preventDefault();
  ev.dataTransfer.dropEffect = dragPayload.kind === "move" ? "move" : "copy";
  dropAt = d;
  const r = d.el.getBoundingClientRect();
  if (d.pos === "inside") { box.style.cssText = "display:block;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px"; line.style.display = "none"; }
  else {
    box.style.display = "none";
    line.style.cssText = d.horizontal
      ? "display:block;top:" + r.top + "px;height:" + r.height + "px;width:4px;left:" + ((d.pos === "before" ? r.left : r.right) - 2) + "px"
      : "display:block;left:" + r.left + "px;width:" + r.width + "px;height:4px;top:" + ((d.pos === "before" ? r.top : r.bottom) - 2) + "px";
  }
});
main.addEventListener("dragleave", (ev) => { if (!main.contains(ev.relatedTarget)) hideMarks(); });
main.addEventListener("drop", (ev) => {
  if (!dragPayload || !dropAt) return;
  ev.preventDefault();
  send({ type: "pb:drop", payload: dragPayload, target: dropAt.target, pos: dropAt.pos });
  hideMarks();
  dragPayload = null;
});
// every rendered block is draggable (attribute set after each render so the public HTML stays clean)
new MutationObserver(() => { main.querySelectorAll(".pb").forEach((e) => { if (idOf(e) && !e.hasAttribute("draggable")) e.setAttribute("draggable", "true"); }); }).observe(main, { childList: true, subtree: true });

send({ type: "pb:ready" });
