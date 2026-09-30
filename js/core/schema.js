/*
 * Chennai Portal — data validation shared by the portal and Chennai Control.
 *
 * Rule of thumb: anything read from Firebase is untrusted. It is passed
 * through one of the normalise/validate functions below before use, and it
 * is only ever rendered with textContent (never innerHTML).
 *
 * Validators return { ok: true, value } or { ok: false, code, message }.
 */

import { LIMITS, SLIDESHOW_DEFAULTS, modeLabel } from "./config.js";

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Control characters and bidi overrides have no place in family messages.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

/**
 * Coerce to a clean, length-limited string ("" if not a string).
 * Length is counted in characters, so emoji are never cut in half.
 */
export function cleanText(value, max, { multiline = false } = {}) {
  if (typeof value !== "string") return "";
  let text = value.replace(UNSAFE_CHARS, "");
  text = multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  text = text.trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

const ok = (value) => ({ ok: true, value });
const invalid = (code, message) => ({ ok: false, code, message });

/** Small, non-sensitive error record for writing back to Firebase. */
export function errorInfo(code, message) {
  return {
    code: cleanText(String(code || "error"), 40) || "error",
    message: cleanText(String(message || ""), LIMITS.errorMessage)
  };
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export const COMMAND_STATUS = {
  PENDING: "pending",         // written by Chennai Control
  PROCESSING: "processing",   // claimed by one tablet session
  COMPLETED: "completed",     // handler succeeded
  FAILED: "failed",           // invalid / handler error / interrupted
  EXPIRED: "expired",         // reached the tablet after expires_at
  CANCELLED: "cancelled"      // withdrawn by Chennai Control while pending
};

export const TERMINAL_STATUSES = new Set([
  COMMAND_STATUS.COMPLETED,
  COMMAND_STATUS.FAILED,
  COMMAND_STATUS.EXPIRED,
  COMMAND_STATUS.CANCELLED
]);

/**
 * Every command type the system knows about, with its payload validator.
 * Chennai Control validates before sending; the tablet validates again on
 * receipt (it never trusts the sender). The tablet-side behaviour lives in
 * js/portal/command-handlers.js.
 */
export const COMMAND_TYPES = {
  SHOW_MESSAGE: {
    label: "Message",
    defaultTtlMs: 10 * 60 * 1000,
    validate(payload) {
      if (!isPlainObject(payload)) return invalid("bad_payload", "Message payload is missing.");
      const text = cleanText(payload.text, LIMITS.messageText, { multiline: true });
      if (!text) return invalid("bad_payload", "Message text is empty.");
      const title = cleanText(payload.title, LIMITS.messageTitle);
      let duration = Number(payload.duration_s);
      if (!Number.isFinite(duration)) duration = LIMITS.messageDefaultDurationS;
      duration = clamp(Math.round(duration), LIMITS.messageMinDurationS, LIMITS.messageMaxDurationS);
      const value = { text, duration_s: duration };
      if (title) value.title = title;
      return ok(value);
    },
    summarize(payload) {
      if (!isPlainObject(payload)) return "";
      const title = cleanText(payload.title, LIMITS.messageTitle);
      const text = cleanText(payload.text, 80);
      return title ? `${title} — ${text}` : text;
    }
  },

  SET_MODE: {
    label: "Set mode",
    defaultTtlMs: 2 * 60 * 1000,
    validate(payload) {
      if (!isPlainObject(payload) || !modeLabel(payload.mode)) {
        return invalid("bad_payload", "Unknown display mode.");
      }
      return ok({ mode: payload.mode });
    },
    summarize(payload) {
      const label = isPlainObject(payload) ? modeLabel(payload.mode) : null;
      return label ? `→ ${label}` : "";
    }
  },

  REFRESH_PORTAL: {
    label: "Refresh portal",
    defaultTtlMs: 2 * 60 * 1000,
    validate() {
      return ok({}); // no payload; anything sent is ignored
    },
    summarize() {
      return "Reload the tablet page";
    }
  }
};

/** Definition for a command type, or null. Safe for untrusted type strings. */
export function commandDef(type) {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(COMMAND_TYPES, type) ? COMMAND_TYPES[type] : null;
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

export const REMINDER_STATUS = {
  SCHEDULED: "scheduled",
  ACKNOWLEDGED: "acknowledged",
  CANCELLED: "cancelled"
};

const REMINDER_STATUSES = new Set(Object.values(REMINDER_STATUS));

/** Normalise a reminder read from Firebase; null if unusable. */
export function normalizeReminder(id, raw) {
  if (!isPlainObject(raw)) return null;
  const title = cleanText(raw.title, LIMITS.reminderTitle);
  const dueAt = raw.due_at;
  if (!title || !isFiniteNumber(dueAt)) return null;

  const status = raw.status === undefined ? REMINDER_STATUS.SCHEDULED : raw.status;
  if (!REMINDER_STATUSES.has(status)) return null;

  return {
    id,
    title,
    message: cleanText(raw.message, LIMITS.reminderMessage, { multiline: true }),
    due_at: dueAt,
    status,
    created_at: isFiniteNumber(raw.created_at) ? raw.created_at : null,
    acknowledged_at: isFiniteNumber(raw.acknowledged_at) ? raw.acknowledged_at : null,
    acknowledged_by: cleanText(raw.acknowledged_by, 40)
  };
}

/** Validate reminder input from the Chennai Control form. */
export function validateReminderInput({ title, message, due_at }) {
  const cleanTitle = cleanText(title, LIMITS.reminderTitle);
  if (!cleanTitle) return invalid("bad_input", "Please enter a title.");
  if (!isFiniteNumber(due_at)) return invalid("bad_input", "Please choose a valid date and time.");
  const value = { title: cleanTitle, due_at };
  const cleanMessage = cleanText(message, LIMITS.reminderMessage, { multiline: true });
  if (cleanMessage) value.message = cleanMessage;
  return ok(value);
}

/* ------------------------------------------------------------------ */
/* Morning note                                                        */
/* ------------------------------------------------------------------ */

export function normalizeMorningNote(raw) {
  if (!isPlainObject(raw)) return null;
  const text = cleanText(raw.text, LIMITS.noteText, { multiline: true });
  if (!text) return null;
  return {
    text,
    from: cleanText(raw.from, LIMITS.noteFrom),
    updated_at: isFiniteNumber(raw.updated_at) ? raw.updated_at : null
  };
}

/* ------------------------------------------------------------------ */
/* Slideshow / photos                                                  */
/* ------------------------------------------------------------------ */

const POSITION_RE = /^\d{1,3}% \d{1,3}%$/;

/**
 * Accept only same-origin URLs (e.g. "photos/x.jpg") or https:// URLs.
 * Returns an absolute URL string, or null.
 */
export function safeImageUrl(value, baseHref = globalThis.location ? globalThis.location.href : undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.url) return null;
  let url;
  try {
    url = new URL(trimmed, baseHref);
  } catch (err) {
    return null;
  }
  const base = baseHref ? new URL(baseHref) : null;
  const sameOrigin = base && url.origin === base.origin;
  if (sameOrigin || url.protocol === "https:") return url.href;
  return null;
}

/** Normalise one photo entry; null if unusable. */
export function normalizePhoto(raw, id) {
  if (!isPlainObject(raw)) return null;
  const src = safeImageUrl(raw.src);
  if (!src) return null;
  const photo = { id: id || src, src, caption: cleanText(raw.caption, LIMITS.caption) };
  if (typeof raw.position === "string" && POSITION_RE.test(raw.position)) photo.position = raw.position;
  return photo;
}

/** Array or Firebase map (ordered by push key) → clean photo array. */
export function normalizePhotoList(raw) {
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw.map((item, i) => [String(i), item]);
  } else if (isPlainObject(raw)) {
    entries = Object.keys(raw).sort().map((key) => [key, raw[key]]);
  }
  const photos = [];
  for (const [key, item] of entries) {
    const photo = normalizePhoto(item, key);
    if (photo) photos.push(photo);
    if (photos.length >= LIMITS.customPhotos) break;
  }
  return photos;
}

/** Slideshow settings from Firebase with safe defaults. */
export function normalizeSlideshow(raw) {
  const cfg = isPlainObject(raw) ? raw : {};
  let interval = Number(cfg.interval_s);
  if (!Number.isFinite(interval)) interval = SLIDESHOW_DEFAULTS.interval_s;
  return {
    interval_s: clamp(Math.round(interval), 5, 600),
    shuffle: cfg.shuffle === true,
    source: cfg.source === "custom" ? "custom" : "bundled",
    photos: normalizePhotoList(cfg.photos),
    updated_at: isFiniteNumber(cfg.updated_at) ? cfg.updated_at : null
  };
}

/* ------------------------------------------------------------------ */
/* Command results                                                     */
/* ------------------------------------------------------------------ */

/** Keep handler results small and primitive before writing them. */
export function sanitizeResult(result) {
  const out = {};
  if (!isPlainObject(result)) return out;
  let count = 0;
  for (const key of Object.keys(result)) {
    if (count >= 8 || !/^[a-z_]{1,32}$/.test(key)) continue;
    const value = result[key];
    if (typeof value === "string") out[key] = cleanText(value, 200);
    else if (typeof value === "boolean" || isFiniteNumber(value)) out[key] = value;
    else continue;
    count++;
  }
  return out;
}
