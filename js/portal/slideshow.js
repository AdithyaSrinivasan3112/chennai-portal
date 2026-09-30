/*
 * Chennai Portal — photo-frame slideshow engine.
 *
 * Design (chosen for a 3 GB RAM tablet):
 *   - Exactly two <img> layers. The visible one shows the current photo;
 *     the hidden one preloads the next. At most two decoded images exist.
 *   - Transition = CSS opacity crossfade only (compositor-friendly, no
 *     continuous effects such as Ken Burns).
 *   - A photo is only revealed after it has fully loaded and decoded, so
 *     the screen never shows a half-loaded or broken image.
 *   - Broken images are skipped and retried after a cool-down.
 *   - If nothing can be loaded, the current photo stays up; if there has
 *     never been one, the CSS gradient behind the layers shows. The screen
 *     is never blank.
 *
 * The engine does not care where the photo list comes from: call
 * setPhotos([...]) with { id, src, caption?, position? } objects. Today that
 * list comes from photos/manifest.json or from Firebase (content/slideshow).
 */

import { BUNDLED_MANIFEST_URL, SLIDESHOW_DEFAULTS } from "../core/config.js";
import { normalizePhotoList, isPlainObject } from "../core/schema.js";

// Used only if photos/manifest.json itself cannot be fetched.
const FALLBACK_PHOTOS = [
  { src: "photos/placeholder/marina-dawn.svg", caption: "Placeholder · Marina at dawn" },
  { src: "photos/placeholder/temple-dusk.svg", caption: "Placeholder · Temple tower at dusk" },
  { src: "photos/placeholder/kolam.svg", caption: "Placeholder · Kolam" },
  { src: "photos/placeholder/coconut-palms.svg", caption: "Placeholder · Coconut palms" },
  { src: "photos/placeholder/central-station.svg", caption: "Placeholder · Chennai Central, evening" }
];

const LOAD_TIMEOUT_MS = 20 * 1000;       // give up on a slow photo after this
const DECODE_WAIT_MS = 3 * 1000;         // max wait for decode() after a successful load
const FAILED_COOLDOWN_MS = 10 * 60 * 1000; // skip a broken photo for this long
const RETRY_WHEN_STUCK_MS = 60 * 1000;   // nothing loadable: try again after this
const TRANSITION_MS = 1600;              // keep in sync with .slide transition in portal.css

