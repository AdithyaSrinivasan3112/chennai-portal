/*
 * Chennai Control — content: photo-frame settings, photo list, morning note.
 *
 * Slideshow record (devices/chennai-tablet/content/slideshow):
 *   { interval_s, shuffle, source: "bundled"|"custom", updated_at,
 *     photos: { <pushId>: { src, caption?, added_at } } }   ← custom list
 *
 * "bundled" = photos/manifest.json shipped with the site.
 * "custom"  = the list stored in Firebase (an https:// URL or a path on
 *             this site). If the custom list is empty the tablet falls
 *             back to the bundled photos, so it is never blank.
 */

import {
  ref, onValue, set, update, push, remove, serverTimestamp
} from "../core/firebase.js";
import { PATHS, LIMITS, BUNDLED_MANIFEST_URL } from "../core/config.js";
import {
  normalizeSlideshow, normalizePhotoList, normalizeMorningNote, safeImageUrl, cleanText, isPlainObject
} from "../core/schema.js";
import { fmt } from "../core/time.js";
import { h, toast, withTimeout, relTime } from "./dom.js";

export function initContent(app) {
  const { db } = app;

  /* ------------------------------------------------------------------ */
  /* Slideshow settings                                                  */
  /* ------------------------------------------------------------------ */
  const settingsForm = document.getElementById("slideshow-form");
  const intervalInput = document.getElementById("ss-interval");
  const shuffleInput = document.getElementById("ss-shuffle");
  const summaryEl = document.getElementById("ss-summary");
  const customListEl = document.getElementById("custom-photos");
  const bundledListEl = document.getElementById("bundled-photos");
  const saveButton = document.getElementById("ss-save");

  let config = normalizeSlideshow(null);
  let bundledCount = null;
  let dirty = false; // don't overwrite what the admin is editing

  settingsForm.addEventListener("input", () => {
    dirty = true;
  });

  function sourceInputs() {
    return Array.from(settingsForm.querySelectorAll('input[name="ss-source"]'));
  }

  function fillForm() {
    if (dirty) return;
    const option = Array.from(intervalInput.options).find((o) => Number(o.value) === config.interval_s);
    if (!option) intervalInput.append(h("option", { value: String(config.interval_s), text: `${config.interval_s} seconds` }));
    intervalInput.value = String(config.interval_s);
    shuffleInput.checked = config.shuffle;
    sourceInputs().forEach((input) => {
      input.checked = input.value === config.source;
    });
  }

  function renderSummary() {
    const usingCustom = config.source === "custom" && config.photos.length > 0;
    const count = usingCustom ? config.photos.length : bundledCount;
    const source = usingCustom ? "your custom list" : "the bundled photos";
    const fallbackNote = config.source === "custom" && !config.photos.length
      ? " (custom list is empty, so bundled photos are used)"
      : "";
    const countText = count === null ? "" : ` · ${count} photo${count === 1 ? "" : "s"}`;
    summaryEl.textContent =
      `Set to ${source}${countText} · every ${config.interval_s} s · ${config.shuffle ? "shuffled" : "in order"}${fallbackNote}`;
  }

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = sourceInputs().find((input) => input.checked);
    saveButton.dataset.busy = "true";
    app.refreshControls();
    try {
      await withTimeout(update(ref(db, PATHS.slideshow), {
        interval_s: Number(intervalInput.value),
        shuffle: shuffleInput.checked,
        source: selected && selected.value === "custom" ? "custom" : "bundled",
        updated_at: serverTimestamp()
      }), 10 * 1000, "Firebase did not confirm in time.");
      dirty = false;
      toast("Photo frame settings saved.", "ok");
    } catch (err) {
      toast(`Not saved: ${err.message}`, "error");
    } finally {
      delete saveButton.dataset.busy;
      app.refreshControls();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Custom photo list                                                   */
  /* ------------------------------------------------------------------ */
  const addForm = document.getElementById("photo-add-form");
  const urlInput = document.getElementById("photo-url");
  const captionInput = document.getElementById("photo-caption");
  const addStatus = document.getElementById("photo-add-status");
  const addButton = document.getElementById("photo-add");

  urlInput.maxLength = LIMITS.url;
  captionInput.maxLength = LIMITS.caption;

  function thumb(src, caption) {
    return h("img", { class: "thumb", src, alt: caption || "", loading: "lazy", decoding: "async" });
  }

  function renderCustom() {
    const rows = config.photos.map((photo) =>
      h("li", { class: "photo-row" },
        thumb(photo.src, photo.caption),
        h("div", { class: "photo-info" },
          h("div", { class: "photo-caption", text: photo.caption || "No caption" }),
          h("div", { class: "photo-src", text: photo.src })
        ),
        h("button", {
          type: "button", class: "btn btn-small btn-ghost", "data-needs-connection": "", text: "Remove",
          onclick: (e) => {
            e.currentTarget.disabled = true;
            remove(ref(db, `${PATHS.slideshow}/photos/${photo.id}`))
              .catch((err) => toast(`Could not remove: ${err.message}`, "error"));
          }
        })
      )
    );
    customListEl.replaceChildren(...(rows.length ? rows : [h("li", { class: "empty", text: "No custom photos yet." })]));
    app.refreshControls();
  }

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = urlInput.value.trim();
    if (!safeImageUrl(raw)) {
      addStatus.textContent = "Use an https:// image address or a path on this site (e.g. photos/family/01.jpg).";
      return;
    }
    if (config.photos.length >= LIMITS.customPhotos) {
      addStatus.textContent = `The list is limited to ${LIMITS.customPhotos} photos.`;
      return;
    }
    addButton.dataset.busy = "true";
    app.refreshControls();
    try {
      const entry = { src: raw, added_at: serverTimestamp() };
      const caption = cleanText(captionInput.value, LIMITS.caption);
      if (caption) entry.caption = caption;
      await withTimeout(set(push(ref(db, `${PATHS.slideshow}/photos`)), entry), 10 * 1000, "Firebase did not confirm in time.");
      urlInput.value = "";
      captionInput.value = "";
      addStatus.textContent = config.source === "custom"
        ? "Added."
        : "Added. Choose “Custom list” above and save to show these photos.";
    } catch (err) {
      addStatus.textContent = `Not added: ${err.message}`;
    } finally {
      delete addButton.dataset.busy;
      app.refreshControls();
    }
  });

  onValue(
    ref(db, PATHS.slideshow),
    (snap) => {
      config = normalizeSlideshow(snap.val());
      fillForm();
      renderSummary();
      renderCustom();
    },
    (err) => app.listenFailed("slideshow", err)
  );

  /* ------------------------------------------------------------------ */
  /* Bundled photos (read-only; they ship with the site)                 */
  /* ------------------------------------------------------------------ */
  fetch(BUNDLED_MANIFEST_URL, { cache: "no-cache" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data) => {
      const photos = normalizePhotoList(isPlainObject(data) ? data.photos : null);
      bundledCount = photos.length;
      bundledListEl.replaceChildren(...photos.map((p) =>
        h("li", { class: "bundled-item" }, thumb(p.src, p.caption), h("span", { text: p.caption || "" }))
      ));
      renderSummary();
    })
    .catch((err) => {
      bundledListEl.replaceChildren(h("li", { class: "empty", text: `Could not load photos/manifest.json (${err.message}).` }));
    });

  /* ------------------------------------------------------------------ */
  /* Morning note (shown on the Good Morning screen until changed)       */
  /* ------------------------------------------------------------------ */
  const noteForm = document.getElementById("note-form");
  const noteText = document.getElementById("note-text");
  const noteFrom = document.getElementById("note-from");
  const noteStatus = document.getElementById("note-status");
  const noteSave = document.getElementById("note-save");
  const noteClear = document.getElementById("note-clear");
  let noteDirty = false;

  noteText.maxLength = LIMITS.noteText;
  noteFrom.maxLength = LIMITS.noteFrom;
  noteForm.addEventListener("input", () => {
    noteDirty = true;
  });

  onValue(
    ref(db, PATHS.morningNote),
    (snap) => {
      const note = normalizeMorningNote(snap.val());
      if (!noteDirty) {
        noteText.value = note ? note.text : "";
        noteFrom.value = note ? note.from : "";
      }
      noteStatus.replaceChildren();
      if (note && note.updated_at) noteStatus.append("On the tablet since ", relTime(note.updated_at, fmt.dateTime(note.updated_at)), ".");
      else if (!note) noteStatus.textContent = "No note set — the tablet shows a gentle placeholder.";
    },
    (err) => app.listenFailed("morning_note", err)
  );

  async function saveNote(value) {
    noteSave.dataset.busy = "true";
    app.refreshControls();
    try {
      await withTimeout(value ? set(ref(db, PATHS.morningNote), value) : remove(ref(db, PATHS.morningNote)),
        10 * 1000, "Firebase did not confirm in time.");
      noteDirty = false;
      toast(value ? "Morning note saved." : "Morning note cleared.", "ok");
    } catch (err) {
      toast(`Not saved: ${err.message}`, "error");
    } finally {
      delete noteSave.dataset.busy;
      app.refreshControls();
    }
  }

  noteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = cleanText(noteText.value, LIMITS.noteText, { multiline: true });
    if (!text) {
      noteStatus.textContent = "Write a note first (or use Clear).";
      return;
    }
    const value = { text, updated_at: serverTimestamp() };
    const from = cleanText(noteFrom.value, LIMITS.noteFrom);
    if (from) value.from = from;
    saveNote(value);
  });

  noteClear.addEventListener("click", () => {
    noteText.value = "";
    noteFrom.value = "";
    saveNote(null);
  });
}
