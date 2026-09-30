# Chennai Portal — V0.2 build notes (`0.2.0-dev`)

Built on top of the tagged, hardware-verified baseline **`v0.1-cloud-baseline`**
(untouched). Same architecture: plain HTML/CSS/vanilla JS, browser ES modules,
Firebase Web SDK 12.19.0 from Google's CDN, no build step, no npm, served as
static files by Cloudflare Workers Static Assets.

**Nothing has been committed, tagged, pushed or deployed.** All changes are in
the working tree for human review.

---

## HANDOFF TO CHATGPT

**What this is:** V0.1 proved *admin → Firebase → tablet*. V0.2 turns it into the
real application shell: photo-frame Home, useful Good Morning, night-safe Good
Night, a command engine with expiry and acknowledgement, safe remote messages,
reminder foundations, device health telemetry, and a real Chennai Control
dashboard.

**Audit these first (highest risk / most logic):**
1. `js/portal/command-engine.js`: claim transaction, expiry, at-most-once, recovery.
2. `js/core/schema.js`: all validation of untrusted Firebase data.
3. `js/portal/sync.js`: every Firebase read/write the tablet makes.
4. `js/portal/slideshow.js`: memory and "never blank" behaviour.
5. `.assetsignore`: **new deployment-affecting file** (see "Needs human attention").

**Key decisions:**
- Commands live under `devices/chennai-tablet/commands/` (per device, so future
  Security Rules stay simple), not a global `/commands`.
- Expiry is anchored in server time. `created_at` is a server timestamp.
  `expires_at` is computed by Chennai Control from Firebase's server-time
  offset *at the moment of sending*, so a write delayed in transit arrives
  already expired. The tablet checks expiry inside the claim transaction, never
  from a stale snapshot.
- At-most-once, not at-least-once. A command interrupted mid-run (for example,
  the page reloaded) is marked `failed / interrupted` rather than retried.
- Display mode stays **desired state** (`display/mode`, V0.1 path, applies
  whenever the tablet reconnects). `SET_MODE` is the *acknowledged* alternative
  and writes the same state.
- The tablet loads Firebase with a dynamic `import()`, so the clock and photo
  frame work even when the Firebase CDN is unreachable.
- The heartbeat is unchanged (60 s, 150 s stale). Added: server-side
  `onDisconnect`, so Chennai Control shows **Offline** immediately when the
  tablet's connection drops.
- Weather and AQI come from **Open-Meteo** (keyless, CORS-enabled, free for
  non-commercial use) behind a provider interface. AQI is labelled
  *"US AQI · modelled estimate"* because it isn't India's CPCB station data.

**Verify during review:**
- On the deployed site: `/.git/config`, `/BUILD_NOTES.md` and `/wrangler.jsonc`
  should return **404** after this deploy. Before this change they may have been
  public, because `assets.directory` is `"."`.
- `curl -I https://<site>/js/portal/main.js` should **not** show a long `max-age`
  (mixed old/new modules after a deploy would be bad).
- **First V0.2 deploy: reload the tablet once by hand.** V0.1 has no
  `REFRESH_PORTAL`; from V0.2 on, Chennai Control → *Refresh portal* works.
- Run the manual test plan below on the real SM-T510. Claude only tested in a
  desktop Chromium (Chrome 152, macOS) at 1280×800 and at phone width.

**State of the dev Firebase after Claude's testing:** restored to exactly its
pre-test contents (`display = {mode: "home", updated_at: 1790540114837}`,
`presence.last_seen = 1790541380884`). All test commands, reminders, content
and health records were deleted.

---

## 1. What changed

### New files

