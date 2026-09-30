/*
 * Chennai Portal — everything on the tablet that talks to Firebase.
 *
 * main.js loads this module with a dynamic import(), so if the Firebase
 * SDK can't be downloaded the clock and photo frame keep working and
 * main.js retries later.
 *
 * Writes made by the tablet (all under devices/chennai-tablet/):
 *   presence/last_seen      heartbeat every 60 s (unchanged from V0.1)
 *   health/…                telemetry, written only on events (see BUILD_NOTES.md)
 *   commands/<id>           claim + result (via command-engine.js)
 *   reminders/<id>          acknowledgement when "Done" is tapped
 *   display                 only when a SET_MODE command runs
 */

import {
  connect, ref, onValue, set, update, query, orderByKey, limitToLast,
  runTransaction, onDisconnect, serverTimestamp, serverNow
} from "../core/firebase.js";
import { APP_VERSION, PATHS, PRESENCE_INTERVAL_MS, REMINDER_WINDOW } from "../core/config.js";
import {
  normalizeReminder, normalizeSlideshow, normalizeMorningNote, isPlainObject,
  cleanText, REMINDER_STATUS
} from "../core/schema.js";
import { startCommandEngine } from "./command-engine.js";
import { createCommandHandlers } from "./command-handlers.js";

const ERROR_REPORT_GAP_MS = 5 * 60 * 1000; // same error (area + code) reported at most every 5 min
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;   // Firebase push keys

/* ------------------------------------------------------------------ */
/* Coarse client description (no fingerprinting, no device model)      */
/* ------------------------------------------------------------------ */
function describeClient() {
  const ua = navigator.userAgent || "";
  const match = (re) => {
    const m = re.exec(ua);
    return m ? m[1] : null;
  };

  let browser = "Other";
  const samsung = match(/SamsungBrowser\/(\d+)/);
  const chrome = match(/Chrome\/(\d+)/);
  const firefox = match(/Firefox\/(\d+)/);
  const safari = match(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/);
  if (samsung) browser = `Samsung Internet ${samsung}`;
  else if (chrome) browser = /; wv\)/.test(ua) ? `Android WebView ${chrome}` : `Chrome ${chrome}`;
  else if (firefox) browser = `Firefox ${firefox}`;
  else if (safari) browser = `Safari ${safari}`;

  let os = "Other";
  const android = match(/Android (\d+)/);
  if (android) os = `Android ${android}`;
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";

  return { browser, os, ...describeScreen() };
}

function describeScreen() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    viewport: `${w}×${h}`,
    pixel_ratio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    orientation: w >= h ? "landscape" : "portrait"
  };
}

/* ------------------------------------------------------------------ */

/**
 * Attach every Firebase listener and writer for the tablet.
 * @param {object} portal  the API object built in main.js
 */
