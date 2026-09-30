/*
 * Chennai Portal — tablet entry point (index.html).
 *
 * BOOT ORDER (reliability first):
 *   1. Local-only UI starts immediately: clock, last known mode, photo
 *      frame, overlays. None of it needs Firebase.
 *   2. Firebase is loaded afterwards with a dynamic import() of sync.js.
 *      If the SDK/CDN is unreachable, the portal keeps running locally,
 *      shows "Offline · retrying", and recovers on its own.
 *
 * This file owns the screen. sync.js (Firebase) talks to it only through
 * the `portal` object defined at the bottom.
 */

import { APP_VERSION, MODES, DEFAULT_MODE, CHENNAI, FIREBASE_SDK_PROBE_URL } from "../core/config.js";
import { fmt } from "../core/time.js";
import { createSlideshow, loadBundledPhotos } from "./slideshow.js";
import { createWeatherPanels, openMeteoProvider } from "./weather.js";
import { createMessageOverlay, createReminderPresenter } from "./overlays.js";

// Tell the boot watchdog in index.html that the app's modules loaded.
window.chennaiBooted = true;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Storage helpers — storage can be unavailable; never let that crash  */
/* ------------------------------------------------------------------ */
function storageGet(area, key) {
  try {
    return window[area].getItem(key);
  } catch (err) {
    return null;
  }
}
function storageSet(area, key, value) {
  try {
    window[area].setItem(key, String(value));
  } catch (err) {
    /* ignore */
  }
}
function storageRemove(area, key) {
  try {
    window[area].removeItem(key);
  } catch (err) {
    /* ignore */
  }
}

const KEYS = {
  mode: "chennai.mode",                           // last mode shown (local)
  session: "chennai.session",                     // sessionStorage: id of the previous load in this tab
  lastCommandReload: "chennai.lastCommandReload", // time of last REFRESH_PORTAL reload
  reloadMarker: "chennai.reloadMarker",           // sessionStorage: reload was command-triggered
  bootReload: "chennai.bootReloadAt"              // sessionStorage: last recovery reload
};

/* ------------------------------------------------------------------ */
/* Session identity: random per page load. Not a device fingerprint.   */
/* Used to claim commands and to recognise our own abandoned claims.   */
/* ------------------------------------------------------------------ */
function randomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function takeReloadMarker() {
  const raw = storageGet("sessionStorage", KEYS.reloadMarker);
  storageRemove("sessionStorage", KEYS.reloadMarker);
  try {
    const marker = JSON.parse(raw || "null");
    return marker && typeof marker.command_id === "string" ? marker : null;
  } catch (err) {
    return null;
  }
}

// previousId comes from sessionStorage, which survives a reload of the same
// tab but is not shared with other tabs — so a second portal tab can never
// mistake the first tab's in-flight command for an abandoned one.
const session = {
  id: randomId(),
  previousId: storageGet("sessionStorage", KEYS.session),
  reloadMarker: takeReloadMarker()
};
storageSet("sessionStorage", KEYS.session, session.id);

/* ------------------------------------------------------------------ */
/* Clock (device local time — the tablet is set to IST)                */
/* ------------------------------------------------------------------ */
const clockTimeEls = document.querySelectorAll('[data-clock="time"]');
const clockDateEls = document.querySelectorAll('[data-clock="date"]');

