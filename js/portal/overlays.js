/*
 * Chennai Portal — on-screen overlays.
 *
 *   createMessageOverlay   → temporary message card (SHOW_MESSAGE command)
 *   createReminderPresenter → due-reminder card with a "Done" button, plus
 *                             the "Today" list on the Good Morning screen
 *
 * All remote text is rendered with textContent only.
 *
 * IMPORTANT LIMITATION: reminders are evaluated by a timer inside this web
 * page. They only appear while the page is open and the browser is
 * running it. This is display logic, NOT a reliable alarm/notification
 * system (see BUILD_NOTES.md → Reminders).
 */

import { REMINDER_SHOW_WINDOW_MS } from "../core/config.js";
import { REMINDER_STATUS } from "../core/schema.js";
import { fmt, chennaiDayNumber } from "../core/time.js";

const part = (root, key) => root.querySelector(`[data-part="${key}"]`);

function lengthClass(text) {
  const n = text.length;
  if (n <= 60) return "short";
  if (n <= 180) return "medium";
  return "long";
}

/* ------------------------------------------------------------------ */
/* Message overlay                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} root  the overlay element (hidden by default)
 * @param {{ onClosed?: (id: string, reason: "tap"|"timeout"|"replaced") => void }} opts
 */
export function createMessageOverlay(root, { onClosed } = {}) {
  const titleEl = part(root, "title");
  const textEl = part(root, "text");
  const metaEl = part(root, "meta");
  const button = part(root, "dismiss");

  let current = null;
  let timer = null;

  function close(reason) {
    if (!current) return;
    clearTimeout(timer);
    const { id } = current;
    current = null;
    root.hidden = true;
    if (onClosed) onClosed(id, reason);
  }

  button.addEventListener("click", () => close("tap"));

  return {
    /** Show a validated message: { id, title?, text, duration_s, sentAt? } */
    show({ id, title, text, duration_s, sentAt }) {
      if (current) close("replaced");
      current = { id };

      titleEl.textContent = title || "";
      titleEl.hidden = !title;
      textEl.textContent = text;
      root.dataset.length = lengthClass(text);
      metaEl.textContent = typeof sentAt === "number" ? `Sent ${fmt.time(sentAt)}` : "";
      root.hidden = false;

      timer = setTimeout(() => close("timeout"), duration_s * 1000);
    },
    close,
    get currentId() {
      return current ? current.id : null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

const EVALUATE_EVERY_MS = 30 * 1000;
const TODAY_LIST_MAX = 4;

/**
 * @param {{
 *   overlay: HTMLElement,            // due-reminder card
 *   todayList: HTMLElement,          // <ul> on the Good Morning screen
 *   now: () => number,               // server-corrected clock
 *   onAcknowledge: (id: string) => Promise<void>
 * }} opts
 */
export function createReminderPresenter({ overlay, todayList, now, onAcknowledge }) {
  const kickerEl = part(overlay, "kicker");
  const titleEl = part(overlay, "title");
  const textEl = part(overlay, "text");
  const moreEl = part(overlay, "more");
  const button = part(overlay, "ack");

  let reminders = [];
  let shownId = null;
  const acknowledgedLocally = new Set(); // hide immediately, even before the write lands
  let lastTodayKey = null;

  function dueNow(t) {
    return reminders
      .filter((r) =>
        r.status === REMINDER_STATUS.SCHEDULED &&
        !acknowledgedLocally.has(r.id) &&
        r.due_at <= t &&
        t - r.due_at <= REMINDER_SHOW_WINDOW_MS)
      .sort((a, b) => a.due_at - b.due_at);
  }

  function showCard(reminder, moreCount) {
    if (shownId !== reminder.id) {
      shownId = reminder.id;
      kickerEl.textContent = `Reminder · ${fmt.time(reminder.due_at)}`;
      titleEl.textContent = reminder.title;
      textEl.textContent = reminder.message;
      textEl.hidden = !reminder.message;
      button.disabled = false;
    }
    moreEl.textContent = moreCount > 0 ? `${moreCount} more reminder${moreCount > 1 ? "s" : ""} after this` : "";
    moreEl.hidden = moreCount === 0;
    overlay.hidden = false;
  }

  function hideCard() {
    shownId = null;
    overlay.hidden = true;
  }

  function renderToday(t) {
    const today = chennaiDayNumber(t);
    const items = reminders
      .filter((r) => r.status !== REMINDER_STATUS.CANCELLED && chennaiDayNumber(r.due_at) === today)
      .sort((a, b) => a.due_at - b.due_at);

    // Only touch the DOM when something visible changed.
    const key = items
      .map((r) => `${r.id}:${r.status}:${acknowledgedLocally.has(r.id)}:${r.due_at <= t}`)
      .join("|");
    if (key === lastTodayKey) return;
    lastTodayKey = key;

    const rows = items.slice(0, TODAY_LIST_MAX).map((r) => {
      const done = r.status === REMINDER_STATUS.ACKNOWLEDGED || acknowledgedLocally.has(r.id);
      const li = document.createElement("li");
      li.className = done ? "is-done" : r.due_at <= t ? "is-due" : "is-upcoming";

      const time = document.createElement("span");
      time.className = "today-time";
      time.textContent = fmt.time(r.due_at);

      const title = document.createElement("span");
      title.className = "today-title";
      title.textContent = r.title;

      const state = document.createElement("span");
      state.className = "today-state";
      state.textContent = done ? "Done" : r.due_at <= t ? "Due" : "";

      li.append(time, title, state);
      return li;
    });

    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "is-empty";
      li.textContent = "No reminders today";
      rows.push(li);
    } else if (items.length > TODAY_LIST_MAX) {
      const li = document.createElement("li");
      li.className = "is-more";
      li.textContent = `+ ${items.length - TODAY_LIST_MAX} more`;
      rows.push(li);
    }
    // (textContent + append rather than replaceChildren, for older WebViews)
    todayList.textContent = "";
    todayList.append(...rows);
  }

  function evaluate() {
    const t = now();
    const due = dueNow(t);
    if (due.length) showCard(due[0], due.length - 1);
    else hideCard();
    renderToday(t);
  }

  button.addEventListener("click", () => {
    const id = shownId;
    if (!id) return;
    button.disabled = true;
    acknowledgedLocally.add(id);
    evaluate();
    Promise.resolve(onAcknowledge(id)).catch((err) => {
      // Keep it hidden for this session (no nagging); the failure is
      // reported to health so Chennai Control can see it.
      console.error("[Reminders] Acknowledge failed:", err);
    });
  });

  setInterval(evaluate, EVALUATE_EVERY_MS);
  evaluate();

  return {
    /** Replace the reminder list (normalised reminders). */
    setReminders(list) {
      reminders = Array.isArray(list) ? list : [];
      // Forget local acknowledgements once Firebase agrees.
      for (const r of reminders) {
        if (r.status !== REMINDER_STATUS.SCHEDULED) acknowledgedLocally.delete(r.id);
      }
      evaluate();
    },
    evaluate
  };
}
