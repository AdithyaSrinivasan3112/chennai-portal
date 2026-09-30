/*
 * Chennai Portal — shared constants (no Firebase imports here).
 *
 * Everything that both the tablet (portal) and Chennai Control (admin)
 * need to agree on lives in this file: version, device ID, database
 * paths, timings and limits. This module is safe to import even when the
 * Firebase SDK cannot be loaded.
 */

// Bump this with every build that goes onto the tablet.
// Shown in Chennai Control and written to the tablet's health record.
export const APP_VERSION = "0.2.0-dev";

// Only one device for now. Everything for it lives under devices/<id>/,
// which keeps future per-device Security Rules simple.
export const DEVICE_ID = "chennai-tablet";
const DEVICE_ROOT = `devices/${DEVICE_ID}`;

export const PATHS = {
  connected: ".info/connected",                    // Firebase's own connection flag
  serverTimeOffset: ".info/serverTimeOffset",      // local clock vs server clock (ms)

  presence: `${DEVICE_ROOT}/presence`,             // { last_seen }            (V0.1, unchanged)
  display: `${DEVICE_ROOT}/display`,               // { mode, updated_at, updated_by } (desired state)
  health: `${DEVICE_ROOT}/health`,                 // tablet telemetry (see BUILD_NOTES.md)
  commands: `${DEVICE_ROOT}/commands`,             // { <pushId>: command }
  reminders: `${DEVICE_ROOT}/reminders`,           // { <pushId>: reminder }
  slideshow: `${DEVICE_ROOT}/content/slideshow`,   // slideshow settings + optional custom photo list
  morningNote: `${DEVICE_ROOT}/content/morning_note` // { text, from, updated_at }
};

// Used only to check whether the Firebase CDN is reachable again after a
// failed boot. Keep the version in sync with js/core/firebase.js.
export const FIREBASE_SDK_PROBE_URL = "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

/* ------------------------------------------------------------------ */
/* Presence / health                                                   */
/* ------------------------------------------------------------------ */

// Tablet writes presence/last_seen this often while the page is open.
export const PRESENCE_INTERVAL_MS = 60 * 1000;   // 60 s

// Chennai Control treats the tablet as offline once last_seen is older than this.
export const PRESENCE_STALE_MS = 150 * 1000;     // 150 s (2.5 heartbeats)

/* ------------------------------------------------------------------ */
/* Display modes                                                       */
/* ------------------------------------------------------------------ */

export const MODES = {
  home: "Home",
  good_morning: "Good Morning",
  good_night: "Good Night"
};

export const DEFAULT_MODE = "home";

/** Label for a mode key, or null. Safe for untrusted keys ("constructor" etc.). */
export function modeLabel(mode) {
  return typeof mode === "string" && Object.prototype.hasOwnProperty.call(MODES, mode) ? MODES[mode] : null;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

// The tablet only ever listens to the newest N commands (bounded listener).
export const COMMAND_WINDOW = 25;

// No command may live longer than this, whatever the sender asks for.
export const COMMAND_MAX_TTL_MS = 60 * 60 * 1000;   // 1 hour

// A command stuck in "processing" this long is considered abandoned
// (e.g. the tablet page was closed mid-command).
export const COMMAND_STALE_CLAIM_MS = 2 * 60 * 1000;

// Minimum gap between two remote REFRESH_PORTAL reloads (loop protection).
export const REFRESH_MIN_GAP_MS = 2 * 60 * 1000;

// Identifies who issued a command. Once Firebase Auth is added this becomes
// the signed-in user's UID and Security Rules will enforce it.
export const ISSUER = "chennai-control";

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

// The tablet reads the newest N reminders only.
export const REMINDER_WINDOW = 50;

// A due reminder is shown on the tablet for up to this long after its due
// time; after that it is considered missed and no longer pops up.
export const REMINDER_SHOW_WINDOW_MS = 12 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Location used for weather / AQI and for "Chennai time"              */
/* ------------------------------------------------------------------ */

// City-level coordinates (Chennai city centre), not the family's address.
export const CHENNAI = {
  name: "Chennai",
  latitude: 13.0827,
  longitude: 80.2707,
  timeZone: "Asia/Kolkata",
  utcOffsetMinutes: 330 // IST, no daylight saving
};

/* ------------------------------------------------------------------ */
/* Slideshow defaults (overridable from Firebase content/slideshow)    */
/* ------------------------------------------------------------------ */

export const SLIDESHOW_DEFAULTS = {
  interval_s: 20,
  shuffle: false,
  source: "bundled"   // "bundled" = photos/manifest.json, "custom" = list in Firebase
};

export const BUNDLED_MANIFEST_URL = "photos/manifest.json";

/* ------------------------------------------------------------------ */
/* Text limits (enforced when sending AND when rendering)              */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  messageTitle: 60,
  messageText: 400,
  messageMinDurationS: 10,
  messageMaxDurationS: 30 * 60,
  messageDefaultDurationS: 5 * 60,
  reminderTitle: 80,
  reminderMessage: 300,
  noteText: 240,
  noteFrom: 40,
  caption: 80,
  url: 500,
  customPhotos: 100,
  errorMessage: 200
};