/** Fetch the bundled photo list, falling back to a built-in list. */
export async function loadBundledPhotos() {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), 10000);
  try {
    const res = await fetch(BUNDLED_MANIFEST_URL, { cache: "no-cache", signal: controller ? controller.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const photos = normalizePhotoList(isPlainObject(data) ? data.photos : null);
    if (!photos.length) throw new Error("manifest has no usable photos");
    return photos;
  } catch (err) {
    console.warn("[Slideshow] Using built-in photo list:", err.message);
    return normalizePhotoList(FALLBACK_PHOTOS);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   layers: HTMLImageElement[],
 *   captionEl?: HTMLElement,
 *   onError?: (code: string, src: string) => void,
 *   onStuck?: () => void   // no photo in the current list could be shown
 * }} opts
 */
export function createSlideshow({ layers, captionEl, onError, onStuck }) {
  const state = {
    photos: [],
    order: [],          // play order (indexes into photos)
    cursor: 0,
    intervalMs: SLIDESHOW_DEFAULTS.interval_s * 1000,
    shuffle: SLIDESHOW_DEFAULTS.shuffle,
    running: false,
    busy: false,        // a showNext() is in progress
    again: false,       // photo list changed during showNext(); run it again
    generation: 0,      // bumps whenever the photo list changes
    visible: null,      // the <img> currently shown (or null)
    shownId: null,
    upcoming: null,     // { photo, layer, generation, promise }
    timer: null,
    preloadTimer: null,
    failedAt: new Map() // photo id → time it last failed
  };
  const cancels = new WeakMap(); // <img> → cancel function for an in-flight load

  /* --- Loading ----------------------------------------------------- */

  // Load `src` into `img`; resolves true once decoded, false on failure.
  function loadInto(img, src) {
    const cancelPrevious = cancels.get(img);
    if (cancelPrevious) cancelPrevious();

    if (img.src === src && img.complete && img.naturalWidth > 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        cancels.delete(img);
        resolve(loaded);
      };
      const timer = setTimeout(() => {
        finish(false);
        img.removeAttribute("src"); // abort the slow download
      }, LOAD_TIMEOUT_MS);

      cancels.set(img, () => finish(false));
      img.onload = () => {
        // decode() lets the browser prepare the bitmap off the main thread
        // so the crossfade doesn't stutter. The image has already loaded,
        // so a decode error — or a decode that stalls because the screen
        // went off — must never mark a good photo as broken.
        if (typeof img.decode !== "function") {
          finish(true);
          return;
        }
        const decodeFallback = setTimeout(() => finish(true), DECODE_WAIT_MS);
        const done = () => {
          clearTimeout(decodeFallback);
          finish(true);
        };
        img.decode().then(done, done);
      };
      img.onerror = () => finish(false);
      img.src = src;
    });
  }

  function hiddenLayer() {
    return state.visible === layers[0] ? layers[1] : layers[0];
  }

  /* --- Ordering ---------------------------------------------------- */

  function rebuildOrder() {
    const order = state.photos.map((_, i) => i);
    if (state.shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // Avoid showing the same photo twice in a row across cycles.
      if (order.length > 1 && state.photos[order[0]].id === state.shownId) order.push(order.shift());
    }
    state.order = order;
    state.cursor = 0;
  }

  // Next photo in play order, skipping ones that failed recently.
  function takeNext() {
    const total = state.photos.length;
    for (let i = 0; i < total; i++) {
      if (state.cursor >= state.order.length) rebuildOrder();
      const photo = state.photos[state.order[state.cursor++]];
      const failed = state.failedAt.get(photo.id);
      if (failed && Date.now() - failed < FAILED_COOLDOWN_MS) continue;
      return photo;
    }
    return null;
  }

  function preloadNext() {
    const photo = takeNext();
    if (!photo) return null;
    const layer = hiddenLayer();
    return { photo, layer, generation: state.generation, promise: loadInto(layer, photo.src) };
  }

  /* --- Showing ----------------------------------------------------- */

  function reveal(job) {
    const incoming = job.layer;
    const outgoing = incoming === layers[0] ? layers[1] : layers[0];
    incoming.style.objectPosition = job.photo.position || "";
    incoming.classList.add("is-visible");
    outgoing.classList.remove("is-visible");
    state.visible = incoming;
    state.shownId = job.photo.id;

    if (captionEl) {
      captionEl.textContent = job.photo.caption || "";
      captionEl.hidden = !job.photo.caption;
    }
  }

  async function tryShowOne() {
    const generation = state.generation;
    const attempts = Math.max(1, state.photos.length);

    for (let i = 0; i < attempts; i++) {
      if (!state.upcoming || state.upcoming.generation !== generation) state.upcoming = preloadNext();
      const job = state.upcoming;
      if (!job) return false; // nothing loadable right now

      // Single photo that is already on screen: nothing to change.
      if (job.photo.id === state.shownId && state.photos.length === 1) {
        state.upcoming = null;
        return true;
      }

      const loaded = await job.promise;
      if (generation !== state.generation) return false; // list changed meanwhile
      state.upcoming = null;

      if (loaded) {
        reveal(job);
        return true;
      }
      state.failedAt.set(job.photo.id, Date.now());
      job.layer.removeAttribute("src");
      if (onError) onError("image_failed", job.photo.src);
    }
    return false;
  }

  async function showNext() {
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    clearTimeout(state.timer);
    clearTimeout(state.preloadTimer);

    let shown = false;
    try {
      shown = await tryShowOne();
    } catch (err) {
      console.error("[Slideshow] Unexpected error:", err);
    } finally {
      state.busy = false;
    }

    if (!state.running) return;
    if (state.again) {
      state.again = false;
      showNext();
      return;
    }
    schedule(shown ? state.intervalMs : RETRY_WHEN_STUCK_MS);
    if (!shown && onStuck) onStuck(); // may swap in a different list

    // Preload the following photo once the crossfade has finished, so the
    // layer being loaded is never the one fading out.
    if (shown && state.photos.length > 1) {
      state.preloadTimer = setTimeout(() => {
        if (state.running && !state.busy && !state.upcoming) state.upcoming = preloadNext();
      }, TRANSITION_MS + 200);
    }
  }

  function schedule(delayMs) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state.running) return;
      if (document.hidden) schedule(state.intervalMs); // screen off: don't churn
      else showNext();
    }, delayMs);
  }

  /* --- Public API -------------------------------------------------- */

  return {
    /** Replace the photo list (keeps the current photo on screen). */
    setPhotos(list) {
      const photos = Array.isArray(list) ? list : [];
      const sameList =
        photos.length === state.photos.length &&
        photos.every((p, i) => {
          const q = state.photos[i];
          return p.src === q.src && p.caption === q.caption && p.position === q.position;
        });
      if (sameList) return;

      state.photos = photos;
      state.generation++;
      state.upcoming = null;
      rebuildOrder();

      if (!state.running) return;
      if (state.busy) state.again = true;
      else if (!state.visible) showNext();
    },

    /** Apply interval / shuffle settings. */
    configure({ interval_s, shuffle }) {
      const intervalMs = Math.max(5, Number(interval_s) || SLIDESHOW_DEFAULTS.interval_s) * 1000;
      const shuffleChanged = Boolean(shuffle) !== state.shuffle;
      const intervalChanged = intervalMs !== state.intervalMs;
      state.intervalMs = intervalMs;
      state.shuffle = Boolean(shuffle);
      if (shuffleChanged) {
        state.upcoming = null;
        state.generation++;
        rebuildOrder();
        if (state.busy) state.again = true;
      }
      if (state.running && !state.busy && (intervalChanged || shuffleChanged)) schedule(state.intervalMs);
    },

    start() {
      if (state.running) return;
      state.running = true;
      if (!state.visible) showNext();
      else schedule(state.intervalMs);
    },

    stop() {
      state.running = false;
      clearTimeout(state.timer);
      clearTimeout(state.preloadTimer);
    },

    /** Small summary for diagnostics / health. */
    status() {
      return {
        photos: state.photos.length,
        failing: Array.from(state.failedAt.values()).filter((t) => Date.now() - t < FAILED_COOLDOWN_MS).length,
        showing: state.shownId
      };
    }
  };
}
