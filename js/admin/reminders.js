/*
 * Chennai Control — reminders (create, list, cancel, remove).
 *
 * Due times are entered and shown in Chennai time (IST) regardless of
 * where the admin is, because the reminder is for people in Chennai.
 *
 * Reminder record (devices/chennai-tablet/reminders/<pushId>):
 *   { title, message?, due_at, status, created_at, created_by,
 *     acknowledged_at?, acknowledged_by?, cancelled_at? }
 */

import {
  ref, onValue, push, set, remove, query, orderByKey, limitToLast, runTransaction,
  serverTimestamp, serverNow
} from "../core/firebase.js";
import { PATHS, ISSUER, LIMITS, REMINDER_WINDOW, REMINDER_SHOW_WINDOW_MS } from "../core/config.js";
import { normalizeReminder, validateReminderInput, REMINDER_STATUS, isPlainObject } from "../core/schema.js";
import { chennaiParts, chennaiToEpoch, fmt } from "../core/time.js";
import { h, badge, toast, withTimeout } from "./dom.js";

const pad = (n) => String(n).padStart(2, "0");

export function initReminders(app) {
  const { db } = app;
  const form = document.getElementById("reminder-form");
  const titleInput = document.getElementById("rem-title");
  const messageInput = document.getElementById("rem-message");
  const dateInput = document.getElementById("rem-date");
  const timeInput = document.getElementById("rem-time");
  const statusEl = document.getElementById("rem-status");
  const listEl = document.getElementById("reminder-list");
  const submitButton = document.getElementById("rem-save");

  titleInput.maxLength = LIMITS.reminderTitle;
  messageInput.maxLength = LIMITS.reminderMessage;

  // Default: today, next full hour (Chennai time).
  function setDefaultDateTime() {
    const next = chennaiParts(serverNow() + 60 * 60 * 1000);
    dateInput.value = `${next.year}-${pad(next.month)}-${pad(next.day)}`;
    timeInput.value = `${pad(next.hour)}:00`;
  }
  setDefaultDateTime();

  function readDueAt() {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput.value);
    const t = /^(\d{2}):(\d{2})/.exec(timeInput.value);
    if (!d || !t) return NaN;
    return chennaiToEpoch(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const check = validateReminderInput({
      title: titleInput.value,
      message: messageInput.value,
      due_at: readDueAt()
    });
    if (!check.ok) {
      statusEl.textContent = check.message;
      return;
    }
    const now = serverNow();
    if (check.value.due_at < now - REMINDER_SHOW_WINDOW_MS) {
      statusEl.textContent = "That time is more than 12 hours ago, so it would never be shown.";
      return;
    }
    if (check.value.due_at < now - 60 * 1000 &&
        !window.confirm("That time has already passed in Chennai. Create it anyway? It will appear on the tablet straight away.")) {
      return;
    }

    submitButton.dataset.busy = "true";
    app.refreshControls();
    statusEl.textContent = "Saving…";
    try {
      await withTimeout(
        set(push(ref(db, PATHS.reminders)), {
          ...check.value,
          status: REMINDER_STATUS.SCHEDULED,
          created_at: serverTimestamp(),
          created_by: ISSUER
        }),
        10 * 1000,
        "Firebase did not confirm in time."
      );
      statusEl.textContent = `Saved for ${fmt.chennaiDateTime(check.value.due_at)} IST.`;
      titleInput.value = "";
      messageInput.value = "";
      setDefaultDateTime();
    } catch (err) {
      statusEl.textContent = `Not saved: ${err.message}`;
    } finally {
      delete submitButton.dataset.busy;
      app.refreshControls();
    }
  });

  /* ------------------------------------------------------------------ */
  /* List                                                                */
  /* ------------------------------------------------------------------ */
  function describe(r, now) {
    if (r.status === REMINDER_STATUS.ACKNOWLEDGED) return ["Done", "ok"];
    if (r.status === REMINDER_STATUS.CANCELLED) return ["Cancelled", "muted"];
    if (r.due_at > now) return ["Upcoming", "info"];
    if (now - r.due_at <= REMINDER_SHOW_WINDOW_MS) return ["Due now", "warn"];
    return ["Missed", "bad"];
  }

  function cancelReminder(id) {
    return runTransaction(ref(db, `${PATHS.reminders}/${id}`), (current) => {
      if (current === null) return null;
      if (!isPlainObject(current) || (current.status && current.status !== REMINDER_STATUS.SCHEDULED)) return undefined;
      return { ...current, status: REMINDER_STATUS.CANCELLED, cancelled_at: serverTimestamp() };
    });
  }

  function renderRow(r, now) {
    const [label, tone] = describe(r, now);
    const meta = [`${fmt.chennaiDateTime(r.due_at)} IST`];
    if (r.status === REMINDER_STATUS.ACKNOWLEDGED && r.acknowledged_at) {
      meta.push(`done on the ${r.acknowledged_by || "tablet"} at ${fmt.chennaiTime(r.acknowledged_at)} IST`);
    }

    const actions = h("div", { class: "row-actions" });
    if (r.status === REMINDER_STATUS.SCHEDULED) {
      actions.append(h("button", {
        type: "button", class: "btn btn-small btn-ghost", "data-needs-connection": "", text: "Cancel",
        onclick: (e) => {
          e.currentTarget.disabled = true;
          cancelReminder(r.id).catch((err) => toast(`Could not cancel: ${err.message}`, "error"));
        }
      }));
    } else {
      actions.append(h("button", {
        type: "button", class: "btn btn-small btn-ghost", "data-needs-connection": "", text: "Remove",
        onclick: (e) => {
          if (!window.confirm(`Remove the reminder “${r.title}”?`)) return;
          e.currentTarget.disabled = true;
          remove(ref(db, `${PATHS.reminders}/${r.id}`)).catch((err) => toast(`Could not remove: ${err.message}`, "error"));
        }
      }));
    }

    return h("li", { class: "list-row" },
      h("div", { class: "list-main" },
        badge(label, tone),
        h("span", { class: "list-title", text: r.title })
      ),
      r.message ? h("div", { class: "list-text", text: r.message }) : null,
      h("div", { class: "list-meta", text: meta.join(" · ") }),
      actions
    );
  }

  let reminders = [];

  function renderList() {
    const now = serverNow();
    const scheduled = reminders.filter((r) => r.status === REMINDER_STATUS.SCHEDULED).sort((a, b) => a.due_at - b.due_at);
    const others = reminders.filter((r) => r.status !== REMINDER_STATUS.SCHEDULED).sort((a, b) => b.due_at - a.due_at);
    const rows = [...scheduled, ...others].map((r) => renderRow(r, now));
    listEl.replaceChildren(...(rows.length ? rows : [h("li", { class: "empty", text: "No reminders yet." })]));
    app.refreshControls();
  }

  onValue(
    query(ref(db, PATHS.reminders), orderByKey(), limitToLast(REMINDER_WINDOW)),
    (snap) => {
      const list = [];
      snap.forEach((child) => {
        const r = normalizeReminder(child.key, child.val());
        if (r) list.push(r);
      });
      reminders = list;
      renderList();
    },
    (err) => app.listenFailed("reminders", err)
  );

  // Upcoming → Due now → Missed changes with time alone.
  setInterval(renderList, 60 * 1000);
}
