/*
 * Chennai Control — entry point (admin.html).
 *
 * Owns: this browser's Firebase connection state, the Overview (tablet
 * health) card and the Display card. The other cards live in
 * commands.js, reminders.js and content.js, which receive the shared
 * `app` object defined below.
 */

import {
  connect, ref, onValue, update, serverTimestamp, serverNow
} from "../core/firebase.js";
import { APP_VERSION, PATHS, PRESENCE_STALE_MS, modeLabel } from "../core/config.js";
import { COMMAND_TYPES, commandDef, isPlainObject, isFiniteNumber, cleanText } from "../core/schema.js";
import { formatRelative, formatWhen } from "../core/time.js";
import { showBanner, toast, startRelativeTimes, withTimeout } from "./dom.js";
import { initCommands } from "./commands.js";
import { initReminders } from "./reminders.js";
import { initContent } from "./content.js";

// Tell the boot watchdog in admin.html that modules loaded.
window.chennaiBooted = true;

const $ = (id) => document.getElementById(id);

document.querySelectorAll("[data-app-version]").forEach((el) => {
  el.textContent = APP_VERSION;
});

/* ------------------------------------------------------------------ */
/* Shared app context                                                  */
/* ------------------------------------------------------------------ */
const app = {
  db: null,
  connected: false,

  /** Enable/disable every control that needs a live connection. */
  refreshControls() {
    document.querySelectorAll("[data-needs-connection]").forEach((el) => {
      el.disabled = !app.connected || el.dataset.busy === "true" || el.dataset.locked === "true";
    });
  },

  /** A listener was cancelled (e.g. permission denied): say so clearly. */
  listenFailed(name, err) {
    console.error(`[Chennai Control] Listener ${name} failed:`, err);
    showBanner(`Can't read ${name.replace("_", " ")} from Firebase (${err.code || err.message}). The page may be out of date.`);
  },

  sendCommand: null,  // set by commands.js
  watchCommand: null  // set by commands.js
};

/* ------------------------------------------------------------------ */
/* Tablet state (from presence + health + display)                     */
/* ------------------------------------------------------------------ */
const tablet = {
  lastSeen: null,
  health: {},
  display: {}
};

function computeStatus(now) {
  if (!app.connected) {
    return { state: "unknown", title: "Unknown", sub: "This browser is offline, so the tablet's status can't be checked." };
  }
  if (!isFiniteNumber(tablet.lastSeen)) {
    return { state: "offline", title: "Never seen", sub: "The portal hasn't reported in yet." };
  }
  const conn = tablet.health.connection;
  const saidGoodbye = isPlainObject(conn) && conn.state === "offline" &&
    isFiniteNumber(conn.changed_at) && conn.changed_at >= tablet.lastSeen - 5000;
  if (saidGoodbye) {
    return { state: "offline", title: "Offline", sub: `Disconnected ${formatRelative(conn.changed_at, now)}.` };
  }
  if (now - tablet.lastSeen <= PRESENCE_STALE_MS) {
    const showing = modeLabel(tablet.health.active_mode);
    return { state: "online", title: "Online", sub: showing ? `Showing ${showing}` : "Portal is running" };
  }
  return { state: "offline", title: "Offline", sub: `No heartbeat since ${formatRelative(tablet.lastSeen, now)}.` };
}