function renderClock() {
  const now = new Date();
  const time = fmt.time(now);
  const date = fmt.dateLong(now);
  clockTimeEls.forEach((el) => { el.textContent = time; });
  clockDateEls.forEach((el) => { el.textContent = date; });
  // Next update just after the minute changes (self-correcting).
  setTimeout(renderClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
}
renderClock();

// Server-corrected "now" once Firebase is up; device clock until then.
let clockNow = () => Date.now();

/* ------------------------------------------------------------------ */
/* Connection indicator (tap it for a small diagnostics line)          */
/* ------------------------------------------------------------------ */
const statusEl = $("status");
const statusLabelEl = $("status-label");
let statusLabel = "Connecting…";
let diagTimer = null;

function setConnection(state, label) {
  statusEl.dataset.state = state;
  statusLabel = label;
  if (!statusEl.dataset.expanded) statusLabelEl.textContent = label;
}

statusEl.addEventListener("click", () => {
  clearTimeout(diagTimer);
  statusEl.dataset.expanded = "true";
  statusLabelEl.textContent =
    `${statusLabel} · v${APP_VERSION} · ${window.innerWidth}×${window.innerHeight} · ${MODES[mode] || ""}`;
  diagTimer = setTimeout(() => {
    delete statusEl.dataset.expanded;
    statusLabelEl.textContent = statusLabel;
  }, 8000);
});

/* ------------------------------------------------------------------ */
/* Errors from optional features (buffered until Firebase is up)       */
/* ------------------------------------------------------------------ */
const pendingErrors = [];
function reportError(area, code) {
  if (portal.hooks.error) portal.hooks.error(area, code);
  else if (pendingErrors.length < 10) pendingErrors.push([area, code]);
}

/* ------------------------------------------------------------------ */
/* Photo frame                                                         */
/* ------------------------------------------------------------------ */
const CUSTOM_RETRY_MS = 30 * 60 * 1000;

let bundledPhotos = null;
let slideshowConfig = null;
let customUnusable = false; // every custom photo failed → use bundled for a while
let customRetryTimer = null;

const slideshow = createSlideshow({
  layers: [$("slide-a"), $("slide-b")],
  captionEl: $("slide-caption"),
  onError: (code) => reportError("slideshow", code),
  onStuck: () => {
    // Nothing in the custom list loads (bad links, or those hosts are
    // unreachable): fall back to the bundled photos, retry later.
    if (!usingCustom() || !bundledPhotos) return;
    customUnusable = true;
    reportError("slideshow", "custom_list_unusable");
    applyPhotoSource();
    clearTimeout(customRetryTimer);
    customRetryTimer = setTimeout(() => {
      customUnusable = false;
      applyPhotoSource();
    }, CUSTOM_RETRY_MS);
  }
});

function usingCustom() {
  return Boolean(slideshowConfig && slideshowConfig.source === "custom" && slideshowConfig.photos.length && !customUnusable);
}

let photoReport = null; // what the frame is really showing (sent to health)

function applyPhotoSource() {
  const custom = usingCustom();
  const photos = custom ? slideshowConfig.photos : bundledPhotos; // custom empty/unusable → bundled
  if (!photos) return;
  slideshow.setPhotos(photos);

  const report = { source: custom ? "custom" : "bundled", photos: photos.length, custom_unusable: customUnusable };
  if (!photoReport || JSON.stringify(report) !== JSON.stringify(photoReport)) {
    photoReport = report;
    if (portal.hooks.photos) portal.hooks.photos(report);
  }
}

loadBundledPhotos().then((photos) => {
  bundledPhotos = photos;
  applyPhotoSource();
});

/* ------------------------------------------------------------------ */
/* Good Morning panels                                                 */
/* ------------------------------------------------------------------ */
const weather = createWeatherPanels({
  weatherEl: $("weather-panel"),
  airEl: $("air-panel"),
  provider: openMeteoProvider,
  location: CHENNAI,
  onError: (area, code) => reportError(area, code)
});

const notePanel = $("note-panel");
function setMorningNote(note) {
  notePanel.dataset.empty = note ? "false" : "true";
  $("note-text").textContent = note ? note.text : "Messages from the family will appear here.";
  const from = $("note-from");
  from.textContent = note && note.from ? `— ${note.from}` : "";
  from.hidden = !(note && note.from);
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */
const messages = createMessageOverlay($("message-overlay"), {
  onClosed: (id, reason) => {
    if (portal.hooks.messageClosed) portal.hooks.messageClosed(id, reason);
  }
});

const reminders = createReminderPresenter({
  overlay: $("reminder-overlay"),
  todayList: $("today-list"),
  now: () => clockNow(),
  onAcknowledge: (id) =>
    portal.hooks.acknowledgeReminder
      ? portal.hooks.acknowledgeReminder(id)
      : Promise.reject(new Error("Firebase not connected"))
});

/* ------------------------------------------------------------------ */
/* Display modes                                                       */
/* ------------------------------------------------------------------ */
const screens = {
  home: $("screen-home"),
  good_morning: $("screen-morning"),
  good_night: $("screen-night")
};
const THEME_COLORS = { home: "#000000", good_morning: "#f4dcbd", good_night: "#000000" };
const themeMeta = document.querySelector('meta[name="theme-color"]');
let mode = null;

function setMode(requested) {
  const valid = Object.prototype.hasOwnProperty.call(MODES, requested);
  if (requested != null && !valid) console.warn("[Portal] Unknown mode, showing Home:", requested);
  const next = valid ? requested : DEFAULT_MODE;
  if (next === mode) return;
  mode = next;

  for (const [key, el] of Object.entries(screens)) el.hidden = key !== next;
  document.body.dataset.mode = next;
  document.title = `Chennai Portal · ${MODES[next]}`;
  if (themeMeta) themeMeta.setAttribute("content", THEME_COLORS[next]);

  // Only the visible screen does any work.
  if (next === "home") slideshow.start();
  else slideshow.stop();
  if (next === "good_morning") weather.activate();
  else weather.deactivate();

  storageSet("localStorage", KEYS.mode, next);
  if (portal.hooks.mode) portal.hooks.mode(next);
}

/* ------------------------------------------------------------------ */
/* Network probes + reloads                                            */
/* ------------------------------------------------------------------ */
async function probe(url, options) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), 6000);
  try {
    const res = await fetch(url, { cache: "no-store", ...options, signal: controller ? controller.signal : undefined });
    return res.type === "opaque" || res.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const siteReachable = () => probe(new URL("./", location.href).href, { method: "HEAD" });
const sdkReachable = () => probe(FIREBASE_SDK_PROBE_URL, { mode: "no-cors" });

function reloadForCommand(commandId) {
  storageSet("localStorage", KEYS.lastCommandReload, Date.now());
  storageSet("sessionStorage", KEYS.reloadMarker, JSON.stringify({ command_id: commandId }));
  setConnection("connecting", "Refreshing…"); // a visible state, so the label shows
  setTimeout(() => location.reload(), 1200);
}

/* ------------------------------------------------------------------ */
/* The API sync.js uses                                                */
/* ------------------------------------------------------------------ */
const portal = {
  session,
  hooks: { error: null, mode: null, photos: null, acknowledgeReminder: null, messageClosed: null },
  get mode() {
    return mode;
  },
  get photoReport() {
    return photoReport;
  },
  setMode,
  setConnection,
  setClock(fn) {
    clockNow = fn;
    reminders.evaluate();
  },
  applySlideshowConfig(config) {
    slideshowConfig = config;
    customUnusable = false; // new settings from Chennai Control: give them a fresh try
    slideshow.configure(config);
    applyPhotoSource();
  },
  setMorningNote,
  showMessage: (message) => messages.show(message),
  reminders,
  reportError,
  flushErrors() {
    while (pendingErrors.length && portal.hooks.error) portal.hooks.error(...pendingErrors.shift());
  },
  lastCommandReloadAt: () => Number(storageGet("localStorage", KEYS.lastCommandReload)) || 0,
  siteReachable,
  reloadForCommand
};

/* ------------------------------------------------------------------ */
/* Start: local UI now, Firebase after                                 */
/* ------------------------------------------------------------------ */
setMode(storageGet("localStorage", KEYS.mode)); // don't flash a bright photo at night after a reload
setMorningNote(null);

async function startFirebase(attempt) {
  let sync;
  try {
    sync = await import("./sync.js"); // pulls in the Firebase SDK from the CDN
  } catch (err) {
    console.error(`[Portal] Could not load Firebase (attempt ${attempt}):`, err);
    setConnection("error", "Offline · retrying");
    if (attempt < 2) setTimeout(() => startFirebase(attempt + 1), 30 * 1000);
    else recoverWhenOnline();
    return;
  }
  try {
    await sync.startSync(portal);
  } catch (err) {
    // SDK loaded but initialisation failed (e.g. bad config): not retryable.
    console.error("[Portal] Firebase initialisation failed:", err);
    setConnection("error", "Firebase error");
  }
}

// Browsers may cache a failed module download for the life of the page, so
// after repeated failures the clean fix is a reload — but only once the site
// AND the Firebase CDN are reachable again (a reload while offline would
// replace the photo frame with a browser error page), and at most once
// every 5 minutes.
function recoverWhenOnline() {
  setInterval(async () => {
    const last = Number(storageGet("sessionStorage", KEYS.bootReload)) || 0;
    if (Date.now() - last < 5 * 60 * 1000) return;
    if ((await siteReachable()) && (await sdkReachable())) {
      storageSet("sessionStorage", KEYS.bootReload, Date.now());
      location.reload();
    }
  }, 60 * 1000);
}

startFirebase(1);
