/*
 * Chennai Portal — Firebase initialisation (the ONLY file that knows the
 * Firebase config and SDK version).
 *
 * Both apps call `connect()` before attaching any listener. When Firebase
 * Authentication is introduced, sign-in goes inside `connect()` and nothing
 * else has to change.
 *
 * NOTE: The Realtime Database is in Test Mode during development. The apiKey
 * below is a public identifier, not a secret; access control must come from
 * Security Rules + Auth, never from hiding this file.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { PATHS } from "./config.js";

// Re-export the database helpers so no other file hard-codes the SDK URL.
export {
  ref,
  onValue,
  get,
  set,
  update,
  remove,
  push,
  query,
  orderByKey,
  limitToFirst,
  limitToLast,
  runTransaction,
  onDisconnect,
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

let db = null;
let initError = null;

try {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
} catch (err) {
  initError = err;
  console.error("[Chennai Portal] Firebase failed to initialise:", err);
}

/**
 * Resolve to the database once the client is ready to use it.
 * Throws if Firebase could not be initialised.
 *
 * Future: `await signInWithCustomToken(...)` / other Auth flow goes here,
 * so every listener is attached as an authenticated user.
 */
export async function connect() {
  if (!db) throw initError || new Error("Firebase is not initialised");
  return db;
}

/* ------------------------------------------------------------------ */
/* Server clock                                                        */
/*                                                                     */
/* Firebase tells us how far this device's clock is from the server's.  */
/* Everything that compares against server timestamps (presence age,   */
/* command expiry, reminder due times) uses serverNow().               */
/* ------------------------------------------------------------------ */
let serverOffsetMs = 0;

if (db) {
  onValue(ref(db, PATHS.serverTimeOffset), (snap) => {
    const value = Number(snap.val());
    serverOffsetMs = Number.isFinite(value) ? value : 0;
  });
}

export function serverNow() {
  return Date.now() + serverOffsetMs;
}
