/*
 * Chennai Portal — weather & air-quality panels for the Good Morning screen.
 *
 * PROVIDER INTERFACE (swap providers without touching the UI):
 *   {
 *     name,                                   // shown in the panel footer (attribution)
 *     fetchWeather(location, signal)    → Promise<Weather>
 *     fetchAirQuality(location, signal) → Promise<AirQuality>
 *   }
 *   Weather:    { temperature, feelsLike, humidity, condition: { label, icon },
 *                 high, low, rainChance, sunrise, sunset, observedAt }
 *   AirQuality: { aqi, scaleLabel, category: { label, level }, pm25, pm10, observedAt }
 *
 *   Any field may be null when the provider doesn't supply it. Providers
 *   must never invent values; a failed fetch simply throws.
 *
 * CURRENT PROVIDER: Open-Meteo (https://open-meteo.com) — free for
 * non-commercial use, no API key, CORS-enabled. Attribution is shown in
 * the panel footers as its licence requires. Only city-level coordinates
 * for Chennai are sent (see CHENNAI in core/config.js).
 */

import { fmt, formatRelative } from "../core/time.js";

/* ------------------------------------------------------------------ */
/* Open-Meteo provider                                                 */
/* ------------------------------------------------------------------ */

// WMO weather interpretation codes → label + icon id in index.html's sprite.
function describeWmo(code, isDay) {
  const sun = isDay ? "i-sun" : "i-moon";
  const partly = isDay ? "i-partly" : "i-partly-night";
  if (code === 0) return { label: isDay ? "Clear sky" : "Clear night", icon: sun };
  if (code === 1) return { label: "Mainly clear", icon: sun };
  if (code === 2) return { label: "Partly cloudy", icon: partly };
  if (code === 3) return { label: "Overcast", icon: "i-cloud" };
  if (code === 45 || code === 48) return { label: "Fog", icon: "i-fog" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: "i-drizzle" };
  if (code === 61 || code === 80) return { label: "Light rain", icon: "i-rain" };
  if (code === 63 || code === 81) return { label: "Rain", icon: "i-rain" };
  if (code === 65 || code === 82) return { label: "Heavy rain", icon: "i-rain" };
  if (code === 66 || code === 67) return { label: "Freezing rain", icon: "i-rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", icon: "i-cloud" };
  if (code === 95) return { label: "Thunderstorm", icon: "i-storm" };
  if (code === 96 || code === 99) return { label: "Thunderstorm with hail", icon: "i-storm" };
  return { label: "Current conditions", icon: "i-cloud" };
}

// US EPA AQI categories (level 1–6 drives the colour in CSS).
function describeUsAqi(aqi) {
  if (aqi <= 50) return { label: "Good", level: 1 };
  if (aqi <= 100) return { label: "Moderate", level: 2 };
  if (aqi <= 150) return { label: "Unhealthy for sensitive groups", level: 3 };
  if (aqi <= 200) return { label: "Unhealthy", level: 4 };
  if (aqi <= 300) return { label: "Very unhealthy", level: 5 };
  return { label: "Hazardous", level: 6 };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const first = (arr) => (Array.isArray(arr) ? num(arr[0]) : null);
const secondsToMs = (s) => (s === null ? null : s * 1000);

async function getJson(url, signal) {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== "object") throw new Error("bad_response");
  return data;
}

export const openMeteoProvider = {
  name: "Open-Meteo.com",

  async fetchWeather(location, signal) {
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
      timezone: location.timeZone,
      forecast_days: "1",
      timeformat: "unixtime"
    });
    const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, signal);
    const current = data.current || {};
    const daily = data.daily || {};

    const temperature = num(current.temperature_2m);
    if (temperature === null) throw new Error("incomplete_data");
    const code = num(current.weather_code);

    return {
      temperature,
      feelsLike: num(current.apparent_temperature),
      humidity: num(current.relative_humidity_2m),
      condition: code === null ? null : describeWmo(code, current.is_day !== 0),
      high: first(daily.temperature_2m_max),
      low: first(daily.temperature_2m_min),
      rainChance: first(daily.precipitation_probability_max),
      sunrise: secondsToMs(first(daily.sunrise)),
      sunset: secondsToMs(first(daily.sunset)),
      observedAt: secondsToMs(num(current.time))
    };
  },

  async fetchAirQuality(location, signal) {
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "us_aqi,pm2_5,pm10",
      timezone: location.timeZone,
      timeformat: "unixtime"
    });
    const data = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, signal);
    const current = data.current || {};
    const aqi = num(current.us_aqi);
    if (aqi === null) throw new Error("incomplete_data");
    return {
      aqi: Math.round(aqi),
      // Open-Meteo's AQI is a model estimate (CAMS), not a ground station,
      // and uses the US scale — India's CPCB AQI differs. Say so on screen.
      scaleLabel: "US AQI · modelled estimate",
      category: describeUsAqi(aqi),
      pm25: num(current.pm2_5),
      pm10: num(current.pm10),
      observedAt: secondsToMs(num(current.time))
    };
  }
};