export async function startSync(portal) {
  const db = await connect();
  const { session } = portal;
  portal.setClock(serverNow);

  const healthRef = ref(db, PATHS.health);
  let connected = false;
  let everConnected = false;
  let reconnects = 0;
  let sessionAnnounced = false;
  const failedListeners = new Set();

  /* --- health writes (small, event-driven) -------------------------- */
  function writeHealth(fields) {
    update(healthRef, { ...fields, updated_at: serverTimestamp() }).catch((err) => {
      console.warn("[Sync] Health write failed:", err.message);
    });
  }

  const lastErrorAt = {}; // "area:code" → time last reported
  portal.hooks.error = (area, code) => {
    const now = Date.now();
    const key = `${area}:${code}`;
    if (lastErrorAt[key] && now - lastErrorAt[key] < ERROR_REPORT_GAP_MS) return;
    lastErrorAt[key] = now;
    writeHealth({ last_error: { area: cleanText(area, 30), code: cleanText(String(code), 40), at: serverTimestamp() } });
  };
  portal.flushErrors();

  portal.hooks.mode = (mode) => writeHealth({ active_mode: mode, active_mode_at: serverTimestamp() });
  portal.hooks.photos = (report) => writeHealth({ slideshow: report });

  /* --- connection indicator ----------------------------------------- */
  function refreshIndicator() {
    if (failedListeners.size) portal.setConnection("error", "Sync error");
    else if (connected) portal.setConnection("online", "Connected");
    else portal.setConnection("offline", everConnected ? "Offline · reconnecting" : "Connecting…");
  }

  /** onValue with visible error handling and crash isolation. */
  function listen(name, target, onData) {
    onValue(
      target,
      (snap) => {
        if (failedListeners.delete(name)) refreshIndicator();
        try {
          onData(snap);
        } catch (err) {
          console.error(`[Sync] Handling ${name} failed:`, err);
          portal.reportError(name, "render_failed");
        }
      },
      (err) => {
        // Firebase cancels a listener on e.g. permission_denied and does
        // not retry it; show that instead of silently going stale.
        console.error(`[Sync] Listener ${name} cancelled:`, err);
        failedListeners.add(name);
        refreshIndicator();
        portal.reportError(name, err.code || "listen_failed");
      }
    );
  }

  /* --- presence heartbeat (V0.1 behaviour, unchanged) --------------- */
  function writePresence() {
    // Skip while offline so the SDK doesn't queue stale heartbeats.
    if (!connected) return;
    set(ref(db, `${PATHS.presence}/last_seen`), serverTimestamp()).catch((err) => {
      console.error("[Sync] Presence write failed:", err);
      portal.reportError("presence", err.code || "write_failed");
    });
  }

  /* --- announce this session on every (re)connect ------------------- */
  function announce() {
    const connectionRef = ref(db, `${PATHS.health}/connection`);
    // Firebase's server writes this if the socket drops, so Chennai
    // Control can show "offline" without waiting for last_seen to go stale.
    onDisconnect(connectionRef)
      .set({ state: "offline", changed_at: serverTimestamp() })
      .catch((err) => console.warn("[Sync] onDisconnect failed:", err.message));

    const fields = {
      app_version: APP_VERSION,
      session_id: session.id,
      connection: { state: "online", changed_at: serverTimestamp() },
      reconnects,
      active_mode: portal.mode,
      visibility: document.visibilityState,
      ...describeClient()
    };
    if (portal.photoReport) fields.slideshow = portal.photoReport;
    if (!sessionAnnounced) {
      sessionAnnounced = true;
      fields.session_started_at = serverTimestamp();
      if (session.reloadMarker) {
        fields.last_reload = {
          command_id: cleanText(session.reloadMarker.command_id, 64),
          at: serverTimestamp()
        };
      }
    }
    writeHealth(fields);
  }

  onValue(ref(db, PATHS.connected), (snap) => {
    connected = snap.val() === true;
    if (connected) {
      if (everConnected) reconnects++;
      everConnected = true;
      announce();
      writePresence();
    }
    refreshIndicator();
  });

  setInterval(writePresence, PRESENCE_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    writeHealth({ visibility: document.visibilityState });
    if (document.visibilityState === "visible") writePresence();
  });

  let resizeTimer = null;
  let lastViewport = describeScreen().viewport;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const screen = describeScreen();
      if (screen.viewport === lastViewport) return;
      lastViewport = screen.viewport;
      writeHealth(screen);
    }, 3000);
  });

  /* --- shared state listeners --------------------------------------- */
  listen("display", ref(db, PATHS.display), (snap) => {
    const data = snap.val();
    portal.setMode(isPlainObject(data) ? data.mode : null);
  });

  listen("slideshow", ref(db, PATHS.slideshow), (snap) => {
    portal.applySlideshowConfig(normalizeSlideshow(snap.val()));
  });

  listen("morning_note", ref(db, PATHS.morningNote), (snap) => {
    portal.setMorningNote(normalizeMorningNote(snap.val()));
  });

  listen("reminders", query(ref(db, PATHS.reminders), orderByKey(), limitToLast(REMINDER_WINDOW)), (snap) => {
    const list = [];
    snap.forEach((child) => {
      const reminder = normalizeReminder(child.key, child.val());
      if (reminder) list.push(reminder);
    });
    portal.reminders.setReminders(list);
  });

  /* --- reminder acknowledgement ------------------------------------- */
  portal.hooks.acknowledgeReminder = async (id) => {
    if (!KEY_RE.test(id)) return;
    const result = await runTransaction(ref(db, `${PATHS.reminders}/${id}`), (current) => {
      if (current === null) return null;
      if (!isPlainObject(current)) return undefined;
      const status = current.status === undefined ? REMINDER_STATUS.SCHEDULED : current.status;
      if (status !== REMINDER_STATUS.SCHEDULED) return undefined; // cancelled/acked elsewhere
      return {
        ...current,
        status: REMINDER_STATUS.ACKNOWLEDGED,
        acknowledged_at: serverTimestamp(),
        acknowledged_by: "tablet"
      };
    });
    if (!result.committed) console.info("[Sync] Reminder was no longer scheduled:", id);
  };

  /* --- message dismissal (annotates the finished command) ----------- */
  portal.hooks.messageClosed = (id, reason) => {
    if (!KEY_RE.test(id)) return;
    update(ref(db, `${PATHS.commands}/${id}`), {
      "result/closed_by": reason,
      "result/closed_at": serverTimestamp()
    }).catch((err) => console.warn("[Sync] Could not record message close:", err.message));
  };

  /* --- commands ------------------------------------------------------ */
  const handlers = createCommandHandlers({
    showMessage: (message) => portal.showMessage(message),
    currentMode: () => portal.mode,
    writeDisplayMode: (mode, updatedBy) =>
      update(ref(db, PATHS.display), { mode, updated_at: serverTimestamp(), updated_by: updatedBy }),
    lastCommandReloadAt: () => portal.lastCommandReloadAt(),
    siteReachable: () => portal.siteReachable(),
    reloadForCommand: (commandId) => portal.reloadForCommand(commandId)
  });

  startCommandEngine({
    db,
    sessionId: session.id,
    previousSessionId: session.previousId,
    handlers,
    onStatus: (info) => writeHealth({ last_command: { ...info, at: serverTimestamp() } }),
    onError: (area, code) => portal.reportError(area, code)
  });
}
