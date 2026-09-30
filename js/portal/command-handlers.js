/*
 * Chennai Portal — command handler registry (tablet side).
 *
 * Each entry:  TYPE: {
 *   validate(payload) → { ok, value } | { ok: false, code, message }
 *   run(value, meta)  → result object (or Promise). Throw CommandError to fail.
 *   timeoutMs?        → max run time (default 15 s)
 *   afterComplete?(value, meta) → runs only after "completed" is confirmed
 *                                 by the server (used for reloads)
 * }
 *
 * TO ADD A COMMAND:
 *   1. Add its payload validator to COMMAND_TYPES in js/core/schema.js
 *      (Chennai Control uses the same validator before sending).
 *   2. Add a handler below with the same TYPE name.
 *   Nothing else changes: the engine dispatches by name.
 *
 * DELIBERATELY NOT SUPPORTED: running code, shell commands, URLs to open,
 * or any device-level control. Handlers only drive this page's own UI.
 */

import { MODES, REFRESH_MIN_GAP_MS } from "../core/config.js";
import { COMMAND_TYPES } from "../core/schema.js";
import { CommandError } from "./command-engine.js";

/**
 * @param {{
 *   showMessage: (msg: object) => void,
 *   currentMode: () => string,
 *   writeDisplayMode: (mode: string, updatedBy: string) => Promise<void>,
 *   lastCommandReloadAt: () => number,
 *   siteReachable: () => Promise<boolean>,
 *   reloadForCommand: (commandId: string) => void
 * }} ctx
 */
export function createCommandHandlers(ctx) {
  return {
    /* Show a temporary message card on the tablet. */
    SHOW_MESSAGE: {
      validate: COMMAND_TYPES.SHOW_MESSAGE.validate,
      run(message, meta) {
        ctx.showMessage({ id: meta.id, sentAt: meta.created_at, ...message });
        return { detail: "Shown on the tablet", duration_s: message.duration_s, mode: ctx.currentMode() };
      }
    },

    /* Change the display mode — by updating the shared display state, so
       the persistent "desired mode" and the command never disagree. */
    SET_MODE: {
      validate: COMMAND_TYPES.SET_MODE.validate,
      timeoutMs: 10 * 1000,
      async run({ mode }, meta) {
        await ctx.writeDisplayMode(mode, `command:${meta.id}`);
        return { detail: `Switched to ${MODES[mode]}`, mode };
      }
    },

    /* Reload the tablet page (e.g. to pick up a new deployment).
       Loop protection:
         - the command is marked "completed" on the server BEFORE the reload,
           so the reloaded page can never pick it up again;
         - at most one command-triggered reload per REFRESH_MIN_GAP_MS;
         - no reload unless the site is reachable (a reload while offline
           would leave the tablet on a browser error page). */
    REFRESH_PORTAL: {
      validate: COMMAND_TYPES.REFRESH_PORTAL.validate,
      timeoutMs: 12 * 1000,
      async run() {
        const last = ctx.lastCommandReloadAt();
        if (last && Date.now() - last < REFRESH_MIN_GAP_MS) {
          throw new CommandError("rate_limited", "The portal was already refreshed less than 2 minutes ago.");
        }
        if (!(await ctx.siteReachable())) {
          throw new CommandError("site_unreachable", "The portal website isn't reachable from the tablet, so it was not reloaded.");
        }
        return { detail: "Reloading the portal" };
      },
      afterComplete(_value, meta) {
        ctx.reloadForCommand(meta.id);
      }
    }
  };
}