/* ------------------------------------------------------------------ */
/* Panels controller                                                   */
/* ------------------------------------------------------------------ */

const CACHE_KEY = "chennai.weather.v1";
const FETCH_TIMEOUT_MS = 12 * 1000;
const STALE_LABEL_AFTER_MS = 2 * 60 * 60 * 1000;   // say "Last updated 3 h ago"
const BACKOFF_MINUTES = [2, 5, 10, 20, 30];

/**
 * Drives the weather + AQI panels. Fetches only while the Good Morning
 * screen is active, caches the last good result so it can be shown
 * instantly, and backs off after failures.
 */
export function createWeatherPanels({ weatherEl, airEl, provider, location, onError }) {
  const q = (root, key) => root.querySelector(`[data-part="${key}"]`);

  const kinds = {
    weather: {
      el: weatherEl,
      fetch: (signal) => provider.fetchWeather(location, signal),
      refreshMs: 30 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
      render: renderWeather
    },
    air: {
      el: airEl,
      fetch: (signal) => provider.fetchAirQuality(location, signal),
      refreshMs: 60 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
      render: renderAir
    }
  };
  for (const kind of Object.values(kinds)) {
    Object.assign(kind, { data: null, fetchedAt: 0, failures: 0, nextTryAt: 0, inFlight: false });
  }

  let active = false;
  let timer = null;

  loadCache();

  /* --- cache (localStorage; purely a convenience) ------------------ */
  function loadCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!cached || typeof cached !== "object") return;
      for (const name of Object.keys(kinds)) {
        const entry = cached[name];
        if (entry && entry.data && typeof entry.fetchedAt === "number") {
          kinds[name].data = entry.data;
          kinds[name].fetchedAt = entry.fetchedAt;
        }
      }
    } catch (err) {
      /* storage unavailable or corrupt: start empty */
    }
  }

  function saveCache() {
    try {
      const out = {};
      for (const [name, kind] of Object.entries(kinds)) {
        if (kind.data) out[name] = { data: kind.data, fetchedAt: kind.fetchedAt };
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (err) {
      /* ignore */
    }
  }

  /* --- fetching ---------------------------------------------------- */
  async function refresh(name) {
    const kind = kinds[name];
    kind.inFlight = true;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(() => controller && controller.abort(), FETCH_TIMEOUT_MS);
    try {
      kind.data = await kind.fetch(controller ? controller.signal : undefined);
      kind.fetchedAt = Date.now();
      kind.failures = 0;
      kind.nextTryAt = 0;
      saveCache();
    } catch (err) {
      kind.failures++;
      const minutes = BACKOFF_MINUTES[Math.min(kind.failures, BACKOFF_MINUTES.length) - 1];
      kind.nextTryAt = Date.now() + minutes * 60 * 1000;
      const code = err && err.name === "AbortError" ? "timeout" : (err && err.message) || "fetch_failed";
      console.warn(`[Weather] ${name} fetch failed (${code}); retry in ${minutes} min`);
      if (onError) onError(name === "air" ? "aqi" : "weather", code);
    } finally {
      clearTimeout(timeout);
      kind.inFlight = false;
      kind.render(kind);
    }
  }

  function check() {
    const now = Date.now();
    for (const [name, kind] of Object.entries(kinds)) {
      kind.render(kind); // keeps "updated … ago" labels current
      if (!active || kind.inFlight || now < kind.nextTryAt) continue;
      if (kind.data && now - kind.fetchedAt < kind.refreshMs) continue;
      refresh(name);
    }
  }

  /* --- rendering --------------------------------------------------- */
  function usable(kind) {
    return kind.data && Date.now() - kind.fetchedAt < kind.maxAgeMs;
  }

  function footer(kind) {
    const age = Date.now() - kind.fetchedAt;
    const when = age > STALE_LABEL_AFTER_MS
      ? `Last updated ${formatRelative(kind.fetchedAt, Date.now())}`
      : `Updated ${fmt.time(kind.fetchedAt)}`;
    return `${when} · ${provider.name}`;
  }

  function renderWeather(kind) {
    const el = kind.el;
    if (!usable(kind)) {
      el.dataset.state = kind.inFlight || kind.failures === 0 ? "loading" : "unavailable";
      q(el, "temp").textContent = "—";
      q(el, "desc").textContent = el.dataset.state === "loading" ? "Checking the weather…" : "Weather unavailable right now";
      q(el, "feels").textContent = el.dataset.state === "loading" ? "" : "Will try again automatically";
      q(el, "facts").textContent = "";
      q(el, "sun").textContent = "";
      q(el, "foot").textContent = provider.name;
      q(el, "icon").setAttribute("href", "#i-cloud");
      return;
    }
    const d = kind.data;
    const deg = (v) => (typeof v === "number" ? `${Math.round(v)}°` : "—");
    el.dataset.state = Date.now() - kind.fetchedAt > STALE_LABEL_AFTER_MS ? "stale" : "ready";
    q(el, "temp").textContent = deg(d.temperature);
    q(el, "desc").textContent = d.condition ? d.condition.label : "";
    q(el, "feels").textContent = typeof d.feelsLike === "number" ? `Feels like ${deg(d.feelsLike)}` : "";
    const icon = d.condition && /^i-[a-z-]+$/.test(d.condition.icon) ? d.condition.icon : "i-cloud";
    q(el, "icon").setAttribute("href", `#${icon}`);

    const facts = [];
    if (typeof d.high === "number" && typeof d.low === "number") facts.push(`High ${deg(d.high)} · Low ${deg(d.low)}`);
    if (typeof d.rainChance === "number") facts.push(`Rain ${Math.round(d.rainChance)}%`);
    if (typeof d.humidity === "number") facts.push(`Humidity ${Math.round(d.humidity)}%`);
    q(el, "facts").textContent = facts.join("   ·   ");

    const sun = [];
    if (typeof d.sunrise === "number") sun.push(`Sunrise ${fmt.time(d.sunrise)}`);
    if (typeof d.sunset === "number") sun.push(`Sunset ${fmt.time(d.sunset)}`);
    q(el, "sun").textContent = sun.join("  ·  ");
    q(el, "foot").textContent = footer(kind);
  }

  function renderAir(kind) {
    const el = kind.el;
    if (!usable(kind)) {
      el.dataset.state = kind.inFlight || kind.failures === 0 ? "loading" : "unavailable";
      el.dataset.level = "";
      q(el, "value").textContent = "—";
      q(el, "category").textContent = el.dataset.state === "loading" ? "Checking air quality…" : "Air quality unavailable";
      q(el, "detail").textContent = el.dataset.state === "loading" ? "" : "Will try again automatically";
      q(el, "foot").textContent = provider.name;
      return;
    }
    const d = kind.data;
    el.dataset.state = Date.now() - kind.fetchedAt > STALE_LABEL_AFTER_MS ? "stale" : "ready";
    el.dataset.level = d.category ? String(d.category.level) : "";
    q(el, "value").textContent = typeof d.aqi === "number" ? String(d.aqi) : "—";
    q(el, "category").textContent = d.category ? d.category.label : "";
    const detail = [];
    if (typeof d.pm25 === "number") detail.push(`PM2.5 ${Math.round(d.pm25)} µg/m³`);
    if (typeof d.pm10 === "number") detail.push(`PM10 ${Math.round(d.pm10)} µg/m³`);
    q(el, "detail").textContent = detail.join("  ·  ");
    q(el, "foot").textContent = `${d.scaleLabel || "AQI"} · ${footer(kind)}`;
  }

  /* --- public API -------------------------------------------------- */
  return {
    /** Call when the Good Morning screen becomes visible. */
    activate() {
      if (active) return;
      active = true;
      check();
      timer = setInterval(check, 60 * 1000);
    },
    /** Call when leaving Good Morning: no fetching in other modes. */
    deactivate() {
      active = false;
      clearInterval(timer);
      timer = null;
    }
  };
}
