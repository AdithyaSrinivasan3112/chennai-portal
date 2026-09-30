/*
 * Chennai Control — tiny DOM helpers (no framework).
 *
 * h() builds elements and only ever sets text via textContent/text nodes,
 * so data from Firebase can never be interpreted as HTML.
 */

import { formatRelative } from "../core/time.js";

/**
 * h("div", { class: "row", text: "hi", onclick: fn, dataset: {id: 1} }, child, "text")
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Banner (persistent problems) and toast (transient feedback)         */
/* ------------------------------------------------------------------ */
const bannerEl = document.getElementById("banner");
const bannerTextEl = document.getElementById("banner-text");
document.getElementById("banner-close").addEventListener("click", () => {
  bannerEl.hidden = true;
});

export function showBanner(message) {
  bannerTextEl.textContent = message;
  bannerEl.hidden = false;
}

const toastEl = document.getElementById("toast");
let toastTimer = null;

export function toast(message, tone = "info") {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, tone === "error" ? 7000 : 3500);
}

/* ------------------------------------------------------------------ */
/* Relative times that stay fresh without re-rendering lists           */
/* ------------------------------------------------------------------ */

let clock = () => Date.now();

/** <time> element showing "3 min ago", refreshed by startRelativeTimes(). */
export function relTime(ms, title) {
  const el = h("time", { dataset: { ts: String(ms) } });
  if (title) el.title = title;
  el.textContent = formatRelative(ms, clock());
  return el;
}

export function startRelativeTimes(now) {
  clock = now;
  const refresh = () => {
    const t = now();
    document.querySelectorAll("time[data-ts]").forEach((el) => {
      el.textContent = formatRelative(Number(el.dataset.ts), t);
    });
  };
  refresh();
  setInterval(refresh, 10 * 1000);
  return refresh;
}

/** Badge: tone is one of ok | warn | bad | info | muted. */
export function badge(label, tone) {
  return h("span", { class: "badge", dataset: { tone }, text: label });
}

/** Resolve/reject `promise`, or reject after `ms` with `message`. */
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