| File | Purpose |
|---|---|
| `js/core/config.js` | `APP_VERSION = "0.2.0-dev"`, device ID, **all DB paths**, timings, limits, Chennai location. No Firebase import (safe to load offline). |
| `js/core/firebase.js` | The only place with the Firebase config and SDK URL. `connect()` (the future Auth hook), SDK re-exports, `serverNow()` (server-corrected clock). |
| `js/core/schema.js` | Validation and normalisation of all remote data; command type registry with validators (shared by admin and tablet); safe lookups (`commandDef`). |
| `js/core/time.js` | Chennai-time (IST) arithmetic and formatters. |
| `js/portal/main.js` | Tablet entry: boot order, clock, modes, overlays, photo-source selection, Firebase loader with retry, network probes. |
| `js/portal/sync.js` | All tablet ↔ Firebase traffic: connection, presence, health, listeners, reminder ack, starts the command engine. |
| `js/portal/command-engine.js` | Command lifecycle (claim/expire/run/acknowledge/recover). |
| `js/portal/command-handlers.js` | Handler registry: `SHOW_MESSAGE`, `SET_MODE`, `REFRESH_PORTAL`. |
| `js/portal/slideshow.js` | Two-layer crossfade photo engine plus bundled manifest loader. |
| `js/portal/weather.js` | Weather/AQI provider interface, Open-Meteo provider, Good Morning panels. |
| `js/portal/overlays.js` | Message overlay; reminder overlay and the "Today" list. |
| `js/admin/main.js` | Chennai Control entry: connection, Overview (health), Display, section nav. |
| `js/admin/commands.js` | Sending commands, Message form, Refresh, Activity list, cancel, cleanup. |
| `js/admin/reminders.js` | Reminder create, list, cancel, remove (IST). |
| `js/admin/content.js` | Photo-frame settings, custom photo list, bundled preview, morning note. |
| `js/admin/dom.js` | Tiny DOM helpers (`h()` builds elements with text only), toast, banner, live relative times. |
| `css/portal.css` | Tablet styles. |
| `css/control.css` | Chennai Control styles (light and dark). |
| `photos/manifest.json` | Bundled photo list (edit this to add family photos). |
| `photos/placeholder/*.svg` | 5 original, lightweight placeholder artworks (≈3 KB each), clearly captioned "Placeholder". |
| `.assetsignore` | Stops Cloudflare publishing `.git`, `*.md`, `wrangler.jsonc`, etc. |
| `BUILD_NOTES.md` | This file. |

### Modified files
- `index.html`: rebuilt as three screens (Home, Morning, Night), two overlays,
  a status indicator and an inline icon sprite. Boot watchdog kept, and it now
  also runs a fallback clock.
- `admin.html`: rebuilt as the Chennai Control dashboard (Overview, Display,
  Message, Reminders, Photo frame, Activity, Intercom placeholder).

### Deleted files (superseded; still in the `v0.1-cloud-baseline` tag)
- `js/firebase-config.js` → `js/core/firebase.js` + `js/core/config.js`
- `js/display.js` → `js/portal/*`
- `js/admin.js` → `js/admin/*`
- `css/styles.css` → `css/portal.css` + `css/control.css`

### Unchanged
- `wrangler.jsonc`

---

## 2. Architecture

```
Chennai Control (admin.html)                  Chennai Portal (index.html, tablet)
 js/admin/main.js ──┐                           js/portal/main.js   ← owns the screen; no Firebase
 js/admin/commands.js│  writes desired state,     ├ slideshow.js, weather.js, overlays.js
 js/admin/reminders.js│ commands, reminders,      └ import("./sync.js")  ← dynamic: CDN failure ≠ dead screen
 js/admin/content.js ─┘ content                        ├ command-engine.js + command-handlers.js
            │                                           └ (presence, health, listeners, acks)
            └────────────► Firebase RTDB ◄──────────────┘
                     devices/chennai-tablet/…
 shared: js/core/config.js · firebase.js · schema.js · time.js
```

**Tablet boot order:**
1. The classic inline watchdog is armed. If the app's own scripts don't start
   within 15 s, it shows an error and runs a basic fallback clock.
