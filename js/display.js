/*
 * Chennai Portal — tablet display client (index.html).
 *
 * Responsibilities (V0):
 *   1. Show a local clock.
 *   2. Show Firebase connection state from `.info/connected`.
 *   3. Listen to devices/chennai-tablet/display and render the current mode.
 *   4. Heartbeat devices/chennai-tablet/presence/last_seen (server timestamp).
 */

import {
  db, initError,
  ref, onValue, set, serverTimestamp,
  PATHS, PRESENCE_INTERVAL_MS, MODES, DEFAULT_MODE
} from "./firebase-config.js";

// Tell the boot watchdog in index.html that modules loaded successfully.
window.chennaiBooted = true;

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */
const body = document.body;
const connEl = document.getElementById("conn");
const connLabelEl = document.getElementById("conn-label");
const headlineEl = document.getElementById("headline");
const sublineEl = document.getElementById("subline");
const clockTimeEl = document.getElementById("clock-time");
const clockDateEl = document.getElementById("clock-date");
const errorEl = document.getElementById("portal-error");

/* ------------------------------------------------------------------ */
/* What each mode looks like on the tablet                             */
/* ------------------------------------------------------------------ */
const MODE_CONTENT = {
  home:         { headline: "Welcome Home",  subline: "Chennai Portal" },
  good_morning: { headline: "Good Morning",  subline: "Wishing you a lovely day" },
  good_night:   { headline: "Good Night",    subline: "Sleep well" }
};

/* ------------------------------------------------------------------ */
/* Clock — local device time, updated on each minute boundary          */
/* ------------------------------------------------------------------ */
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

function renderClock() {
  const now = new Date();
  clockTimeEl.textContent = timeFormat.format(now);
  clockDateEl.textContent = dateFormat.format(now);

  // Schedule the next update just after the next minute starts.
  // (Recomputed every time, so it self-corrects after sleep/drift.)
  const msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50;
  setTimeout(renderClock, msToNextMinute);
}
renderClock();

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

// state: "connecting" | "online" | "offline" | "error"
function setConnection(state, label) {
  connEl.dataset.state = state;
  connLabelEl.textContent = label;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function renderMode(mode) {
  let key = mode;
  if (!MODE_CONTENT[key]) {
    // Missing (never set) or unknown value: fall back to Home, but log it.
    if (mode != null) console.warn("[Chennai Portal] Unknown display mode:", mode);
    key = DEFAULT_MODE;
  }
  const content = MODE_CONTENT[key];
  body.dataset.mode = key;
  headlineEl.textContent = content.headline;
  sublineEl.textContent = content.subline;
  document.title = `Chennai Portal · ${MODES[key]}`;
}

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */

if (initError || !db) {
  body.dataset.mode = "error";
  sublineEl.textContent = "Unable to start";
  setConnection("error", "Firebase error");
  showError(`Firebase failed to initialise: ${initError ? initError.message : "unknown error"}`);
} else {
  startFirebase();
}

function startFirebase() {
  let isConnected = false;
  let hasEverConnected = false;
  let displayReadError = null;

  /* --- Connection state (Firebase's own `.info/connected`) --- */
  onValue(ref(db, PATHS.connected), (snap) => {
    isConnected = snap.val() === true;

    if (isConnected) {
      hasEverConnected = true;
      setConnection("online", "Connected");
      writePresence(); // announce ourselves immediately on (re)connect
    } else {
      setConnection(
        "offline",
        hasEverConnected ? "Offline · reconnecting" : "Connecting…"
      );
    }

    // A read error (e.g. rules denied) stays visible even while connected.
    if (displayReadError) setConnection("error", "Sync error");
  });

  /* --- Shared display state --- */
  onValue(
    ref(db, PATHS.display),
    (snap) => {
      displayReadError = null;
      clearError();
      if (isConnected) setConnection("online", "Connected");
      const data = snap.val();
      renderMode(data ? data.mode : null);
    },
    (err) => {
      // Called if the listener is cancelled, typically permission_denied
      // (e.g. Test Mode rules have expired). Firebase will not retry this.
      displayReadError = err;
      console.error("[Chennai Portal] Display listener failed:", err);
      setConnection("error", "Sync error");
      showError(`Cannot read display state: ${err.message}`);
      // If we never received a mode, don't leave "Connecting…" on screen.
      if (body.dataset.mode === "connecting") sublineEl.textContent = "Unable to sync";
    }
  );

  /* --- Presence heartbeat --- */
  function writePresence() {
    // Skip while offline: otherwise the SDK queues writes and flushes them
    // later. The `.info/connected` handler writes as soon as we reconnect.
    if (!isConnected) return;

    set(ref(db, `${PATHS.presence}/last_seen`), serverTimestamp())
      .catch((err) => {
        console.error("[Chennai Portal] Presence write failed:", err);
        showError(`Presence update failed: ${err.message}`);
      });
  }

  setInterval(writePresence, PRESENCE_INTERVAL_MS);

  // When the page becomes visible again (screen woke up), report right away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") writePresence();
  });
}
