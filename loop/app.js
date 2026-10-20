/* Loop Quest — Dungeon Run
   Walking loops on the public OSRM foot profile. Few router calls,
   debounced to the Generate / New Loop / Reverse actions, cached locally. */
(function () {
  "use strict";

  const MI = 1609.344;
  const EARTH = 6371000;
  const ROUTERS = [
    "https://routing.openstreetmap.de/routed-foot/route/v1/foot/",
    "https://router.project-osrm.org/route/v1/foot/"
  ];
  const MAX_CALLS = 8;
  const CHIPS_MI = [0.5, 1, 1.5, 2, 3];
  const FAV_KEY = "loopQuest.favorites.v1";
  const SET_KEY = "loopQuest.settings.v1";
  const CACHE_KEY = "loopQuest.routeCache.v1";
  const DETOUR = 1.3;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const distanceInput = $("distance");
  const paceInput = $("pace");
  const unitBtn = $("unitBtn");
  const chipsEl = $("chips");
  const resultEl = $("result");
  const startInfo = $("startInfo");

  let unit = "mi";
  let paceMinPerMile = 20;
  let start = null;
  let current = null;
  let seed = null;
  let running = false;
  let runToken = 0;
  let arming = false;
  let walking = false;
  let watchId = null;
  let walkTimer = null;
  let walkStarted = 0;
  let maxAlong = 0;
  let wakeLock = null;
  let map, startMarker, userMarker, routeLayer, walkedLayer;
  const routeCache = new Map();
  let lastNet = 0;

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SET_KEY) || "{}");
      if (s.unit === "km" || s.unit === "mi") unit = s.unit;
      if (s.paceMinPerMile >= 12 && s.paceMinPerMile <= 45) paceMinPerMile = s.paceMinPerMile;
    } catch (e) { /* keep defaults */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SET_KEY, JSON.stringify({ unit, paceMinPerMile }));
    } catch (e) { /* private mode */ }
  }

  function loadRouteCache() {
    try {
      const arr = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
      arr.forEach((item) => { if (item && item.k) routeCache.set(item.k, item.v); });
    } catch (e) { /* ignore */ }
  }

  function saveRouteCache() {
    const arr = [...routeCache.entries()].slice(-20).map(([k, v]) => ({ k, v }));
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(arr)); } catch (e) { /* quota */ }
  }

  function toRad(d) { return d * Math.PI / 180; }
  function hav(a, b) {
    const dφ = toRad(b.lat - a.lat);
    const dλ = toRad(b.lon - a.lon);
    const φ1 = toRad(a.lat);
    const φ2 = toRad(b.lat);
    const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function destination(lat, lon, bearing, dist) {
    const δ = dist / EARTH;
    const φ1 = toRad(lat);
    const λ1 = toRad(lon);
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearing));
    const λ2 = λ1 + Math.atan2(
      Math.sin(bearing) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    return { lat: φ2 * 180 / Math.PI, lon: ((λ2 * 180 / Math.PI + 540) % 360) - 180 };
  }

  function bearingDeg(a, b) {
    const φ1 = toRad(a.lat);
    const φ2 = toRad(b.lat);
    const λ = toRad(b.lon - a.lon);
    const y = Math.sin(λ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  function formatDist(meters, digits) {
    const n = unit === "mi" ? meters / MI : meters / 1000;
    return n.toFixed(digits == null ? 2 : digits);
  }

  // Headline distance. Never round an under-target loop up to the target,
  // and never round an over-target loop down below the target.
  function formatLoopDistance(meters, targetMeters) {
    const digits = 2;
    const factor = unit === "mi" ? MI : 1000;
    const value = meters / factor;
    const target = targetMeters / factor;
    const step = Math.pow(10, -digits);
    let shown = Number(value.toFixed(digits));
    if (meters >= targetMeters) {
      if (shown + 1e-9 < target) shown = Math.ceil((target - 1e-12) / step) * step;
    } else if (shown + 1e-9 >= target) {
      shown = Math.floor((target - 1e-12) / step) * step;
      if (shown + 1e-9 >= target) shown = Math.max(0, shown - step);
    }
    return shown.toFixed(digits);
  }

  function unitWord() { return unit === "mi" ? "mi" : "km"; }

  function formatClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hh ? hh + ":" + pad(mm) + ":" + pad(ss) : mm + ":" + pad(ss);
  }

  function formatEta(meters) {
    const minutes = (meters / MI) * paceMinPerMile;
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? h + " h " + r + " min" : h + " h";
  }

  function formatStepDist(meters) {
    if (unit === "mi") {
      if (meters < 0.2 * MI) return Math.max(10, Math.round(meters * 3.28084 / 10) * 10) + " ft";
      return (meters / MI).toFixed(2) + " mi";
    }
    if (meters < 250) return Math.round(meters) + " m";
    return (meters / 1000).toFixed(2) + " km";
  }

  function paceShown() {
    return unit === "mi" ? paceMinPerMile : paceMinPerMile / 1.609344;
  }

  function targetMeters() {
    const v = parseFloat(distanceInput.value);
    if (!isFinite(v) || v <= 0) return null;
    return unit === "mi" ? v * MI : v * 1000;
  }

  const AIM_OVER_MI = 0.03;

  function aimOverMeters() {
    return AIM_OVER_MI * MI;
  }

  function outerOverMeters(target) {
    return Math.max(0.08 * MI, target * 0.03);
  }

  function randomSeed() {
    const counts = [3, 4, 5];
    return {
      bearing: Math.random() * Math.PI * 2,
      count: counts[Math.floor(Math.random() * counts.length)],
      aspect: 0.92 + Math.random() * 0.16,
      sign: Math.random() < 0.5 ? 1 : -1
    };
  }

  function makeShapes(base) {
    const counts = [3, 4, 5];
    const startIdx = Math.max(0, counts.indexOf(base.count));
    const shapes = [];
    for (let i = 0; i < 3; i++) {
      shapes.push({
        bearing: base.bearing + i * (2 * Math.PI / 5),
        count: counts[(startIdx + i) % 3],
        aspect: i === 0 ? base.aspect : 1,
        sign: base.sign
      });
    }
    return shapes;
  }

  function ring(origin, radius, shape) {
    const wps = [];
    for (let i = 0; i < shape.count; i++) {
      const theta = shape.bearing + shape.sign * (2 * Math.PI * i) / shape.count;
      const rough = 1 + 0.035 * Math.sin(shape.bearing * 2 + i * 2.3);
      const east = radius * Math.sin(theta) * shape.aspect * rough;
      const north = radius * Math.cos(theta) / shape.aspect * rough;
      const dist = Math.hypot(east, north);
      const brg = Math.atan2(east, north);
      wps.push(destination(origin.lat, origin.lon, brg, dist));
    }
    return { pts: [origin, ...wps, origin], wps };
  }

  function resample(coords, step) {
    if (!coords || coords.length < 2) return [];
    const out = [];
    let prev = { lat: coords[0][1], lon: coords[0][0] };
    let along = 0;
    let acc = 0;
    out.push({ lat: prev.lat, lon: prev.lon, along: 0 });
    for (let i = 1; i < coords.length; i++) {
      let cur = { lat: coords[i][1], lon: coords[i][0] };
      let seg = hav(prev, cur);
      if (seg < 0.4) { prev = cur; continue; }
      let walked = 0;
      while (acc + (seg - walked) >= step) {
        const need = step - acc;
        const t = (walked + need) / seg;
        const p = {
          lat: prev.lat + (cur.lat - prev.lat) * t,
          lon: prev.lon + (cur.lon - prev.lon) * t
        };
        along += need;
        out.push({ lat: p.lat, lon: p.lon, along });
        walked += need;
        acc = 0;
        prev = p;
      }
      acc += seg - walked;
      along += seg - walked;
      prev = cur;
    }
    const end = { lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] };
    const last = out[out.length - 1];
    if (last && hav(last, end) > 1.5) {
      out.push({ lat: end.lat, lon: end.lon, along: last.along + hav(last, end) });
    }
    return out;
  }

  function overlapFraction(coords) {
    const samples = resample(coords, 20);
    if (samples.length < 8) return 0;
    const total = samples[samples.length - 1].along;
    const origin = samples[0];
    const cos = Math.cos(toRad(origin.lat));
    const proj = samples.map((p) => ({
      x: (p.lon - origin.lon) * cos * 111320,
      y: (p.lat - origin.lat) * 110540,
      along: p.along
    }));
    const cell = 25;
    const grid = new Map();
    let overlap = 0;
    for (let i = 0; i < proj.length; i++) {
      const cx = Math.round(proj[i].x / cell);
      const cy = Math.round(proj[i].y / cell);
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const list = grid.get((cx + dx) + "," + (cy + dy));
          if (!list) continue;
          for (const j of list) {
            if (Math.abs(proj[i].along - proj[j].along) < 80) continue;
            const iEnd = proj[i].along < 45 || proj[i].along > total - 45;
            const jEnd = proj[j].along < 45 || proj[j].along > total - 45;
            if (iEnd && jEnd) continue;
            const ddx = proj[i].x - proj[j].x;
            const ddy = proj[i].y - proj[j].y;
            if (ddx * ddx + ddy * ddy < 18 * 18) { hit = true; break; }
          }
        }
      }
      if (hit) overlap++;
      const k = cx + "," + cy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    return overlap / proj.length;
  }

  function thin(coords, maxPts) {
    if (!coords || coords.length <= maxPts) return coords;
    const out = [];
    const step = (coords.length - 1) / (maxPts - 1);
    for (let i = 0; i < maxPts; i++) out.push(coords[Math.round(i * step)]);
    return out;
  }

  function pathKey(pts) {
    return pts.map((p) => p.lon.toFixed(5) + "," + p.lat.toFixed(5)).join(";");
  }

  function parseRoute(route) {
    const steps = [];
    (route.legs || []).forEach((leg) => {
      (leg.steps || []).forEach((s) => {
        const m = s.maneuver || {};
        steps.push({
          type: m.type || "continue",
          modifier: m.modifier || "",
          name: s.name || "",
          distance: s.distance || 0,
          location: m.location || null
        });
      });
    });
    const geometry = route.geometry && route.geometry.coordinates ? route.geometry.coordinates : [];
    return {
      distance: route.distance,
      geometry: thin(geometry, 900),
      steps,
      overlap: overlapFraction(geometry)
    };
  }

  async function politeWait() {
    const wait = 220 - (Date.now() - lastNet);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  async function fetchRoute(pts) {
    const key = pathKey(pts);
    if (routeCache.has(key)) return routeCache.get(key);
    const query = "?overview=full&geometries=geojson&steps=true&alternatives=false";
    let last = "no route";
    for (const base of ROUTERS) {
      try {
        await politeWait();
        lastNet = Date.now();
        const res = await fetchWithTimeout(base + key + query, 14000);
        if (!res.ok) { last = "HTTP " + res.status; continue; }
        const data = await res.json();
        if (data.code !== "Ok" || !data.routes || !data.routes[0]) {
          last = data.code || "no route";
          if (data.code === "NoRoute" || data.code === "NoSegment") break;
          continue;
        }
        const parsed = parseRoute(data.routes[0]);
        if (!parsed.geometry || parsed.geometry.length < 2) { last = "empty"; continue; }
        routeCache.set(key, parsed);
        saveRouteCache();
        return parsed;
      } catch (err) {
        last = err && err.name === "AbortError" ? "timeout" : "network";
      }
    }
    const error = new Error(last);
    error.noRoute = last === "NoRoute" || last === "NoSegment";
    throw error;
  }

  function overshoot(res, target) {
    return res.distance - target;
  }

  function isAim(res, target) {
    const over = overshoot(res, target);
    return over >= 0 && over <= aimOverMeters() && res.overlap <= 0.28;
  }

  function isHeavy(res) { return res.overlap >= 0.24; }

  function shorterOver(a, b) {
    if (!b) return true;
    if (Math.abs(a.distance - b.distance) > 8) return a.distance < b.distance;
    return a.overlap <= b.overlap;
  }

  async function routeShape(origin, radius, shape) {
    const built = ring(origin, radius, shape);
    try {
      const routed = await fetchRoute(built.pts);
      return {
        distance: routed.distance,
        geometry: routed.geometry,
        steps: routed.steps,
        overlap: routed.overlap,
        waypoints: built.wps,
        radius,
        shape
      };
    } catch (err) {
      if (err && err.noRoute) return null;
      throw err;
    }
  }

  async function planLoop(origin, target, baseSeed, onProgress) {
    const shapes = makeShapes(baseSeed);
    const aim = aimOverMeters();
    const outer = outerOverMeters(target);
    const hardCap = MAX_CALLS + 3;
    let calls = 0;
    let bestOver = null;
    let closestUnder = null;

    function consider(res) {
      res.calls = calls;
      if (res.distance >= target) {
        if (shorterOver(res, bestOver)) bestOver = res;
      } else if (!closestUnder || res.distance > closestUnder.distance) {
        closestUnder = res;
      }
    }

    function inAim() {
      return bestOver && overshoot(bestOver, target) <= aim && bestOver.overlap <= 0.28;
    }

    for (let s = 0; s < shapes.length && calls < MAX_CALLS; s++) {
      if (inAim()) break;
      const shape = shapes[s];
      const more = s < shapes.length - 1;
      // A hair longer than target / (2π·1.3), so the first try leans over.
      let r = target / (2 * Math.PI * DETOUR) * 1.02;
      let under = null;
      let over = null;
      const budget = Math.min(4, MAX_CALLS - calls);
      for (let attempt = 0; attempt < budget && calls < MAX_CALLS; attempt++) {
        onProgress({
          calls: calls + 1,
          max: MAX_CALLS,
          radius: r,
          phase: attempt === 0 && s > 0 ? "rotate" : "fit"
        });
        const res = await routeShape(origin, r, shape);
        calls++;
        if (!res) {
          r *= 1.15;
          continue;
        }
        consider(res);
        if (inAim()) return { ...bestOver, calls };
        if (attempt === 0 && isHeavy(res) && more) break;
        if (res.distance < target) {
          if (!under || res.distance > under.d) under = { r, d: res.distance };
        } else if (!over || res.distance < over.d) {
          over = { r, d: res.distance };
        }
        let next;
        if (under && over && over.d !== under.d) {
          const gapR = Math.abs(over.r - under.r) / Math.min(over.r, under.r);
          if (gapR < 0.04 && (over.d - target) > outer) break;
          const aimPoint = target + Math.min(aim * 0.45, 0.015 * MI);
          let t = (aimPoint - under.d) / (over.d - under.d);
          t = Math.min(0.82, Math.max(0.18, t));
          next = under.r + t * (over.r - under.r);
        } else if (res.distance < target) {
          const scale = Math.min(1.7, Math.max(1.06, (target / res.distance) * 1.05));
          next = r * scale;
        } else {
          if (overshoot(res, target) <= aim) break;
          const scale = Math.min(0.97, Math.max(0.75, target / res.distance));
          next = r * scale;
        }
        next = Math.max(40, Math.min(next, target * 0.9));
        if (Math.abs(next - r) < 8) break;
        r = next;
      }
    }

    // Nothing long enough yet: grow the closest short loop until it crosses.
    if (!bestOver && closestUnder && calls < hardCap) {
      let r = closestUnder.radius;
      let d = closestUnder.distance;
      const shape = closestUnder.shape;
      while (calls < hardCap && d < target) {
        const next = Math.min(target * 0.9, r * Math.min(1.7, Math.max(1.08, (target / d) * 1.06)));
        if (next < r + 8) break;
        onProgress({ calls: calls + 1, max: hardCap, radius: next, phase: "fit" });
        const res = await routeShape(origin, next, shape);
        calls++;
        if (!res) {
          r = next;
          continue;
        }
        consider(res);
        r = res.radius;
        d = res.distance;
        if (inAim()) break;
        if (d >= target && closestUnder && calls < hardCap && overshoot(res, target) > aim) {
          const aimPoint = target + Math.min(aim * 0.45, 0.015 * MI);
          let t = (aimPoint - closestUnder.distance) / (res.distance - closestUnder.distance);
          t = Math.min(0.82, Math.max(0.18, t));
          const tween = closestUnder.radius + t * (res.radius - closestUnder.radius);
          if (Math.abs(tween - res.radius) > 8) {
            onProgress({ calls: calls + 1, max: hardCap, radius: tween, phase: "fit" });
            const tighter = await routeShape(origin, tween, shape);
            calls++;
            if (tighter) consider(tighter);
          }
          break;
        }
      }
    }

    if (bestOver) return { ...bestOver, calls };
    return null;
  }

  function presentSteps(steps) {
    const out = [];
    steps.forEach((step) => {
      const sharp = step.modifier === "uturn" || String(step.modifier).indexOf("sharp") === 0;
      const keep = step.type === "depart" || step.type === "arrive" || step.distance >= 22 || sharp;
      if (!keep && out.length) {
        out[out.length - 1].distance += step.distance;
        return;
      }
      out.push({ ...step });
    });
    let acc = 0;
    out.forEach((step) => {
      acc += step.distance;
      step.endAlong = acc;
    });
    return out;
  }

  function instruction(step) {
    const name = step.name ? " onto " + step.name : "";
    const onto = step.name ? " on " + step.name : " on the path";
    const dirs = {
      left: "Turn left",
      right: "Turn right",
      "slight left": "Bear left",
      "slight right": "Bear right",
      "sharp left": "Sharp left",
      "sharp right": "Sharp right",
      straight: "Continue straight",
      uturn: "Make a U-turn"
    };
    if (step.type === "depart") {
      if (step.modifier && dirs[step.modifier]) {
        return dirs[step.modifier].replace("Turn ", "Head ").replace("Bear ", "Head ") + onto;
      }
      return step.name ? "Head out on " + step.name : "Head out on the path";
    }
    if (step.type === "arrive") return "Arrive back at the start";
    if (step.type === "roundabout" || step.type === "rotary") {
      return "Take the roundabout" + (step.name ? " toward " + step.name : "");
    }
    if (step.type === "fork") return (step.modifier ? "Keep " + step.modifier : "Keep ahead") + name;
    if (step.type === "merge") return "Merge" + (step.modifier ? " " + step.modifier : "") + name;
    if (step.type === "new name" || step.type === "continue") {
      return step.name ? "Continue on " + step.name : "Continue straight";
    }
    if (step.type === "end of road" || step.type === "turn") {
      return (dirs[step.modifier] || "Turn") + name;
    }
    return (dirs[step.modifier] || "Continue") + (step.name ? " on " + step.name : "");
  }

  function renderTurns(steps, active) {
    const list = $("turns");
    const shown = presentSteps(steps || []);
    currentShown = shown;
    if (!shown.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = shown.map((step, i) => {
      const cls = i === active ? " class=\"on\"" : "";
      return "<li" + cls + "><span>" + esc(instruction(step)) + "</span><span class=\"d\">" +
        esc(formatStepDist(step.distance)) + "</span></li>";
    }).join("");
  }

  let currentShown = [];

  function activeStep(along) {
    for (let i = 0; i < currentShown.length; i++) {
      if (along < currentShown[i].endAlong - 8) return i;
    }
    return Math.max(0, currentShown.length - 1);
  }

  function syncPaceField() {
    paceInput.value = String(Math.round(paceShown()));
    $("paceUnit").textContent = unit === "mi" ? "min/mi" : "min/km";
    $("etaLabel").textContent = unit === "mi"
      ? "at " + Math.round(paceMinPerMile) + " min/mi"
      : "at " + Math.round(paceShown()) + " min/km";
  }

  function renderChips() {
    chipsEl.innerHTML = CHIPS_MI.map((mi) => {
      const label = unit === "mi"
        ? String(mi)
        : (mi * 1.609344).toFixed(mi >= 2 ? 1 : 2).replace(/\.0$/, "");
      return "<button type=\"button\" data-mi=\"" + mi + "\">" + label + "</button>";
    }).join("");
    highlightChip();
  }

  function highlightChip() {
    const meters = targetMeters();
    chipsEl.querySelectorAll("button").forEach((btn) => {
      const mi = parseFloat(btn.getAttribute("data-mi"));
      const on = meters != null && Math.abs(meters - mi * MI) < 30;
      btn.classList.toggle("on", on);
    });
  }

  function syncUnitButton() {
    unitBtn.textContent = unit === "mi" ? "Miles" : "Km";
    unitBtn.setAttribute("aria-pressed", unit === "km" ? "true" : "false");
    $("actualUnit").textContent = unitWord();
  }

  function showResult(loop) {
    const meters = loop.distance;
    const target = loop.target;
    resultEl.dataset.ready = "1";
    resultEl.dataset.meters = String(meters);
    resultEl.dataset.miles = String(meters / MI);
    resultEl.dataset.calls = String(loop.calls || 0);
    resultEl.dataset.overlap = String(loop.overlap || 0);
    resultEl.dataset.targetMiles = String(target / MI);
    const shown = formatLoopDistance(meters, target);
    const shownTarget = formatDist(target);
    resultEl.dataset.shown = shown;
    $("actualValue").textContent = shown;
    $("actualUnit").textContent = unitWord();
    $("eta").textContent = formatEta(meters);
    const over = meters - target;
    const outer = outerOverMeters(target);
    const within = over >= 0 && over <= outer;
    const deltaNum = Number(shown) - Number(shownTarget);
    const delta = Math.abs(deltaNum).toFixed(2);
    const sign = deltaNum >= 0 ? "+" : "−";
    $("resultMeta").textContent = within
      ? "Target " + shownTarget + " " + unitWord() + " · " + sign + delta + " " + unitWord()
      : "Over the target. Target " + shownTarget + " " + unitWord() + " · " + sign + delta + " " + unitWord();
  }

  function syncControls() {
    const ready = !!(current && !running && !walking);
    $("generate").disabled = running || walking || !start;
    $("newLoop").disabled = running || walking || !start;
    $("reverse").disabled = !ready;
    $("startWalk").disabled = !ready;
    $("saveFav").disabled = !ready;
    $("exportGpx").disabled = !current || running;
    $("locate").disabled = running || walking;
    $("setStart").disabled = running || walking;
    $("setStart").classList.toggle("arm", arming);
    $("setStart").textContent = arming ? "Tap the map…" : "Tap map to set start";
    $("map").classList.toggle("arming", arming);
    distanceInput.disabled = walking;
    paceInput.disabled = false;
    unitBtn.disabled = walking;
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    map.setView([39.5, -98.35], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    map.attributionControl.setPosition("topright");
    routeLayer = L.layerGroup().addTo(map);
    walkedLayer = L.layerGroup().addTo(map);
    map.on("click", (e) => {
      if (!arming || walking) return;
      arming = false;
      setStart({ lat: e.latlng.lat, lon: e.latlng.lng, source: "map" });
      toast("Start set on the map");
    });
    setTimeout(() => map.invalidateSize(), 60);
  }

  function setStart(next) {
    const moved = !start || hav(start, next) > 12;
    start = { lat: next.lat, lon: next.lon, source: next.source || "gps", accuracy: next.accuracy };
    startInfo.dataset.ready = "1";
    startInfo.dataset.lat = start.lat.toFixed(5);
    startInfo.dataset.lon = start.lon.toFixed(5);
    const acc = start.accuracy ? " · ±" + Math.round(start.accuracy) + " m" : "";
    const how = start.source === "map" ? "Map pin" : "GPS";
    startInfo.textContent = how + " " + start.lat.toFixed(4) + ", " + start.lon.toFixed(4) + acc;
    if (!startMarker) {
      startMarker = L.marker([start.lat, start.lon], {
        icon: L.divIcon({
          className: "pin-wrap",
          html: "<div class=\"pin\"></div><div class=\"pin-label\">START</div>",
          iconSize: [64, 28],
          iconAnchor: [9, 22]
        }),
        zIndexOffset: 500
      }).addTo(map);
    } else {
      startMarker.setLatLng([start.lat, start.lon]);
    }
    if (!current) map.setView([start.lat, start.lon], Math.max(map.getZoom(), 16));
    if (moved && current && !walking) {
      clearLoop();
      setStatus("Start moved. Generate a loop from here.");
    } else if (!current) {
      setStatus("Start set. Pick a distance and generate a loop.");
    }
    syncControls();
  }

  function clearLoop() {
    current = null;
    resultEl.dataset.ready = "0";
    $("actualValue").textContent = "—";
    $("eta").textContent = "—";
    $("resultMeta").textContent = "";
    $("turns").innerHTML = "";
    routeLayer.clearLayers();
    walkedLayer.clearLayers();
    syncControls();
  }

  function samplesFor(geometry) {
    const samples = resample(geometry, 10);
    if (!samples.length) return samples;
    const origin = samples[0];
    const cos = Math.cos(toRad(origin.lat));
    samples.forEach((p) => {
      p.x = (p.lon - origin.lon) * cos * 111320;
      p.y = (p.lat - origin.lat) * 110540;
    });
    return samples;
  }

  function drawLoop(loop) {
    routeLayer.clearLayers();
    walkedLayer.clearLayers();
    const ll = loop.geometry.map(([lon, lat]) => [lat, lon]);
    L.polyline(ll, { color: "#ffffff", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    L.polyline(ll, { color: "#1a73e8", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    const samples = loop.samples || [];
    const spacing = unit === "mi" ? 0.2 * MI : 300;
    const markEvery = unit === "mi" ? MI : 1000;
    for (let i = 1; i < samples.length; i++) {
      const along = samples[i].along;
      if (along < 40 || along > loop.distance - 30) continue;
      const ahead = samples[Math.min(samples.length - 1, i + 3)];
      const prev = samples[i - 1].along;
      const arrowHere = Math.floor(along / spacing) !== Math.floor(prev / spacing);
      const mileHere = Math.floor(along / markEvery) !== Math.floor(prev / markEvery);
      if (arrowHere && along < loop.distance - 40) {
        const deg = bearingDeg(samples[i], ahead);
        const icon = L.divIcon({
          className: "arrow-wrap",
          html: "<b style=\"transform:rotate(" + deg.toFixed(1) + "deg)\"></b>",
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        });
        L.marker([samples[i].lat, samples[i].lon], { icon, interactive: false }).addTo(routeLayer);
      }
      if (mileHere) {
        const n = Math.round(along / markEvery);
        const label = unit === "mi" ? n + " mi" : n + " km";
        const icon = L.divIcon({
          className: "mile-wrap",
          html: "<span>" + esc(label) + "</span>",
          iconSize: [36, 18],
          iconAnchor: [18, 9]
        });
        L.marker([samples[i].lat, samples[i].lon], { icon, interactive: false, zIndexOffset: 400 }).addTo(routeLayer);
      }
    }
    if (startMarker) startMarker.setLatLng([loop.start.lat, loop.start.lon]);
    const bounds = L.latLngBounds(ll);
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [28, 28] });
    renderTurns(loop.steps, walking ? activeStep(maxAlong) : -1);
    showResult(loop);
    syncControls();
  }

  function applyLoop(found, target, usedSeed) {
    current = {
      start: { lat: start.lat, lon: start.lon },
      target,
      distance: found.distance,
      geometry: found.geometry,
      steps: found.steps,
      waypoints: found.waypoints,
      overlap: found.overlap,
      calls: found.calls,
      seed: usedSeed,
      shape: found.shape,
      radius: found.radius
    };
    resultEl.dataset.gen = String(Number(resultEl.dataset.gen || "0") + 1);
    current.samples = samplesFor(current.geometry);
    drawLoop(current);
    const over = found.distance - target;
    const ok = over >= 0 && over <= outerOverMeters(target);
    setStatus(ok ? "Loop ready." : "A bit over the target. Actual distance is shown.");
  }

  async function generate(fresh) {
    if (running || walking) return;
    if (!start) {
      setStatus("Set a start first — allow location, or tap the map.");
      arming = true;
      syncControls();
      return;
    }
    const target = targetMeters();
    if (target == null) {
      setStatus("Enter a distance.");
      return;
    }
    if (target < 0.25 * MI || target > 8 * MI) {
      setStatus("Pick a distance between 0.25 and 8 miles.");
      return;
    }
    if (fresh || !seed) seed = randomSeed();
    const token = ++runToken;
    running = true;
    resultEl.dataset.ready = "0";
    syncControls();
    setStatus("Scouting streets…");
    try {
      const found = await planLoop(start, target, seed, (info) => {
        if (token !== runToken) return;
        const radiusLabel = unit === "mi"
          ? (info.radius / MI).toFixed(2) + " mi"
          : (info.radius / 1000).toFixed(2) + " km";
        const phase = info.phase === "rotate" ? "Trying another direction" : "Scouting streets";
        setStatus(phase + "… pass " + info.calls + " of " + info.max + " · radius " + radiusLabel);
      });
      if (token !== runToken) return;
      if (!found || found.distance < target) {
        setStatus("Couldn't build a loop at least as long as the target. Try New Loop.");
        return;
      }
      applyLoop(found, target, seed);
    } catch (err) {
      if (token !== runToken) return;
      setStatus("The router didn't answer. Wait a moment and try again.");
    } finally {
      if (token === runToken) {
        running = false;
        syncControls();
      }
    }
  }

  const FLIP = {
    left: "right",
    right: "left",
    "slight left": "slight right",
    "slight right": "slight left",
    "sharp left": "sharp right",
    "sharp right": "sharp left",
    uturn: "uturn",
    straight: "straight"
  };

  function reverseLocal(loop) {
    const steps = (loop.steps || []).map((s) => ({
      ...s,
      modifier: FLIP[s.modifier] || s.modifier
    })).reverse();
    if (steps.length) {
      steps[0] = { ...steps[0], type: "depart" };
      steps[steps.length - 1] = { ...steps[steps.length - 1], type: "arrive", distance: 0 };
    }
    return {
      ...loop,
      geometry: loop.geometry.slice().reverse(),
      steps,
      waypoints: (loop.waypoints || []).slice().reverse()
    };
  }

  async function reverse() {
    if (!current || running || walking) return;
    const token = ++runToken;
    running = true;
    syncControls();
    setStatus("Reversing direction…");
    const wps = (current.waypoints || []).slice().reverse();
    try {
      const routed = await fetchRoute([current.start, ...wps, current.start]);
      if (token !== runToken) return;
      if (routed.distance >= current.target) {
        current = {
          ...current,
          geometry: routed.geometry,
          steps: routed.steps,
          distance: routed.distance,
          overlap: routed.overlap,
          waypoints: wps
        };
      } else {
        current = reverseLocal(current);
      }
    } catch (e) {
      if (token !== runToken) return;
      current = reverseLocal(current);
    }
    current.samples = samplesFor(current.geometry);
    drawLoop(current);
    setStatus("Direction reversed.");
    running = false;
    syncControls();
  }

  function locate() {
    if (!navigator.geolocation) {
      arming = true;
      setStatus("This browser has no GPS. Tap the map to set the start.");
      syncControls();
      return;
    }
    setStatus("Finding your position…");
    navigator.geolocation.getCurrentPosition((pos) => {
      arming = false;
      setStart({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        source: "gps",
        accuracy: pos.coords.accuracy
      });
    }, () => {
      navigator.geolocation.getCurrentPosition((pos) => {
        arming = false;
        setStart({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          source: "gps",
          accuracy: pos.coords.accuracy
        });
      }, () => {
        arming = true;
        setStatus("Location is off. Tap the map to set the start.");
        syncControls();
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
  }

  function project(point, samples, hint) {
    if (!samples || samples.length < 2) return null;
    const origin = samples[0];
    const cos = Math.cos(toRad(origin.lat));
    const q = {
      x: (point.lon - origin.lon) * cos * 111320,
      y: (point.lat - origin.lat) * 110540
    };
    let minOff = Infinity;
    const options = [];
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = 0;
      if (len2 > 0.01) {
        t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
      }
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const off = Math.hypot(q.x - px, q.y - py);
      const along = a.along + t * (b.along - a.along);
      if (off < minOff) minOff = off;
      options.push({ off, along });
    }
    // GPS can sit between two close passes of the loop. Trust the nearest
    // line, and only then the pass that matches how far we've already walked.
    const near = options.filter((o) => o.off <= minOff + 12);
    near.sort((a, b) => Math.abs(a.along - hint) - Math.abs(b.along - hint));
    return near[0] || null;
  }

  function updateWalkHud(offRoute) {
    if (!current) return;
    const total = current.distance;
    const walked = Math.min(total, maxAlong);
    const left = Math.max(0, total - walked);
    $("walked").textContent = formatDist(walked);
    $("remain").textContent = formatDist(left);
    $("walkedLbl").textContent = "walked " + unitWord();
    $("remainLbl").textContent = "left " + unitWord();
    $("elapsed").textContent = formatClock(Date.now() - walkStarted);
    $("walkBar").style.width = (total ? (100 * walked / total) : 0).toFixed(1) + "%";
    $("offRoute").hidden = !offRoute;
    const idx = activeStep(walked);
    renderTurns(current.steps, idx);
    const step = currentShown[idx];
    if (left < 25 && walked > total * 0.5) {
      $("nextTurn").textContent = "Dungeon cleared. You're back at the gate.";
      setStatus("Run cleared.");
    } else if (step) {
      $("nextTurn").textContent = instruction(step);
    }
    $("eta").textContent = formatEta(left);
    $("etaLabel").textContent = "left at this pace";
  }

  async function lockScreen() {
    $("wakeNote").hidden = true;
    if (!("wakeLock" in navigator)) {
      $("wakeNote").hidden = false;
      $("wakeNote").textContent = "This browser can't hold the screen awake. Tap it if it dims.";
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {
      $("wakeNote").hidden = false;
      $("wakeNote").textContent = "Couldn't keep the screen awake. Tap it if it dims.";
    }
  }

  async function unlockScreen() {
    try { if (wakeLock) await wakeLock.release(); } catch (e) { /* already released */ }
    wakeLock = null;
  }

  function ensureUserDot(lat, lon) {
    if (!userMarker) {
      userMarker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: "user-wrap",
          html: "<div class=\"pulse\"></div>",
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        }),
        zIndexOffset: 800
      }).addTo(map);
    } else {
      userMarker.setLatLng([lat, lon]);
    }
  }

  function startWalk() {
    if (!current || walking) return;
    walking = true;
    maxAlong = 0;
    walkStarted = Date.now();
    document.body.classList.add("walking");
    syncControls();
    setStatus("Walk in progress. Follow the blue line home.");
    updateWalkHud(false);
    lockScreen();
    if (!navigator.geolocation) {
      setStatus("No GPS — the timer is running, but distance can't update.");
      walkTimer = setInterval(() => updateWalkHud(false), 1000);
      return;
    }
    watchId = navigator.geolocation.watchPosition((pos) => {
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      ensureUserDot(p.lat, p.lon);
      const proj = project(p, current.samples, maxAlong);
      let off = false;
      if (proj && proj.off <= 55) {
        const delta = proj.along - maxAlong;
        // Ignore a backwards flicker, and a leap to the far side of a long loop.
        if (delta >= -40 && delta <= 2000) maxAlong = Math.max(maxAlong, proj.along);
      } else if (proj && proj.off > 55) {
        off = true;
      }
      updateWalkHud(off);
    }, () => {
      setStatus("GPS stalled. The timer is still running.");
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    walkTimer = setInterval(() => updateWalkHud(!$("offRoute").hidden), 1000);
  }

  function endWalk() {
    walking = false;
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (walkTimer) clearInterval(walkTimer);
    walkTimer = null;
    unlockScreen();
    document.body.classList.remove("walking");
    if (userMarker) {
      map.removeLayer(userMarker);
      userMarker = null;
    }
    if (current) {
      showResult(current);
      renderTurns(current.steps, -1);
      setStatus("Walk ended. The loop is still on the map.");
    }
    syncControls();
  }

  function buildGpx(loop) {
    const miles = (loop.distance / MI).toFixed(2);
    const name = "Loop Quest " + miles + " mi";
    const pts = loop.geometry.map(([lon, lat]) =>
      "      <trkpt lat=\"" + lat.toFixed(6) + "\" lon=\"" + lon.toFixed(6) + "\"></trkpt>"
    ).join("\n");
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
      "<gpx version=\"1.1\" creator=\"Loop Quest\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n" +
      "  <metadata><name>" + esc(name) + "</name></metadata>\n" +
      "  <trk><name>" + esc(name) + "</name><trkseg>\n" + pts + "\n  </trkseg></trk>\n</gpx>\n";
  }

  function exportGpx() {
    if (!current) return;
    const blob = new Blob([buildGpx(current)], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    const miles = (current.distance / MI).toFixed(2);
    a.href = URL.createObjectURL(blob);
    a.download = "loop-quest-" + miles + "mi.gpx";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  function readFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function writeFavs(list) {
    localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 15)));
  }

  function renderFavs() {
    const list = readFavs();
    const ul = $("favList");
    if (!list.length) {
      ul.innerHTML = "<li class=\"mute\">No saved runs yet.</li>";
      return;
    }
    ul.innerHTML = list.map((fav) =>
      "<li><button type=\"button\" class=\"linkish\" data-id=\"" + esc(fav.id) + "\">" + esc(fav.name) +
      "</button><button type=\"button\" class=\"btn danger\" data-del=\"" + esc(fav.id) + "\" aria-label=\"Delete\">×</button></li>"
    ).join("");
  }

  function saveFavorite() {
    if (!current) return;
    const miles = (current.distance / MI).toFixed(2);
    const fav = {
      id: Date.now().toString(36),
      name: "Dungeon Run · " + formatLoopDistance(current.distance, current.target) + " " + unitWord(),
      savedAt: Date.now(),
      unit,
      paceMinPerMile,
      target: current.target,
      distance: current.distance,
      start: current.start,
      waypoints: current.waypoints,
      geometry: current.geometry,
      steps: current.steps,
      seed: current.seed,
      overlap: current.overlap,
      milesLabel: miles
    };
    try {
      const list = readFavs();
      list.unshift(fav);
      writeFavs(list);
      renderFavs();
      toast("Saved on this phone");
    } catch (e) {
      toast("Couldn't save — storage is full");
    }
  }

  function loadFavorite(id) {
    const fav = readFavs().find((f) => f.id === id);
    if (!fav || walking) return;
    start = { lat: fav.start.lat, lon: fav.start.lon, source: "map" };
    setStart(start);
    seed = fav.seed || randomSeed();
    current = {
      start: fav.start,
      target: fav.target,
      distance: fav.distance,
      geometry: fav.geometry,
      steps: fav.steps || [],
      waypoints: fav.waypoints || [],
      overlap: fav.overlap || 0,
      calls: 0,
      seed
    };
    current.samples = samplesFor(current.geometry);
    const shown = unit === "mi" ? fav.target / MI : fav.target / 1000;
    distanceInput.value = String(Math.round(shown * 100) / 100);
    highlightChip();
    drawLoop(current);
    setStatus("Saved run loaded. No new route request.");
  }

  function deleteFavorite(id) {
    writeFavs(readFavs().filter((f) => f.id !== id));
    renderFavs();
  }

  function onPaceInput() {
    let v = parseFloat(paceInput.value);
    if (!isFinite(v)) return;
    v = Math.min(40, Math.max(12, v));
    paceMinPerMile = unit === "mi" ? v : v * 1.609344;
    saveSettings();
    syncPaceField();
    if (current && !walking) showResult(current);
    if (walking) updateWalkHud(!$("offRoute").hidden);
  }

  function switchUnit() {
    const meters = targetMeters();
    unit = unit === "mi" ? "km" : "mi";
    if (meters) {
      distanceInput.value = unit === "mi"
        ? (Math.round((meters / MI) * 100) / 100).toString()
        : (Math.round((meters / 1000) * 100) / 100).toString();
    }
    saveSettings();
    syncUnitButton();
    syncPaceField();
    renderChips();
    if (current) drawLoop(current);
  }

  function boot() {
    if (typeof L === "undefined") {
      setStatus("The map library didn't load. Check your connection and reload.");
      return;
    }
    loadSettings();
    loadRouteCache();
    syncUnitButton();
    syncPaceField();
    renderChips();
    renderFavs();
    initMap();
    syncControls();
    locate();

    $("generate").addEventListener("click", () => generate(false));
    $("newLoop").addEventListener("click", () => generate(true));
    $("reverse").addEventListener("click", reverse);
    $("locate").addEventListener("click", locate);
    $("setStart").addEventListener("click", () => {
      arming = !arming;
      setStatus(arming ? "Tap the map to drop the start." : "Map tap cancelled.");
      syncControls();
    });
    $("startWalk").addEventListener("click", startWalk);
    $("endWalk").addEventListener("click", endWalk);
    $("saveFav").addEventListener("click", saveFavorite);
    $("exportGpx").addEventListener("click", exportGpx);
    unitBtn.addEventListener("click", switchUnit);
    paceInput.addEventListener("change", onPaceInput);
    distanceInput.addEventListener("input", () => { highlightChip(); });
    distanceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") generate(false);
    });
    chipsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const mi = parseFloat(btn.getAttribute("data-mi"));
      distanceInput.value = unit === "mi"
        ? String(mi)
        : (Math.round(mi * 1.609344 * 100) / 100).toString();
      highlightChip();
    });
    $("favList").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { deleteFavorite(del.getAttribute("data-del")); return; }
      const open = e.target.closest("[data-id]");
      if (open) loadFavorite(open.getAttribute("data-id"));
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && walking) lockScreen();
    });
    window.addEventListener("resize", () => { if (map) map.invalidateSize(); });

    window.__loopQuest = {
      get current() { return current; },
      get start() { return start; },
      buildGpx
    };
  }

  boot();
})();
