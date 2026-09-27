/*
 * Chennai Control — remote admin client (admin.html).
 *
 * Responsibilities (V0):
 *   1. Show this browser's Firebase connection state (`.info/connected`).
 *   2. Show whether the tablet looks online, from presence/last_seen.
 *   3. Show the current display mode.
 *   4. Let the admin set the display mode (Home / Good Morning / Good Night).
 */

import {
  db, initError,
  ref, onValue, update, serverTimestamp,
  PATHS, PRESENCE_STALE_MS, MODES
} from "./firebase-config.js";

// Tell the boot watchdog in admin.html that modules loaded successfully.
window.chennaiBooted = true;

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */
const connEl = document.getElementById("admin-conn");
const connLabelEl = document.getElementById("admin-conn-label");
const bannerEl = document.getElementById("banner");
const tabletStatusEl = document.getElementById("tablet-status");
const tabletStatusTextEl = document.getElementById("tablet-status-text");
const lastSeenEl = document.getElementById("last-seen");
const currentModeEl = document.getElementById("current-mode");
const modeUpdatedEl = document.getElementById("mode-updated");
const sendStatusEl = document.getElementById("send-status");
const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));

/* ------------------------------------------------------------------ */
/* Page state                                                          */
/* ------------------------------------------------------------------ */
const state = {
  connected: false,
  serverOffsetMs: 0,   // add to Date.now() to estimate Firebase server time
  lastSeen: null,      // presence/last_seen (server ms), or null if never seen
  mode: null,          // display/mode
  modeUpdatedAt: null, // display/updated_at (server ms)
  pendingMode: null    // mode currently being written, if any
};

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric", month: "short", hour: "numeric", minute: "2-digit"
});

function serverNow() {
  return Date.now() + state.serverOffsetMs;
}

// "just now" / "42 s ago" / "5 min ago" / "3 h ago" / "2 d ago"
function relative(ms) {
  const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// Absolute time in THIS browser's timezone; include the date if not today.
function absolute(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? timeFmt.format(d) : dateTimeFmt.format(d);
}

function describeTime(ms) {
  return typeof ms === "number" ? `${relative(ms)} · ${absolute(ms)}` : "—";
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
function showBanner(message) {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function renderConnection() {
  connEl.dataset.state = state.connected ? "online" : "offline";
  connLabelEl.textContent = state.connected ? "Firebase connected" : "Firebase offline";
}

function renderTablet() {
  let status;
  let text;

  if (typeof state.lastSeen !== "number") {
    status = "offline";
    text = "Never seen";
  } else if (!state.connected) {
    // We can't judge freshness if we ourselves aren't receiving updates.
    status = "unknown";
    text = "Unknown (this browser is offline)";
  } else if (serverNow() - state.lastSeen <= PRESENCE_STALE_MS) {
    status = "online";
    text = "Online";
  } else {
    status = "offline";
    text = "Offline";
  }

  tabletStatusEl.dataset.state = status;
  tabletStatusTextEl.textContent = text;
  lastSeenEl.textContent = describeTime(state.lastSeen);
}

function renderMode() {
  if (state.mode == null) {
    currentModeEl.textContent = "Not set (tablet shows Home)";
  } else {
    currentModeEl.textContent = MODES[state.mode] || `Unknown (“${state.mode}”)`;
  }
  modeUpdatedEl.textContent = describeTime(state.modeUpdatedAt);
}

function renderButtons() {
  for (const btn of modeButtons) {
    const mode = btn.dataset.mode;
    btn.disabled = !state.connected || state.pendingMode !== null;
    btn.setAttribute("aria-pressed", String(mode === state.mode));
    btn.classList.toggle("is-pending", mode === state.pendingMode);
  }
}

function renderAll() {
  renderConnection();
  renderTablet();
  renderMode();
  renderButtons();
}

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */
if (initError || !db) {
  connEl.dataset.state = "error";
  connLabelEl.textContent = "Firebase error";
  showBanner(`Firebase failed to initialise: ${initError ? initError.message : "unknown error"}`);
} else {
  startFirebase();
}

function startFirebase() {
  /* --- This browser's connection to Firebase --- */
  onValue(ref(db, PATHS.connected), (snap) => {
    state.connected = snap.val() === true;
    renderAll();
  });

  /* --- Clock skew vs Firebase server, for accurate "last seen" ages --- */
  onValue(ref(db, PATHS.serverTimeOffset), (snap) => {
    state.serverOffsetMs = Number(snap.val()) || 0;
    renderTablet();
  });

  /* --- Tablet presence --- */
  onValue(
    ref(db, `${PATHS.presence}/last_seen`),
    (snap) => {
      state.lastSeen = snap.val();
      renderTablet();
    },
    (err) => {
      console.error("[Chennai Control] Presence listener failed:", err);
      tabletStatusEl.dataset.state = "unknown";
      tabletStatusTextEl.textContent = "Unavailable";
      showBanner(`Cannot read tablet presence: ${err.message}`);
    }
  );

  /* --- Current display state --- */
  onValue(
    ref(db, PATHS.display),
    (snap) => {
      const data = snap.val() || {};
      state.mode = data.mode ?? null;
      state.modeUpdatedAt = data.updated_at ?? null;
      renderMode();
      renderButtons();
    },
    (err) => {
      console.error("[Chennai Control] Display listener failed:", err);
      currentModeEl.textContent = "Unavailable";
      showBanner(`Cannot read display state: ${err.message}`);
    }
  );

  /* --- Mode buttons --- */
  for (const btn of modeButtons) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }

  // Re-evaluate "online/offline" and relative times without any DB reads.
  setInterval(() => {
    renderTablet();
    renderMode();
  }, 5000);
}

function setMode(mode) {
  if (!MODES[mode] || state.pendingMode !== null) return;
  if (!state.connected) {
    sendStatusEl.textContent = "Not connected to Firebase — try again when online.";
    return;
  }

  state.pendingMode = mode;
  sendStatusEl.textContent = `Sending “${MODES[mode]}”…`;
  renderButtons();

  update(ref(db, PATHS.display), {
    mode,
    updated_at: serverTimestamp()
  })
    .then(() => {
      // The write reached Firebase. Whether the tablet shows it right now
      // depends on the tablet being online (see the Tablet card).
      sendStatusEl.textContent = `Saved “${MODES[mode]}” at ${timeFmt.format(new Date())}.`;
    })
    .catch((err) => {
      console.error("[Chennai Control] Failed to set mode:", err);
      sendStatusEl.textContent = `Failed to set “${MODES[mode]}”.`;
      showBanner(`Could not update display: ${err.message}`);
    })
    .finally(() => {
      state.pendingMode = null;
      renderButtons();
    });
}