function setFact(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function renderOverview() {
  const now = serverNow();
  const status = computeStatus(now);
  const health = tablet.health;

  $("tablet-status").dataset.state = status.state;
  $("tablet-status-text").textContent = status.title;
  $("tablet-status-sub").textContent = status.sub;

  setFact("f-last-seen", isFiniteNumber(tablet.lastSeen)
    ? `${formatRelative(tablet.lastSeen, now)} · ${formatWhen(tablet.lastSeen)}`
    : "—");

  // Desired (display/mode) vs actual (health/active_mode)
  const desired = tablet.display.mode;
  const actual = health.active_mode;
  let showing = modeLabel(actual) || "—";
  let showingTone = null;
  // An unknown desired mode is shown as Home by the tablet, so that's not "switching".
  const expected = modeLabel(desired) ? desired : "home";
  if (status.state === "online" && actual && expected !== actual) {
    showing = `${modeLabel(actual) || cleanText(actual, 30)} (switching to ${modeLabel(expected)}…)`;
    showingTone = "warn";
  }
  setFact("f-showing", showing, showingTone);

  const conn = health.connection;
  if (isPlainObject(conn) && isFiniteNumber(conn.changed_at)) {
    const reconnects = isFiniteNumber(health.reconnects) && health.reconnects > 0 ? ` · ${health.reconnects} reconnect${health.reconnects > 1 ? "s" : ""}` : "";
    setFact("f-connection", `${conn.state === "online" ? "Connected" : "Disconnected"} ${formatRelative(conn.changed_at, now)}${reconnects}`);
  } else {
    setFact("f-connection", "—");
  }

  const version = cleanText(health.app_version, 20);
  if (!version) setFact("f-version", status.state === "online" ? "Unknown (older than 0.2)" : "—", status.state === "online" ? "warn" : null);
  else if (version !== APP_VERSION) setFact("f-version", `${version} — Control is ${APP_VERSION}. Refresh the portal after deploying.`, "warn");
  else setFact("f-version", version);

  setFact("f-session", isFiniteNumber(health.session_started_at)
    ? `${formatWhen(health.session_started_at)} (${formatRelative(health.session_started_at, now).replace(" ago", "")})`
    : "—");

  const screen = [cleanText(health.viewport, 20), health.pixel_ratio ? `@${health.pixel_ratio}x` : "", cleanText(health.orientation, 12)]
    .filter(Boolean).join(" ");
  setFact("f-screen", screen || "—");
  setFact("f-browser", [cleanText(health.browser, 40), cleanText(health.os, 20)].filter(Boolean).join(" · ") || "—");

  const lc = health.last_command;
  if (isPlainObject(lc) && lc.type) {
    const def = commandDef(lc.type);
    const label = def ? def.label : cleanText(lc.type, 40);
    const when = isFiniteNumber(lc.at) ? ` · ${formatRelative(lc.at, now)}` : "";
    const code = lc.error_code ? ` (${cleanText(lc.error_code, 40)})` : "";
    setFact("f-last-command", `${label} → ${cleanText(lc.status, 20)}${code}${when}`,
      lc.status === "failed" ? "bad" : null);
  } else {
    setFact("f-last-command", "—");
  }

  const le = health.last_error;
  if (isPlainObject(le) && le.area) {
    const when = isFiniteNumber(le.at) ? ` · ${formatRelative(le.at, now)}` : "";
    setFact("f-last-error", `${cleanText(le.area, 30)}: ${cleanText(le.code, 40)}${when}`);
  } else {
    setFact("f-last-error", "None reported");
  }

  const lr = health.last_reload;
  $("f-reload-row").hidden = !(isPlainObject(lr) && isFiniteNumber(lr.at));
  if (isPlainObject(lr) && isFiniteNumber(lr.at)) setFact("f-reload", `Reloaded by command ${formatRelative(lr.at, now)}`);

  // What the photo frame is really showing (Photos card).
  const ss = health.slideshow;
  let photoLine = "";
  if (status.state === "online" && isPlainObject(ss) && isFiniteNumber(ss.photos)) {
    photoLine = `On the tablet now: ${ss.source === "custom" ? "custom list" : "bundled photos"} (${ss.photos}).`;
    if (ss.custom_unusable) photoLine += " None of the custom photos could be loaded, so it fell back to the bundled ones; it retries every 30 minutes.";
  }
  $("ss-tablet").textContent = photoLine;

  renderDisplay(now);
}

/* ------------------------------------------------------------------ */
/* Display card                                                        */
/* ------------------------------------------------------------------ */
const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
const asCommandInput = $("mode-as-command");
const displayStatusEl = $("display-status");

function renderDisplay(now) {
  const desired = tablet.display.mode;
  modeButtons.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === desired));
  });
  const by = cleanText(tablet.display.updated_by, 60);
  if (!displayStatusEl.dataset.sticky) {
    if (!desired) displayStatusEl.textContent = "No mode set yet — the tablet shows Home.";
    else if (!modeLabel(desired)) displayStatusEl.textContent = `Unknown mode “${cleanText(desired, 30)}” — the tablet shows Home.`;
    else {
      const when = isFiniteNumber(tablet.display.updated_at) ? ` ${formatRelative(tablet.display.updated_at, now)}` : "";
      const via = by.startsWith("command:") ? " (via command)" : "";
      displayStatusEl.textContent = `Set to ${modeLabel(desired)}${when}${via}.`;
    }
  }
}

