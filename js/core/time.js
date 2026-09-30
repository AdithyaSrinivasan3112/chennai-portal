/*
 * Chennai Portal — time helpers shared by the portal and Chennai Control.
 *
 * "Chennai time" is IST (UTC+05:30, no daylight saving), so it can be
 * computed with plain arithmetic. That keeps reminders correct even when
 * the admin's browser is in another time zone.
 */

import { CHENNAI } from "./config.js";

const IST_OFFSET_MS = CHENNAI.utcOffsetMinutes * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole-day number in Chennai time; equal numbers = same Chennai date. */
export function chennaiDayNumber(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
}

/** { year, month (1-12), day, hour, minute } of `ms` in Chennai time. */
export function chennaiParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

/** Epoch ms for a wall-clock date/time in Chennai. */
export function chennaiToEpoch(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS;
}

/* ------------------------------------------------------------------ */
/* Formatters (created once; Intl formatters are relatively costly)    */
/* ------------------------------------------------------------------ */

// Device-local formats (the tablet itself is on IST).
const localTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const localTimeSec = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const localDateLong = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const localDateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// Explicit Chennai-time formats (used by Chennai Control for reminders).
const chennaiTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: CHENNAI.timeZone });
const chennaiDateTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: CHENNAI.timeZone
});

export const fmt = {
  time: (ms) => localTime.format(ms),
  timeWithSeconds: (ms) => localTimeSec.format(ms),
  dateLong: (ms) => localDateLong.format(ms),
  dateTime: (ms) => localDateTime.format(ms),
  chennaiTime: (ms) => chennaiTime.format(ms),
  chennaiDateTime: (ms) => chennaiDateTime.format(ms)
};

/** Local time, adding the date only when `ms` isn't today. */
export function formatWhen(ms) {
  const sameDay = new Date(ms).toDateString() === new Date().toDateString();
  return sameDay ? fmt.timeWithSeconds(ms) : fmt.dateTime(ms);
}

/** "just now" / "42 s ago" / "5 min ago" / "3 h ago" / "2 d ago" (or "in …"). */
export function formatRelative(ms, now) {
  const diffS = Math.round((now - ms) / 1000);
  const future = diffS < 0;
  const s = Math.abs(diffS);
  let text;
  if (s < 10) return "just now";
  if (s < 60) text = `${s} s`;
  else if (s < 3600) text = `${Math.floor(s / 60)} min`;
  else if (s < 48 * 3600) text = `${Math.floor(s / 3600)} h`;
  else text = `${Math.floor(s / 86400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Short duration: "0.8 s", "12 s", "3 min", "2 h". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10 * 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600 * 1000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 3600000)} h`;
}
