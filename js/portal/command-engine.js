/*
 * Chennai Portal — command engine (tablet side).
 *
 * LIFECYCLE (see BUILD_NOTES.md for the full description)
 *
 *   pending ──claim (transaction)──► processing ──► completed
 *      │                                  │
 *      │                                  └──────► failed   (handler error / timeout /
 *      │                                                     interrupted by a reload)
 *      ├──(already past expires_at)────────────────► expired
 *      ├──(malformed / unsupported type)───────────► failed
 *      └──(withdrawn by Chennai Control)───────────► cancelled
 *
 * GUARANTEES
 *   - At most once: a command runs only after this tablet session wins a
 *     Firebase transaction that moves it from "pending" to "processing".
 *     A second tab, a reconnect or a page reload cannot run it again.
 *   - Never stale: expiry is checked INSIDE that transaction, against the
 *     server-corrected clock, at the moment of claiming. A command that
 *     arrives after its expires_at is marked "expired" and never runs —
 *     including after long Wi-Fi outages.
 *   - Bounded: the tablet only listens to the newest COMMAND_WINDOW
 *     commands (orderByKey + limitToLast), never the whole history.
 *   - Sequential: commands run one at a time, in arrival order.
 *
 * Handlers are looked up in a registry object (see command-handlers.js),
 * so adding a command never touches this file.
 */

import {
  ref, onValue, update, query, orderByKey, limitToLast, runTransaction,
  serverTimestamp, serverNow
} from "../core/firebase.js";
import {
  APP_VERSION, PATHS, COMMAND_WINDOW, COMMAND_MAX_TTL_MS, COMMAND_STALE_CLAIM_MS
} from "../core/config.js";
import {
  COMMAND_STATUS, isPlainObject, isFiniteNumber, errorInfo, sanitizeResult, cleanText
} from "../core/schema.js";

/** Throw this from a handler for a clean, user-readable failure. */
export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

const DEFAULT_HANDLER_TIMEOUT_MS = 15 * 1000;
const FINISH_CONFIRM_TIMEOUT_MS = 8 * 1000;
const RESCAN_EVERY_MS = 60 * 1000;
const CLOCK_ALLOWANCE_MS = 60 * 1000; // tolerance when sanity-checking expiry

const { PENDING, PROCESSING, COMPLETED, FAILED, EXPIRED } = COMMAND_STATUS;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CommandError("timeout", "The tablet took too long to run this command.")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function toErrorInfo(err) {
  if (err instanceof CommandError) return errorInfo(err.code, err.message);
  console.error("[Commands] Handler threw:", err);
  return errorInfo("handler_error", "Unexpected error while running the command on the tablet.");
}

/**
 * @param {{
 *   db: object,
 *   sessionId: string,               // this page load
 *   previousSessionId: string|null,  // the page load before this one (same browser)
 *   handlers: Record<string, { validate, run, timeoutMs?, afterComplete? }>,
 *   onStatus?: (info: { id, type, status, error_code? }) => void,
 *   onError?: (area: string, code: string) => void
 * }} opts
 */