function flashDisplayStatus(text) {
  displayStatusEl.textContent = text;
  displayStatusEl.dataset.sticky = "true";
  setTimeout(() => {
    delete displayStatusEl.dataset.sticky;
    renderDisplay(serverNow());
  }, 6000);
}

async function chooseMode(mode) {
  if (!modeLabel(mode)) return;
  modeButtons.forEach((b) => { b.dataset.busy = "true"; });
  app.refreshControls();
  try {
    if (asCommandInput.checked) {
      // Acknowledged path: only switches if the tablet runs it before it expires.
      const id = await app.sendCommand("SET_MODE", { mode }, COMMAND_TYPES.SET_MODE.defaultTtlMs);
      flashDisplayStatus(`Asked the tablet to switch to ${modeLabel(mode)}…`);
      app.watchCommand(id, (cmd) => {
        if (cmd.status === "completed") flashDisplayStatus(`The tablet switched to ${modeLabel(mode)}.`);
        else if (cmd.status === "expired") flashDisplayStatus("The tablet didn't respond in time; nothing changed.");
        else if (cmd.status === "failed") flashDisplayStatus(`Failed: ${(cmd.error && cmd.error.message) || "unknown error"}`);
      });
    } else {
      // Desired-state path (V0.1 behaviour): applies whenever the tablet is online.
      await withTimeout(
        update(ref(app.db, PATHS.display), { mode, updated_at: serverTimestamp(), updated_by: "chennai-control" }),
        10 * 1000,
        "Firebase did not confirm in time."
      );
    }
  } catch (err) {
    toast(`Could not change the display: ${err.message}`, "error");
  } finally {
    modeButtons.forEach((b) => { delete b.dataset.busy; });
    app.refreshControls();
  }
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => chooseMode(btn.dataset.mode));
});

/* ------------------------------------------------------------------ */
/* Section navigation: highlight the tab for the section in view       */
/* ------------------------------------------------------------------ */
function initNav() {
  const links = Array.from(document.querySelectorAll(".tabs a"));
  if (!("IntersectionObserver" in window)) return;
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((a) => a.removeAttribute("aria-current"));
      const link = byId.get(entry.target.id);
      if (link) link.setAttribute("aria-current", "true");
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  byId.forEach((_, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}
initNav();

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function start() {
  const connEl = $("admin-conn");
  const connLabel = $("admin-conn-label");
  app.refreshControls();

  let db;
  try {
    db = await connect();
  } catch (err) {
    connEl.dataset.state = "error";
    connLabel.textContent = "Firebase error";
    showBanner(`Firebase failed to initialise: ${err.message}`);
    return;
  }
  app.db = db;

  onValue(ref(db, PATHS.connected), (snap) => {
    app.connected = snap.val() === true;
    connEl.dataset.state = app.connected ? "online" : "offline";
    connLabel.textContent = app.connected ? "Connected" : "Offline";
    app.refreshControls();
    renderOverview();
  });

  onValue(ref(db, `${PATHS.presence}/last_seen`), (snap) => {
    tablet.lastSeen = snap.val();
    renderOverview();
  }, (err) => app.listenFailed("presence", err));

  onValue(ref(db, PATHS.health), (snap) => {
    const value = snap.val();
    tablet.health = isPlainObject(value) ? value : {};
    renderOverview();
  }, (err) => app.listenFailed("health", err));

  onValue(ref(db, PATHS.display), (snap) => {
    const value = snap.val();
    tablet.display = isPlainObject(value) ? value : {};
    renderOverview();
  }, (err) => app.listenFailed("display", err));

  // Each section is isolated: one failing never takes down the others.
  for (const [name, init] of [["commands", initCommands], ["reminders", initReminders], ["content", initContent]]) {
    try {
      init(app);
    } catch (err) {
      console.error(`[Chennai Control] ${name} failed to start:`, err);
      showBanner(`The ${name} section failed to start: ${err.message}`);
    }
  }

  startRelativeTimes(serverNow);
  setInterval(renderOverview, 5000); // freshness of "online" + relative times; no DB reads
}

start();