2. `main.js` starts the clock and restores the **last mode from
   `localStorage`** (so a reload at night doesn't flash a bright photo). It
   starts the photo frame from `photos/manifest.json`.
3. `import("./sync.js")` loads the Firebase SDK:
   - On failure it shows "Offline · retrying" and tries again after 30 s.
   - It then polls every 60 s. Once **both** the site and the Firebase CDN are
     reachable, it reloads, at most once every 5 minutes. It never reloads into
     an offline error page.
4. `sync.js` attaches listeners, starts presence and health, and starts the
   command engine.

**Isolation:**
- Every Firebase listener callback is wrapped. A crash rendering one feature
  can't stop the others.
- A cancelled listener (e.g. `permission_denied`) turns the status indicator
  into "Sync error".
- In Chennai Control each section initialises separately. A failing section
  shows a banner, and the rest keep working.

**Adding Firebase Auth later:** `connect()` in `js/core/firebase.js` is awaited
by both apps before any listener is attached. Sign-in goes there. `ISSUER`
(`js/core/config.js`) then becomes the signed-in UID, which the rules can
enforce.

---

## 3. Firebase data model

Everything is under `devices/chennai-tablet/`. The V0.1 paths are unchanged and
still compatible.

```jsonc
{
  "display":  { "mode": "home|good_morning|good_night", "updated_at": 0, "updated_by": "chennai-control | command:<id>" },
  "presence": { "last_seen": 0 },                       // tablet heartbeat, every 60 s (V0.1)

  "health": {                                            // tablet telemetry, written on events only
    "app_version": "0.2.0-dev", "session_id": "a1b2c3d4e5f6", "session_started_at": 0,
    "connection": { "state": "online|offline", "changed_at": 0 },   // "offline" written by Firebase onDisconnect
    "reconnects": 0, "active_mode": "home", "active_mode_at": 0, "visibility": "visible|hidden",
    "viewport": "1280×800", "pixel_ratio": 1.5, "orientation": "landscape",
    "browser": "Chrome 140 | Android WebView 140 | Samsung Internet 28", "os": "Android 11",
    "slideshow": { "source": "bundled|custom", "photos": 5, "custom_unusable": false },
    "last_command": { "id": "<pushId>", "type": "SHOW_MESSAGE", "status": "completed", "error_code": "…", "at": 0 },
    "last_error":   { "area": "weather|aqi|slideshow|commands|…", "code": "http_503", "at": 0 },
    "last_reload":  { "command_id": "<pushId>", "at": 0 },
    "updated_at": 0
  },

  "commands": {
    "<pushId>": {
      "type": "SHOW_MESSAGE | SET_MODE | REFRESH_PORTAL",
      "payload": { },                                    // per type, see §4
      "status": "pending|processing|completed|failed|expired|cancelled",
      "created_at": 0,                                   // SERVER timestamp (authoritative)
      "expires_at": 0,                                   // server-time estimate at send + TTL (≤ 1 h)
      "issued_by": "chennai-control", "issuer_version": "0.2.0-dev",
      "claimed_by": "<session_id>", "claimed_at": 0,     // set by the claim transaction
      "finished_at": 0,
      "result": { "detail": "…", "closed_by": "tap|timeout|replaced", "closed_at": 0 },   // on success
      "error":  { "code": "expired|unsupported_type|bad_payload|…", "message": "…" },     // on failure
      "recovered_by": "<session_id>", "cancelled_by": "chennai-control"
    }
  },

  "reminders": {
    "<pushId>": {
      "title": "…", "message": "…", "due_at": 0,         // due_at: epoch ms (entered in IST)
      "status": "scheduled|acknowledged|cancelled",
      "created_at": 0, "created_by": "chennai-control",
      "acknowledged_at": 0, "acknowledged_by": "tablet", "cancelled_at": 0
    }
  },

  "content": {
    "slideshow": {
      "interval_s": 20, "shuffle": false, "source": "bundled|custom", "updated_at": 0,
      "photos": { "<pushId>": { "src": "https://… or photos/…", "caption": "…", "added_at": 0 } }
    },
    "morning_note": { "text": "…", "from": "…", "updated_at": 0 }
  }
}
```

**Who writes what** (the basis for future Security Rules):

| Path | Chennai Control | Tablet | Firebase server |
|---|---|---|---|
| `display` | set mode | only via `SET_MODE` | |
| `presence` | | heartbeat | |
| `health` | | all fields | `connection` via onDisconnect |
| `commands/*` | create (`pending`); cancel (`pending → cancelled`); delete old | claim, result, `result/closed_*` | |
| `reminders/*` | create, cancel, remove | acknowledge (`scheduled → acknowledged`) | |
| `content/*` | all | | |

**Bounded listeners:** the tablet reads the newest **25** commands and the newest
**50** reminders (`orderByKey().limitToLast(N)`). Chennai Control shows the
newest 20 commands. No index is needed, because push keys are time-ordered.

---

## 4. Command lifecycle

```
Chennai Control ─ push() ─► pending ──claim transaction──► processing ──► completed
                              │   (checks, in order:)            │
                              │   envelope ok? expiry ≤ 1 h?     └──► failed (handler error / timeout)
                              │   not expired? handler exists?
                              │   payload valid?
                              ├──► expired     (claimed after expires_at: never runs)
                              ├──► failed      (bad_envelope / bad_expiry / unsupported_type / bad_payload)
                              └──► cancelled   (Chennai Control, only while still pending)
processing left by a dead page ──► failed / interrupted (recovered by the next session)
```

- **Unique IDs:** Firebase `push()` keys (time-ordered and collision-resistant).
- **Claim:** `runTransaction` on the command node, run against the *server's*
  copy. It sets `processing` + `claimed_by` + `claimed_at`, and only if the
  command is still `pending`. Only one tablet session can ever win this
  (verified with two portal tabs open at once).
- **Never stale:**
  - Expiry is evaluated inside that transaction with `serverNow()`.
  - While the tablet is offline, Firebase holds the transaction until it
    reconnects, then re-evaluates it. A command that expired during the
    outage becomes `expired` and never runs (verified).
  - Still-valid queued commands run on reconnect (verified).
- **Never twice:**
  - The engine only runs what it claimed in this session.
  - Terminal statuses are never touched.
  - A reload can't re-run anything, because the status is no longer `pending`.
- **Acknowledgement:**
  - The result or error is written back with `finished_at`.
  - `health/last_command` mirrors the latest outcome.
  - Chennai Control shows the pick-up latency, the result, and for messages
    whether and how the message was closed.
- **Handler timeouts:** 15 s by default (10 s for `SET_MODE`, 12 s for `REFRESH_PORTAL`).
- **Abandoned claims:** a command left in `processing` is recovered to `failed / interrupted` when either:
  - it was claimed by *the previous page load in the same tab* (`sessionStorage`, so other tabs are never confused), or
  - the claim is more than 2 min old.

  The engine re-scans every 60 s.
- **Errors** are short, non-sensitive codes and messages (≤ 200 characters).
  Unexpected exceptions are reported generically.
- **Registry:** to add a command, (1) add a validator to `COMMAND_TYPES` in
  `js/core/schema.js`, then (2) add a handler with the same name in
  `js/portal/command-handlers.js`. No `switch`, no engine change.
- **Not supported by design:** code execution, shell commands, opening URLs,
  device or OS control. Handlers only drive this page's own UI.

### Initial commands

| Type | Payload | Tablet behaviour | Default TTL |
|---|---|---|---|
| `SHOW_MESSAGE` | `{ text (1–400), title? (≤60), duration_s (10–1800, default 300) }` | Large card over any screen (dim red at night). OK button. Auto-closes. Text rendered with `textContent`, newlines kept. Closing annotates `result.closed_by`. | 10 min (UI: 2 min / 10 min / 1 h) |
| `SET_MODE` | `{ mode }` | Writes `display/mode` (the shared desired state) with `updated_by: "command:<id>"`. | 2 min |
| `REFRESH_PORTAL` | none | Refuses if another command-triggered reload happened < 2 min ago, or if the site isn't reachable (HEAD probe). Marks `completed` **and waits for server confirmation before reloading**, so it can never loop. The new page records `health.last_reload`. | 2 min |

---

## 5. Reminders

**A. Data and UI (built now)**
- Chennai Control:
  - Enter title, optional details, and date and time in **Chennai time (IST)**,
    whatever the admin's own time zone.
  - The list shows **Upcoming / Due now / Missed / Done / Cancelled**, with the
    acknowledgement time.
  - Actions: **Cancel** (a transaction, so it only applies while scheduled) and
    **Remove** (after confirmation).
- Tablet:
  - When a reminder is due, a large card with a **Done** button appears
    (dim red at night).
  - Tapping Done writes `acknowledged` via a transaction, so it can't override
    a cancellation.
  - Good Morning lists today's reminders.
- A due reminder is shown for up to **12 h** after its due time. After that
  it's "Missed".

**B. Reliable scheduling/notification: NOT built. Important limitation.**
- The tablet checks for due reminders with a 30-second timer **inside the web
  page**. It only works while the page is open, the browser is running it, and
  the tablet is powered on. Timers are throttled when the screen is off.
- There is **no sound, no Android notification, no wake-up, and no repeats**.
- Do not use this for anything safety-critical, such as medication, yet.
- A reliable version needs infrastructure outside this page: a server-side
  scheduler and an Android-level alarm or notification channel (see §14).

---

## 6. Photo frame (Home)

- **Engine:**
  - Two stacked `<img>` layers with an opacity crossfade (1.6 s). Nothing
    else animates.
  - At most **two decoded images** in memory.
  - A photo is revealed only after it has fully loaded and decoded. The
    decode wait is capped at 3 s so a screen-off stall can't mark good photos
    as broken.
  - The next photo is preloaded after each crossfade.
  - The photo frame pauses while the page is hidden (screen off) and while
    another mode is showing.
- **Never blank:**
  - Broken or slow photos (20 s timeout) are skipped and retried after 10 min.
  - If nothing loads, the current photo stays. If there has never been one, a
    CSS gradient shows under the clock.
  - If *every* photo in the custom list fails, the tablet falls back to the
    bundled photos, retries the custom list after 30 min, and reports
    `slideshow: custom_list_unusable` to health.
- **Readability:** static gradient scrims and text shadows under the clock
  and date.
- **Photo sources:**
  - `bundled` (default): `photos/manifest.json`. **To add family photos,** put
    JPEGs in `photos/` and list them there.
  - **Recommended photo size:** landscape, **≤ 1920×1200 px, ≤ 500 KB**
    (3 GB RAM). Optional per photo: `caption` and `position` (focal point,
    e.g. `"50% 30%"`).
  - `custom`: the list in `content/slideshow/photos`, managed from Chennai
    Control. Only `https://` or same-site paths are accepted; `javascript:`
    etc. are rejected. An empty custom list falls back to bundled.
- **Firebase-driven later:** the engine only needs `setPhotos([...])`. A future
  Storage- or R2-backed source only has to produce that list.
- **Settings:** interval (5–600 s, UI 10 s–5 min, default 20 s) and shuffle.
  - The placeholders are original SVG artworks (Marina dawn, temple tower,
    kolam, coconut palms, clock-tower station), each captioned
    "Placeholder · …".

---

## 7. Weather and AQI (Good Morning)

- **Provider interface** in `js/portal/weather.js`: `{ name, fetchWeather(loc), fetchAirQuality(loc) }`
  returning normalised objects with `null` for anything missing. **No value is
  ever invented.**
- **Open-Meteo** (no key, CORS `*`):
  - Current temperature, feels-like, humidity, condition (WMO code), high and
    low, rain chance, sunrise and sunset.
  - AQI shows US AQI plus PM2.5 and PM10 from the CAMS model, clearly labelled
    as a modelled estimate.
  - Attribution ("Open-Meteo.com") appears in the panel footers.
  - Licence: CC BY 4.0, free for non-commercial use.
- **Privacy:** only Chennai **city-centre** coordinates are sent (not an
  address). Open-Meteo sees the tablet's IP address.
- **Traffic:**
  - Fetches only while Good Morning is on screen.
  - Weather refreshes every 30 min and AQI every 60 min.
  - The last good result is cached in `localStorage` and shown instantly, for
    up to 6 h, with "Last updated … ago" once it's over 2 h old.
  - On failure it backs off (2 → 5 → 10 → 20 → 30 min) and shows "…unavailable
    right now · Will try again automatically".
- To switch provider, add another object with the same interface and pass it
  in `js/portal/main.js`.

---

## 8. Good Night

- Pure black background.
- The clock is dim dark red (`#640e0e`) and the date is fainter still
  (`#330808`).
- The status indicator is invisible while connected, and dim red only if
  there's a problem.
- Overlays (messages, reminders) switch to dim-red, low-luminance cards.
- No animation.
- **UI-level only:** the LCD backlight still emits light. Real dimming needs
  system brightness control (future kiosk work).

---

## 9. Device health and telemetry

- **Collected** (see §3): app version, a random per-page-load session ID,
  connection state and reconnect count, active mode, visibility, viewport, DPR,
  orientation, a **coarse** browser/OS label (e.g. "Chrome 140 · Android 11"),
  photo-frame source, the last command outcome, the last error (area + code
  only), and the last command-triggered reload.
- **Not collected:** location, device model, full user agent, identifiers,
  or any personal data.
- **Traffic:**
  - The heartbeat is unchanged: one small write every 60 s.
  - Health is written only on events: connect or reconnect, mode change,
    visibility change, resize (debounced 3 s), command outcome, and errors
    (the same area + code at most once every 5 min).
- **Chennai Control's Online / Offline / Unknown:**
  - **Unknown** if the admin browser is itself offline.
  - **Offline** if Firebase's `onDisconnect` recorded a disconnect after the
    last heartbeat.
  - Otherwise **Online** if `last_seen` is ≤ 150 s old by *server* time, else
    **Offline**.
- **Version mismatch:** Chennai Control warns when the tablet runs a different
  `app_version`, and says "Unknown (older than 0.2)" for a V0.1 tablet.
- **On the tablet:** tapping the tiny status dot shows version, connection,
  viewport and mode for 8 s.

---

## 10. Chennai Control

- **Overview:** status, last seen, what the tablet is *actually* showing
  compared with the desired mode, connection, version, uptime, screen,
  browser, last command, last problem, last reload, and the **Refresh portal**
  button.
- **Display:** Home, Good Morning and Good Night. Optionally *"Only switch if
  the tablet responds within 2 minutes"*, which sends `SET_MODE` instead of
  setting the state directly.
- **Message:** title, text (with a counter), how long to show it, and how long
  to keep trying to deliver it. Live status: sent → showing → shown → closed.
  Also the **Morning note**, which is persistent and shown on Good Morning.
- **Reminders:** a form and a list (§5).
- **Photo frame:** settings, what the tablet is really showing, the custom
  list, and a preview of the bundled photos.
- **Activity:** the 20 newest commands, with status badges, latency, results
  and errors. *Cancel* works while a command is pending. *Clear older than
  7 days* deletes only finished or expired records and asks for confirmation
  first.
- **Intercom & video calls:** a reserved placeholder. It states that the camera
  and microphone are never accessed and that a visible indicator will be
  mandatory.
- **Layout and accessibility:**
  - Responsive: two columns on desktop, one on phones, with a sticky header
    and section tabs.
  - 44 px touch targets and 16 px inputs (no iOS zoom).
  - Follows the system dark mode.
  - Every control that needs Firebase is disabled while offline.
  - Listener failures show a red banner.

---

## 11. Reliability behaviours

| Situation | Behaviour |
|---|---|
| Firebase disconnect/reconnect | Indicator "Offline · reconnecting". Presence is skipped while offline (no queued stale heartbeats). Health is re-announced on reconnect. Chennai Control shows Offline via onDisconnect. |
| Firebase SDK/CDN unreachable at boot | Clock, photo frame and last mode keep working. "Offline · retrying". Retries, then a guarded reload once online. |
| Missing data | Defaults everywhere (Home, bundled photos, 20 s, "Messages from the family will appear here"). |
| Unknown display mode | Tablet shows Home. Chennai Control explains "Unknown mode … the tablet shows Home". |
| Malformed or unknown command | `failed` with a code. The tablet never crashes. Non-object records are ignored. |
| Stale command | `expired` and never executed, including after long outages. |
| Duplicate / two tabs / reload | Claim transaction guarantees a single execution. |
| Page reload during processing | The next load (same tab) marks it `failed / interrupted`. Other sessions do so after 2 min. |
| Failed Firebase write | Reported to the console and to health `last_error`. Admin writes show a toast or inline error. |
| Weather provider down | Cached value (≤ 6 h) or "unavailable" with backoff. |
| Broken slideshow image | Skipped, retried later; the custom list falls back to bundled. |
| Slow network | 20 s image timeout, 12 s weather timeout, 10 s admin write confirmation, 6 s reachability probes. |
| Hostile keys (`"constructor"`, `"__proto__"`) | All lookups use own-property checks. Verified not to crash either app. |
| HTML or script in any text | Always rendered with `textContent` / `h()`. No `innerHTML` or `eval` anywhere. |

---

## 12. Security. READ THIS.

- **The RTDB is still in Test Mode.** Anyone who knows the database URL (it's
  in the public JS) can read and write *everything*: send messages to the
  family screen, change modes, add photo URLs, read reminders, delete data.
  `issued_by` is **not** authenticated. It's a label that rules will enforce
  later.
- No authentication or rules were attempted, as instructed. No secrets were
  added. The Firebase web `apiKey` is a public identifier.
- The client is structured for Auth (`connect()` hook, `ISSUER`, per-device
  paths, the "who writes what" table in §3). Security must come from **Firebase
  Auth + Security Rules**, never from the client.
- Treat reminders and messages as **non-private** until rules exist.
- Custom photo URLs make the tablet contact third-party hosts, which see its
  IP address.

---

## 13. Needs human attention or configuration

1. **Deployment (human):** deploy as usual.
   - `.assetsignore` is new. It excludes `.git`, `*.md`, `wrangler.jsonc`,
     `.DS_Store`, etc.
   - After deploy, confirm those paths return 404.
   - If `/.git/config` was reachable on the V0.1 deployment, the repository
     history was publicly downloadable; judge whether that matters.
2. **First V0.2 load on the tablet must be a manual reload.** V0.1 can't
   receive `REFRESH_PORTAL`.
3. **Cache headers:** confirm JS and CSS are served with `max-age=0` or
   revalidation (Workers Static Assets' default). Otherwise add a `_headers`
   file.
4. **Tablet time zone** must be IST. The clocks use the device's local time.
   Reminders are stored in absolute time and entered as IST.
5. **Family photos:** replace the placeholders (resize first).
6. **Firebase Auth + RTDB rules** (planned, with a human).
7. **Kiosk settings** (later milestone): keep the screen on, reload the page
   when the network returns, night brightness.

---

## 14. Manual test plan (on the real SM-T510 plus a phone/Mac)

Open `https://<site>/` on the tablet (landscape) and `https://<site>/admin.html` on a Mac and an iPhone.

**A. V0.1 fundamentals preserved**
1. Chennai Control shows **Connected**, and the tablet shows as **Online** within a few seconds. The version is `0.2.0-dev`.
2. Tap Home, Good Morning and Good Night. The tablet switches within about 1 s each time, and "Showing" in Chennai Control matches.
3. Close the tablet browser or turn off Wi-Fi. Chennai Control shows **Offline** almost immediately (or within 150 s at most). Reopen or reconnect and it's **Online** again.

**B. Photo frame (Home)**
4. Photos crossfade every 20 s with no flicker or blank frames. The clock and date are readable over light and dark photos.
5. Photo frame → set 10 s and Shuffle, then Save. The tablet follows within one interval.
6. Custom list → add `https://example.invalid/x.jpg`, choose "Custom list", then Save. The tablet keeps showing a photo, never blank. After the first failure, "On the tablet now: bundled photos … fell back" appears in Chennai Control. Remove the entry and switch back to Bundled afterwards.
7. Leave Home running for **at least 30 minutes**. It should stay smooth, not heat up noticeably, and not reload.

**C. Good Morning**
8. The weather and AQI panels fill in. The AQI footer says "modelled estimate", and the attribution shows.
9. Chennai Control → Morning note → save a note. It appears on Good Morning. Clear it and the placeholder text returns.
10. With Good Morning showing, turn off the tablet's Wi-Fi for 30+ minutes. The panels keep their last values with an "Updated …" time. Refresh attempts fail quietly and back off. "Unavailable" appears only when there's no cached value younger than 6 h. Numbers are never made up.

**D. Good Night**
11. In a dark room: black screen, dim red clock, no bright elements, and the status dot is invisible.

**E. Messages**
12. Send a message with a title and 2 lines. It appears large on the tablet. Activity shows **Done · Picked up in … · Shown on the tablet**.
13. Tap **OK** on the tablet. Activity adds "closed by tapping OK". Send another with "Show for 1 minute" and don't tap it. It closes itself: "closed after its time ran out".
14. Send a message containing `<b>hi</b>`. It shows literally as text.
15. Send a message in Good Night mode. It shows as a dim red card.

**F. Acknowledged mode change**
16. Tick "Only switch if the tablet responds within 2 minutes" and pick Good Night. The status reads "The tablet switched to Good Night".
17. With the tablet offline, do the same. After 2 min Activity shows "Not delivered" (then `expired` once the tablet reconnects), and the mode must **not** change on reconnect.

**G. Refresh**
18. Overview → **Refresh portal**. The tablet reloads within a few seconds and "Last reload: Reloaded by command …" appears. Press it again straight away. The result is `Failed · already refreshed less than 2 minutes ago`, and there's **no** second reload.

**H. Offline / stale safety**
19. Take the tablet offline. Send a message with "Deliver within 2 minutes", wait 3 minutes, then reconnect. The message must **not** appear, and Activity shows **Expired**.
20. Take the tablet offline. Send a message with "Deliver within 1 hour", then reconnect within the hour. It **does** appear once.
21. Send a message, then Cancel it while it's still "Waiting" (easiest with the tablet offline). It shows as Cancelled and never appears.

**I. Reminders**
22. Add a reminder for 2 minutes from now (IST). It appears in Good Morning's "Today". At the due time the card pops up on the tablet (in any mode). Tap **Done**. Chennai Control shows **Done … on the tablet at …**.
23. Add another reminder and Cancel it before it's due. It never pops up.

**J. Health / misc**
24. Tap the tiny status dot on the tablet. It shows version, connection, viewport and mode for 8 s.
25. Rotate the tablet to portrait and back. The layout stays usable, and Chennai Control's Screen value updates within about 3 s.
26. iPhone: every section is usable one-handed, nothing overflows sideways, and inputs don't zoom.

**K. After testing:** Activity → *Clear older than 7 days* (or delete test records in the console).

---

## 15. Deliberately NOT implemented

Camera, microphone, WebRTC, PeerJS, intercom, any monitoring or surveillance.
Device Owner, kiosk lockdown, Fully Kiosk configuration, ADB, Android
permissions or brightness control. Google Photos or anything needing
credentials. Service worker or PWA offline boot. Firebase Auth and Security
Rules. Reliable background reminder alarms. YouTube or casting. Arbitrary or
remote code execution (explicitly excluded by design).

---

## 16. Known limitations

- **No offline boot.** There's no service worker, so if the browser itself
  reloads the page while offline, the tablet shows the browser's error page.
  Our own reloads are guarded against this; the kiosk app should also reload
  on network restore.
- A message on screen is lost if the page reloads. The command is already
  `completed`.
- At boot, the bundled photo may show briefly before a custom-list setting
  arrives from Firebase.
- The clock and date follow the **device** locale and time zone (12 or 24 h
  as the tablet is set).
- `expires_at` uses the admin's server-offset estimate, accurate to about
  network latency. `created_at` is exact server time.
- Reminders: see §5B. One-off only, no repeats and no snooze.
- The Good Night backlight can't be dimmed from a web page.
- Clearing old command records is manual (a button). Storage grows slowly
  otherwise (a few hundred bytes per command).
- Open-Meteo is a third-party free service. Its terms, limits or availability
  may change; the provider interface makes replacing it easy.
- Chennai Control tolerates any data, but with Test Mode anyone can change it
  (§12).

---

## 17. Recommended next engineering milestones

1. **Firebase Auth + RTDB Security Rules.**
   - Separate tablet (device) and admin identities.
   - Rules following §3's "who writes what": only admins create commands,
     only the device claims them, status transitions validated, `created_at == now`,
     `expires_at ≤ now + 1 h`, text length limits.
2. **Kiosk hardening (with the human):** Fully Kiosk or equivalent. Keep the
   screen on, reload on network restore, scheduled screen brightness for Good
   Night, and auto-start.
3. **Reliable reminders:**
   - A server-side scheduler (e.g. a Cloudflare Worker cron or Cloud Functions)
     that marks reminders due, plus an Android-level notification or sound
     path.
   - Repeats and snooze, then medication-grade reliability only after that.
4. **Photo pipeline:** uploads to Firebase Storage or Cloudflare R2 with
   server-side resizing and access control. Feed `setPhotos()` from it.
5. **Scheduled modes:** automatic Good Morning / Good Night by IST time, with
   manual override.
6. **Offline boot shell:** a small, strictly versioned service worker that
   caches only the app shell and bundled photos.
7. **Housekeeping automation:** a scheduled cleanup of old commands, reminders
   and health history.
8. **Communication features (YouTube, intercom, WebRTC)** as separate
   milestones, with explicit consent and the mandatory on-screen indicator
   while remotely connected.
9. **A zero-build test page** (`tests.html`) exercising `schema.js` validators
   and the command `assess()` rules in the browser.

---

## 18. Testing performed by Claude (desktop Chromium only, not the tablet)

Local `python3 -m http.server` against the **real development Firebase**, with
the portal at 1280×800 and Chennai Control at desktop and 375×812. Results:

- Both pages load with **no console or module errors**. Every module was
  statically reviewed, and an unused-import scan came back clean.
- Home, Good Morning and Good Night render correctly. Mode switching works in
  real time, and `health.active_mode` confirms it.
- Presence heartbeat works. Chennai Control shows Online and Last seen, and
  shows **Offline immediately** when the tablet tab closes (onDisconnect).
- `SHOW_MESSAGE`: shown about 0.1 s after sending. `completed`, then
  `closed_by: tap`. HTML shown as plain text.
- `SET_MODE`: `completed`, `display.updated_by = command:<id>`.
- `REFRESH_PORTAL`: the tablet reloaded and `health.last_reload` was recorded.
  An immediate second refresh was `failed / rate_limited` with no loop.
- Two portal tabs at once: exactly **one** claimed and showed the command.
- Offline tablet:
  - A cancelled command stayed cancelled.
  - A command that expired during the outage was marked `expired` and never
    shown.
  - A still-valid one was shown on reconnect.
- Malformed commands (unknown type, missing expiry, already expired, empty
  text, expiry 5 h ahead, bad mode, a non-object record, an
  already-`completed` one, and `"constructor"`/`"__proto__"` keys) were all
  handled with the right codes and never executed or crashed. (A crash in
  Chennai Control's Activity list on a `"constructor"` status was found and
  fixed during this.)
- Malformed shared data (mode `"disco"`/`"constructor"`, a bad reminder, a
  non-numeric interval, HTML in the morning note) all fell back safely.
- A reminder was created in IST, popped up on time (in Good Night styling),
  was acknowledged by tapping Done, and showed as acknowledged in Chennai
  Control.
- Custom photo list:
  - `javascript:` was rejected.
  - A broken URL was skipped.
  - An all-broken list fell back to bundled, and this was reported to health.
- With the Firebase SDK **unreachable** (a temporary copy with a broken SDK
  URL, served from a scratch folder), the clock and photo frame kept running
  and the status showed "Offline · retrying".
- Chennai Control at phone width: single column, no horizontal overflow, and
  a two-column facts grid.
- Afterwards the dev database was **restored to its exact pre-test contents**
  (see the handoff).
- **Not tested:** anything on the SM-T510 or on Android. Also not tested:
  real Wi-Fi loss (simulated by closing and reopening tabs), long-running
  memory behaviour, iPhone Safari, and the Cloudflare deployment.