export function startCommandEngine({ db, sessionId, previousSessionId, handlers, onStatus, onError }) {
  const commandsQuery = query(ref(db, PATHS.commands), orderByKey(), limitToLast(COMMAND_WINDOW));

  let finished = new Set();  // ids with nothing left to do in this session
  const queued = new Set();  // ids waiting in / running through the queue
  let queue = Promise.resolve();
  let latest = null;         // most recent snapshot of the window

  const hasHandler = (type) => typeof type === "string" && Object.prototype.hasOwnProperty.call(handlers, type);

  function report(id, cmd) {
    if (!onStatus || !isPlainObject(cmd)) return;
    const info = { id, type: cleanText(cmd.type, 40) || "unknown", status: cmd.status };
    if (isPlainObject(cmd.error) && cmd.error.code) info.error_code = cleanText(cmd.error.code, 40);
    onStatus(info);
  }

  /* --- Deciding what to do with a command --------------------------- */

  // Pure: what should happen to a pending command right now?
  function assess(cmd, now) {
    if (!isFiniteNumber(cmd.created_at) || !isFiniteNumber(cmd.expires_at)) {
      return { status: FAILED, error: errorInfo("bad_envelope", "Command is missing created_at or expires_at.") };
    }
    if (cmd.expires_at - cmd.created_at > COMMAND_MAX_TTL_MS + CLOCK_ALLOWANCE_MS) {
      return { status: FAILED, error: errorInfo("bad_expiry", "Command expiry is further ahead than allowed.") };
    }
    if (now >= cmd.expires_at) {
      return { status: EXPIRED, error: errorInfo("expired", "Expired before the tablet could run it.") };
    }
    if (!hasHandler(cmd.type)) {
      const type = cleanText(String(cmd.type), 40);
      return { status: FAILED, error: errorInfo("unsupported_type", `Portal ${APP_VERSION} does not support "${type}".`) };
    }
    const check = handlers[cmd.type].validate(cmd.payload);
    if (!check.ok) return { status: FAILED, error: errorInfo(check.code, check.message) };
    return { status: PROCESSING };
  }

  function isAbandoned(cmd) {
    if (cmd.claimed_by === sessionId) return false;
    if (previousSessionId && cmd.claimed_by === previousSessionId) return true; // we reloaded mid-command
    const since = isFiniteNumber(cmd.claimed_at) ? cmd.claimed_at : cmd.created_at;
    return !isFiniteNumber(since) || serverNow() - since > COMMAND_STALE_CLAIM_MS;
  }

  function consider(id, cmd) {
    if (finished.has(id) || queued.has(id)) return;
    if (!isPlainObject(cmd)) {
      finished.add(id);
      return;
    }
    if (cmd.status === PENDING) enqueue(id, () => processCommand(id));
    else if (cmd.status === PROCESSING) {
      // Owned by another live session: leave it; re-checked on the next scan.
      if (isAbandoned(cmd)) enqueue(id, () => recoverAbandoned(id, cmd.claimed_by));
    } else {
      finished.add(id); // terminal (or unknown) status: never touched again
    }
  }

  function enqueue(id, job) {
    queued.add(id);
    queue = queue
      .then(job)
      .then(
        () => finished.add(id),
        (err) => {
          // e.g. the claim transaction was rejected. Not marked finished, so
          // the next scan (≤ 60 s) tries again; expiry still applies then.
          console.error(`[Commands] ${id} failed inside the engine:`, err);
          if (onError) onError("commands", (err && err.code) || "engine_error");
        }
      )
      .then(() => queued.delete(id));
  }

  /* --- Processing ----------------------------------------------------- */

  async function processCommand(id) {
    const cmdRef = ref(db, `${PATHS.commands}/${id}`);

    // 1. CLAIM. Runs against the server's copy; retried by Firebase if
    //    anything else changed the command in the meantime. While offline,
    //    Firebase holds the transaction until the connection returns — and
    //    expiry is (re)checked at that point.
    const tx = await runTransaction(cmdRef, (current) => {
      if (current === null) return null; // not in local cache yet: let the server answer
      if (!isPlainObject(current) || current.status !== PENDING) return undefined; // abort

      const verdict = assess(current, serverNow());
      const next = { ...current, status: verdict.status, claimed_by: sessionId, claimed_at: serverTimestamp() };
      if (verdict.error) {
        next.error = verdict.error;
        next.finished_at = serverTimestamp();
      }
      return next;
    }, { applyLocally: false });

    const claimed = tx.snapshot.val();
    if (!tx.committed || !isPlainObject(claimed) || claimed.claimed_by !== sessionId) return; // not ours
    report(id, claimed);
    if (claimed.status !== PROCESSING) return; // expired / invalid: finalised in the claim

    // 2. RUN the handler (re-validating the exact copy we claimed).
    const handler = handlers[claimed.type];
    const check = handler.validate(claimed.payload);
    if (!check.ok) {
      await finish(cmdRef, id, claimed, { status: FAILED, error: errorInfo(check.code, check.message) });
      return;
    }
    const meta = { id, created_at: claimed.created_at, issued_by: claimed.issued_by };

    let result;
    try {
      result = await withTimeout(
        Promise.resolve().then(() => handler.run(check.value, meta)),
        handler.timeoutMs || DEFAULT_HANDLER_TIMEOUT_MS
      );
    } catch (err) {
      await finish(cmdRef, id, claimed, { status: FAILED, error: toErrorInfo(err) });
      return;
    }

    // 3. ACKNOWLEDGE the result.
    const confirmed = await finish(cmdRef, id, claimed, { status: COMPLETED, result: sanitizeResult(result) });

    // 4. Optional follow-up (e.g. reload) — only once the server has the
    //    "completed" status, so the follow-up can never cause a re-run.
    if (handler.afterComplete) {
      if (confirmed) handler.afterComplete(check.value, meta);
      else {
        await finish(cmdRef, id, claimed, {
          status: FAILED,
          error: errorInfo("ack_timeout", "Could not confirm with the server, so the follow-up action was skipped.")
        });
      }
    }
  }

  /** Write the final status; resolves true if the server confirmed it in time. */
  async function finish(cmdRef, id, claimed, fields) {
    const write = update(cmdRef, { ...fields, finished_at: serverTimestamp() });
    report(id, { ...claimed, ...fields });
    return Promise.race([
      write.then(() => true, (err) => {
        console.error(`[Commands] Could not write result for ${id}:`, err);
        if (onError) onError("commands", "result_write_failed");
        return false;
      }),
      delay(FINISH_CONFIRM_TIMEOUT_MS).then(() => false)
    ]);
  }

  /** A command left in "processing" by a page that is gone. */
  async function recoverAbandoned(id, claimedBy) {
    const cmdRef = ref(db, `${PATHS.commands}/${id}`);
    const tx = await runTransaction(cmdRef, (current) => {
      if (current === null) return null;
      if (!isPlainObject(current) || current.status !== PROCESSING || current.claimed_by !== claimedBy) return undefined;
      return {
        ...current,
        status: FAILED,
        error: errorInfo("interrupted", "The portal stopped before this command finished; its outcome is unknown."),
        finished_at: serverTimestamp(),
        recovered_by: sessionId
      };
    }, { applyLocally: false });
    if (tx.committed && tx.snapshot.exists()) report(id, tx.snapshot.val());
  }

  /* --- Listening ------------------------------------------------------ */

  function scan() {
    if (!latest) return;
    latest.forEach((child) => {
      consider(child.key, child.val());
    });

    // Forget ids that have left the window so the set stays small.
    if (finished.size > COMMAND_WINDOW * 4) {
      const keep = new Set();
      latest.forEach((child) => {
        if (finished.has(child.key)) keep.add(child.key);
      });
      finished = keep;
    }
  }

  onValue(
    commandsQuery,
    (snap) => {
      latest = snap;
      scan();
    },
    (err) => {
      console.error("[Commands] Listener cancelled:", err);
      if (onError) onError("commands", err.code || "listen_failed");
    }
  );

  // Picks up commands abandoned by another session that died.
  setInterval(scan, RESCAN_EVERY_MS);
}
