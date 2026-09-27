/*
 * Chennai Portal — shared Firebase setup and constants.
 *
 * This is the ONLY place the Firebase config and SDK version live.
 * Both the tablet display (display.js) and Chennai Control (admin.js)
 * import from here.
 *
 * NOTE: The Realtime Database is in Test Mode during development.
 * Firebase Authentication and restrictive Security Rules must be added
 * before any sensitive functionality is introduced. The apiKey below is
 * not a secret (Firebase web keys are public identifiers); access control
 * must come from Security Rules, not from hiding this file.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

// Re-export the database helpers so pages never hard-code the SDK URL/version.
export {
  ref,
  onValue,
  set,
  update,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAPY1R9eyQsOpR_3V3o_Fh6n0tdd_FhAXA",
  authDomain: "chennai-portal.firebaseapp.com",
  databaseURL: "https://chennai-portal-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "chennai-portal",
  storageBucket: "chennai-portal.firebasestorage.app",
  messagingSenderId: "720458878569",
  appId: "1:720458878569:web:cc2886379bf7e9140d5cf8"
};

/* ------------------------------------------------------------------ */
/* Initialise Firebase. If this fails, pages read `initError` and show */
/* a visible error instead of pretending to work.                      */
/* ------------------------------------------------------------------ */
let db = null;
let initError = null;

try {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
} catch (err) {
  initError = err;
  console.error("[Chennai Portal] Firebase failed to initialise:", err);
}

export { db, initError };

/* ------------------------------------------------------------------ */
/* Shared app constants                                                */
/* ------------------------------------------------------------------ */

// Only one device for now.
export const DEVICE_ID = "chennai-tablet";

// Database paths (see handoff notes for the full data model).
export const PATHS = {
  connected: ".info/connected",               // Firebase's own connection flag
  serverTimeOffset: ".info/serverTimeOffset", // local clock vs server clock (ms)
  presence: `devices/${DEVICE_ID}/presence`,  // { last_seen }
  display: `devices/${DEVICE_ID}/display`     // { mode, updated_at }
};

// Tablet writes presence/last_seen this often while the page is open.
export const PRESENCE_INTERVAL_MS = 60 * 1000;       // 60 s

// Chennai Control treats the tablet as offline once last_seen is older than this.
// 2.5 × the interval, so a single late/missed heartbeat doesn't flap the status.
export const PRESENCE_STALE_MS = 150 * 1000;         // 150 s

// The display modes Chennai Control can choose. Keys are what's stored in
// Firebase; values are human-readable labels.
export const MODES = {
  home: "Home",
  good_morning: "Good Morning",
  good_night: "Good Night"
};

export const DEFAULT_MODE = "home";
