/*
 * Chennai Control — sending commands and showing their lifecycle.
 *
 * A command is written once as "pending"; only the tablet moves it
 * forward (processing → completed/failed/expired). Chennai Control may
 * only cancel a command that is still pending, via a transaction.
 */

import {
  ref, onValue, set, update, push, get, query, orderByKey, limitToFirst, limitToLast,
  runTransaction, serverTimestamp, serverNow
} from "../core/firebase.js";
import { APP_VERSION, PATHS, ISSUER, COMMAND_MAX_TTL_MS, LIMITS } from "../core/config.js";
import {
  COMMAND_TYPES, COMMAND_STATUS, TERMINAL_STATUSES, commandDef, isPlainObject, isFiniteNumber, clamp, cleanText
} from "../core/schema.js";
import { formatDuration, formatWhen } from "../core/time.js";
import { h, badge, relTime, toast, withTimeout } from "./dom.js";

const ACTIVITY_SIZE = 20;
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STATUS_LOOK = {
  pending: ["Waiting", "warn"],
  processing: ["Running", "info"],
  completed: ["Done", "ok"],
  failed: ["Failed", "bad"],
  expired: ["Expired", "muted"],
  cancelled: ["Cancelled", "muted"]
};

export function initCommands(app) {
  const { db } = app;
  const listEl = document.getElementById("activity-list");
  const watchers = new Map(); // command id → callback(command)

  /* ------------------------------------------------------------------ */
  /* Sending                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Validate and write a new pending command. Resolves to its id.
   * expires_at is computed from the server-corrected clock *at the moment
   * of sending*, so a write that is delayed in transit arrives already
   * expired instead of running late.
   */
  async function sendCommand(type, payload, ttlMs) {
    const def = commandDef(type);
    if (!def) throw new Error(`Unknown command type ${type}`);
    const check = def.validate(payload);
    if (!check.ok) throw new Error(check.message);
    if (!app.connected) throw new Error("Not connected to Firebase — try again when online.");

    const ttl = clamp(Number(ttlMs) || def.defaultTtlMs, 10 * 1000, COMMAND_MAX_TTL_MS);
    const commandRef = push(ref(db, PATHS.commands)); // unique, time-ordered id
    const record = {
      type,
      status: COMMAND_STATUS.PENDING,
      created_at: serverTimestamp(),
      expires_at: Math.round(serverNow() + ttl),
      issued_by: ISSUER,
      issuer_version: APP_VERSION
    };
    if (Object.keys(check.value).length) record.payload = check.value;

    await withTimeout(set(commandRef, record), 10 * 1000, "Firebase did not confirm the command in time.");
    return commandRef.key;
  }

  /** Call `onChange(command)` whenever command `id` changes (until final). */
  function watchCommand(id, onChange) {
    watchers.set(id, onChange);
  }

  app.sendCommand = sendCommand;
  app.watchCommand = watchCommand;

  /* ------------------------------------------------------------------ */
  /* Message form                                                        */
  /* ------------------------------------------------------------------ */
  const form = document.getElementById("message-form");
  const titleInput = document.getElementById("msg-title");
  const textInput = document.getElementById("msg-text");
  const countEl = document.getElementById("msg-count");
  const durationInput = document.getElementById("msg-duration");
  const ttlInput = document.getElementById("msg-ttl");
  const statusEl = document.getElementById("msg-status");
  const sendButton = document.getElementById("msg-send");

  titleInput.maxLength = LIMITS.messageTitle;
  textInput.maxLength = LIMITS.messageText;
  const updateCount = () => {
    countEl.textContent = `${Array.from(textInput.value).length} / ${LIMITS.messageText}`;
  };
  textInput.addEventListener("input", updateCount);
  updateCount();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      title: titleInput.value,
      text: textInput.value,
      duration_s: Number(durationInput.value)
    };
    if (!cleanText(payload.text, LIMITS.messageText, { multiline: true })) {
      statusEl.textContent = "Please write a message first.";
      textInput.focus();
      return;
    }

    sendButton.dataset.busy = "true";
    app.refreshControls();
    statusEl.textContent = "Sending…";
    try {
      const id = await sendCommand("SHOW_MESSAGE", payload, Number(ttlInput.value));
      statusEl.textContent = "Sent — waiting for the tablet…";
      form.reset();
      updateCount();
      watchCommand(id, (cmd) => {
        statusEl.textContent = describeForForm(cmd);
      });
    } catch (err) {
      statusEl.textContent = err.message;
      toast(`Message not sent: ${err.message}`, "error");
    } finally {
      delete sendButton.dataset.busy;
      app.refreshControls();
    }
  });

  function describeForForm(cmd) {
    switch (cmd.status) {
      case COMMAND_STATUS.PROCESSING: return "The tablet is showing it now…";
      case COMMAND_STATUS.COMPLETED: return `Shown on the tablet at ${formatWhen(cmd.finished_at || serverNow())}.`;
      case COMMAND_STATUS.EXPIRED: return "Not delivered: the tablet didn't pick it up in time.";
      case COMMAND_STATUS.CANCELLED: return "Cancelled.";
      case COMMAND_STATUS.FAILED: return `Failed: ${(cmd.error && cmd.error.message) || "unknown error"}`;
      default: return "Sent — waiting for the tablet…";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Refresh portal                                                      */
  /* ------------------------------------------------------------------ */
  document.getElementById("refresh-portal").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!window.confirm("Reload the Chennai Portal page on the tablet?\n\nUse this after deploying a new version. The screen goes blank for a moment.")) return;
    button.dataset.busy = "true";
    app.refreshControls();
    try {
      const id = await sendCommand("REFRESH_PORTAL", {}, COMMAND_TYPES.REFRESH_PORTAL.defaultTtlMs);
      toast("Refresh sent — see Activity for the result.");
      watchCommand(id, (cmd) => {
        if (cmd.status === COMMAND_STATUS.COMPLETED) toast("The tablet is reloading.", "ok");
        else if (cmd.status === COMMAND_STATUS.FAILED) toast(`Refresh failed: ${(cmd.error && cmd.error.message) || "unknown error"}`, "error");
        else if (cmd.status === COMMAND_STATUS.EXPIRED) toast("Refresh expired: the tablet didn't respond.", "error");
      });
    } catch (err) {
      toast(`Refresh not sent: ${err.message}`, "error");
    } finally {
      delete button.dataset.busy;
      app.refreshControls();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Activity list                                                       */
  /* ------------------------------------------------------------------ */
  function cancelCommand(id) {
    return runTransaction(ref(db, `${PATHS.commands}/${id}`), (current) => {
      if (current === null) return null;
      if (!isPlainObject(current) || current.status !== COMMAND_STATUS.PENDING) return undefined;
      return { ...current, status: COMMAND_STATUS.CANCELLED, finished_at: serverTimestamp(), cancelled_by: ISSUER };
    }).then((result) => {
      if (!result.committed) toast("Too late — the tablet already picked it up.");
    });
  }

  function summaryOf(cmd) {
    const def = commandDef(cmd.type);
    return def && def.summarize ? def.summarize(cmd.payload) : "";
  }

  function detailOf(cmd, now) {
    const parts = [];
    const tookMs = isFiniteNumber(cmd.claimed_at) && isFiniteNumber(cmd.created_at) ? cmd.claimed_at - cmd.created_at : null;

    if (cmd.status === COMMAND_STATUS.PENDING) {
      if (isFiniteNumber(cmd.expires_at) && now >= cmd.expires_at) parts.push("Not picked up before it expired");
      else parts.push("Waiting for the tablet");
    } else if (cmd.status === COMMAND_STATUS.PROCESSING) {
      parts.push("The tablet is running it");
    } else if (cmd.status === COMMAND_STATUS.COMPLETED) {
      if (tookMs !== null) parts.push(`Picked up in ${formatDuration(tookMs)}`);
      if (isPlainObject(cmd.result) && cmd.result.detail) parts.push(cleanText(cmd.result.detail, 120));
      if (isPlainObject(cmd.result) && cmd.result.closed_by) {
        const how = { tap: "closed by tapping OK", timeout: "closed after its time ran out", replaced: "replaced by a newer message" };
        const reason = cmd.result.closed_by;
        parts.push(typeof reason === "string" && Object.prototype.hasOwnProperty.call(how, reason) ? how[reason] : "closed");
      }
    } else if (isPlainObject(cmd.error)) {
      parts.push(cleanText(cmd.error.message, LIMITS.errorMessage) || cleanText(cmd.error.code, 40));
    }
    return parts.join(" · ");
  }

  function renderRow(id, cmd, now) {
    const known = typeof cmd.status === "string" && Object.prototype.hasOwnProperty.call(STATUS_LOOK, cmd.status);
    let [label, tone] = known ? STATUS_LOOK[cmd.status] : ["Unknown", "muted"];
    const pendingExpired = cmd.status === COMMAND_STATUS.PENDING && isFiniteNumber(cmd.expires_at) && now >= cmd.expires_at;
    if (pendingExpired) [label, tone] = ["Not delivered", "muted"];

    const def = commandDef(cmd.type);
    const typeLabel = def ? def.label : cleanText(String(cmd.type), 40) || "Unknown";
    const summary = summaryOf(cmd);
    const created = isFiniteNumber(cmd.created_at) ? cmd.created_at : null;

    const row = h("li", { class: "activity-row", dataset: { status: known ? cmd.status : "unknown" } },
      h("div", { class: "activity-main" },
        badge(label, tone),
        h("span", { class: "activity-type", text: typeLabel }),
        summary ? h("span", { class: "activity-summary", text: summary }) : null,
        created ? h("span", { class: "activity-time" }, relTime(created, formatWhen(created))) : null
      ),
      h("div", { class: "activity-detail", text: detailOf(cmd, now) })
    );

    if (cmd.status === COMMAND_STATUS.PENDING && !pendingExpired) {
      row.append(h("button", {
        type: "button",
        class: "btn btn-small btn-ghost",
        "data-needs-connection": "",
        text: "Cancel",
        onclick: (event) => {
          event.currentTarget.disabled = true;
          cancelCommand(id).catch((err) => toast(`Could not cancel: ${err.message}`, "error"));
        }
      }));
    }
    return row;
  }

  let lastSnapshot = null;

  function renderList() {
    if (!lastSnapshot) return;
    const now = serverNow();
    const rows = [];
    lastSnapshot.forEach((child) => {
      const cmd = child.val();
      if (!isPlainObject(cmd)) return;
      try {
        rows.push(renderRow(child.key, cmd, now));
      } catch (err) {
        // One odd record must never blank the whole list.
        console.error("[Chennai Control] Could not render command", child.key, err);
        rows.push(h("li", { class: "activity-row", text: "Unreadable command record" }));
      }
    });
    rows.reverse(); // newest first
    listEl.replaceChildren(...(rows.length ? rows : [h("li", { class: "empty", text: "No commands yet." })]));
    app.refreshControls();
  }

  onValue(
    query(ref(db, PATHS.commands), orderByKey(), limitToLast(ACTIVITY_SIZE)),
    (snap) => {
      lastSnapshot = snap;
      renderList();
      snap.forEach((child) => {
        const watcher = watchers.get(child.key);
        const cmd = child.val();
        if (!watcher || !isPlainObject(cmd)) return;
        watcher(cmd);
        if (TERMINAL_STATUSES.has(cmd.status)) watchers.delete(child.key);
      });
    },
    (err) => app.listenFailed("commands", err)
  );

  // Pending rows turn into "Not delivered" once past expiry.
  setInterval(renderList, 30 * 1000);

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */
  document.getElementById("activity-cleanup").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.dataset.busy = "true";
    app.refreshControls();
    try {
      const snap = await get(query(ref(db, PATHS.commands), orderByKey(), limitToFirst(100)));
      const cutoff = serverNow() - CLEANUP_AGE_MS;
      const removals = {};
      snap.forEach((child) => {
        const cmd = child.val();
        const old = isPlainObject(cmd) && isFiniteNumber(cmd.created_at) && cmd.created_at < cutoff;
        const settled = isPlainObject(cmd) && (TERMINAL_STATUSES.has(cmd.status) ||
          (cmd.status === COMMAND_STATUS.PENDING && isFiniteNumber(cmd.expires_at) && cmd.expires_at < serverNow()));
        if (!isPlainObject(cmd) || (old && settled)) removals[child.key] = null;
      });
      const count = Object.keys(removals).length;
      if (!count) {
        toast("Nothing older than 7 days to clear.");
        return;
      }
      if (!window.confirm(`Delete ${count} finished command record${count > 1 ? "s" : ""} older than 7 days?`)) return;
      await update(ref(db, PATHS.commands), removals);
      toast(`Cleared ${count} old record${count > 1 ? "s" : ""}.`, "ok");
    } catch (err) {
      toast(`Cleanup failed: ${err.message}`, "error");
    } finally {
      delete button.dataset.busy;
      app.refreshControls();
    }
  });
}
