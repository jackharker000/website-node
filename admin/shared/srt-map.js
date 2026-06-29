/* =============================================================================
 * srt-map.js — shared Leaflet + race helpers for both dashboards.
 *
 * Pure geometry + Leaflet rendering, no API calls. Ports the good parts of the
 * Phase-0 loop.html replay engine (leg detection, wind-from-course, boat/mark
 * icons, course outline, start line) and themes them with the brand palette.
 *
 * The course model mirrors Phase 2:
 *   marks      : [ { id, name, type, lat, lon, seq } ]   (type ∈ start|windward|leeward|finish|wing)
 *   leg_marks  : ordered rounding sequence of mark ids, repeats allowed e.g. [1,2,3,2,4]
 *   leg_labels : human labels per leg e.g. ["Start","Beat 1","Run 1","Beat 2","Finish"]
 * ===========================================================================*/

(function (global) {
  'use strict';

  // ---- brand tokens (from website/css/styles.css) ----
  const BRAND = {
    navy: '#0b1b30', navy2: '#102444',
    primary: '#0b5fff', primary700: '#0a47cf',
    accent: '#ff5a3c',  // buoy coral — marks & alerts
    cyan: '#16b6d8',
    line: '#e4ebf4',
  };

  // Fallback per-boat palette when a boat has no colour set.
  const BOAT_PALETTE = [
    '#0b5fff', '#ff5a3c', '#16b6d8', '#27ae60', '#f39c12',
    '#9b59b6', '#e91e63', '#00bcd4', '#ff9800', '#8bc34a',
  ];

  // Mark type -> [fill colour, short label]. Coral for the buoys/marks.
  const MARK_STYLE = {
    start:    ['#ff5a3c', 'S'],
    committee:['#ff5a3c', 'CB'],
    windward: ['#ff5a3c', 'W'],
    leeward:  ['#9b59b6', 'L'],
    wing:     ['#16b6d8', 'G'],
    finish:   ['#27ae60', 'F'],
    mark:     ['#ff5a3c', '•'],
  };

  // ---- geometry helpers (equirectangular, fine for a race area) ----
  function distM(la1, lo1, la2, lo2) {
    const a = (la2 - la1) * 111320;
    const b = (lo2 - lo1) * 111320 * Math.cos((la1 + la2) / 2 * Math.PI / 180);
    return Math.sqrt(a * a + b * b);
  }
  function brg(la1, lo1, la2, lo2) {
    const a = (la2 - la1) * 111320;
    const b = (lo2 - lo1) * 111320 * Math.cos((la1 + la2) / 2 * Math.PI / 180);
    return ((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360;
  }
  function deg2dir(d) {
    return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fmtClock(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function boatColour(boat, idx) {
    return boat && boat.colour ? boat.colour : BOAT_PALETTE[idx % BOAT_PALETTE.length];
  }

  // ---- Leaflet icon factories ----
  function boatIcon(colour, hdgDeg) {
    return L.divIcon({
      className: 'srt-boat', iconSize: [28, 28], iconAnchor: [14, 14],
      html: `<div style="width:28px;height:28px;transform:rotate(${hdgDeg || 0}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,.45))">
        <svg width="28" height="28" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
          <polygon points="10,2 15,18 10,14 5,18" fill="${colour}" stroke="rgba(255,255,255,.85)" stroke-width="1.5" stroke-linejoin="round"/>
        </svg></div>`,
    });
  }
  function markIcon(type) {
    const [c, l] = MARK_STYLE[type] || MARK_STYLE.mark;
    return L.divIcon({
      className: '', iconSize: [22, 22], iconAnchor: [11, 11],
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${c};
        border:2px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;
        font:700 9px Inter,sans-serif;color:#fff;box-shadow:0 1px 6px rgba(0,0,0,.5)">${l}</div>`,
    });
  }

  /* -----------------------------------------------------------------------
   * Course — wraps a Phase-2 course object and renders it on a map.
   *   const course = new SrtCourse(courseObj);  // { marks, leg_marks, leg_labels }
   *   course.draw(map);
   *   course.bounds();        // L.latLngBounds over the marks
   *   course.windFrom();      // estimated wind bearing (deg, from start->first mark)
   *   course.legTargets();    // [{lat,lon,label}] rounding points for leaderboard
   * --------------------------------------------------------------------- */
  class SrtCourse {
    constructor(course) {
      this.raw = course || {};
      this.marks = (course && course.marks) || [];
      this.legMarks = (course && course.leg_marks) || [];
      this.legLabels = (course && course.leg_labels) || [];
      this._byId = {};
      this.marks.forEach(m => { this._byId[m.id] = m; });
      this._layers = [];
      // Start line = first two marks of type start/committee, else first two marks.
      const starts = this.marks.filter(m => m.type === 'start' || m.type === 'committee');
      this.startA = starts[0] || this.marks[0] || null;
      this.startB = starts[1] || this.marks[1] || this.startA;
      this.lineMid = this.startA && this.startB
        ? { lat: (this.startA.lat + this.startB.lat) / 2, lon: (this.startA.lon + this.startB.lon) / 2 }
        : (this.startA ? { lat: this.startA.lat, lon: this.startA.lon } : null);
    }

    markById(id) { return this._byId[id] || null; }

    legTargets() {
      // Map each leg_marks entry to its mark; fall back to the finish mark or line.
      const finish = this.marks.find(m => m.type === 'finish');
      const out = [];
      this.legMarks.forEach((mid, i) => {
        const m = this._byId[mid] || finish || null;
        if (m) out.push({ lat: m.lat, lon: m.lon, label: this.legLabels[i] || ('Leg ' + (i + 1)) });
      });
      return out;
    }

    bounds() {
      if (!this.marks.length) return null;
      return L.latLngBounds(this.marks.map(m => [m.lat, m.lon]));
    }

    windFrom() {
      const t = this.legTargets();
      if (this.lineMid && t.length) return brg(this.lineMid.lat, this.lineMid.lon, t[0].lat, t[0].lon);
      return 0;
    }

    clear() { this._layers.forEach(l => l.remove()); this._layers = []; }

    draw(map, opts = {}) {
      this.clear();
      const dark = opts.dark !== false;
      // start line
      if (this.startA && this.startB && this.startA !== this.startB) {
        this._layers.push(L.polyline(
          [[this.startA.lat, this.startA.lon], [this.startB.lat, this.startB.lon]],
          { color: BRAND.accent, weight: 4, opacity: .9 }).addTo(map));
      }
      // rounding outline through the leg targets, back to the line
      const targets = this.legTargets();
      if (this.lineMid && targets.length) {
        const path = [[this.lineMid.lat, this.lineMid.lon]]
          .concat(targets.map(t => [t.lat, t.lon]));
        this._layers.push(L.polyline(path, {
          color: dark ? 'rgba(255,255,255,.28)' : 'rgba(11,27,48,.32)',
          weight: 2, dashArray: '5,7',
        }).addTo(map));
      }
      // marks
      this.marks.forEach(m => {
        const mk = L.marker([m.lat, m.lon], { icon: markIcon(m.type), zIndexOffset: 500 }).addTo(map);
        mk.bindTooltip(m.name || m.type || 'Mark', { direction: 'top' });
        this._layers.push(mk);
      });
      return this;
    }
  }

  /* -----------------------------------------------------------------------
   * Leg detection for a single boat's position history (for the leaderboard).
   * Counts a leg complete when the boat passes within `radius` m of the target.
   * Returns the current leg index (0..N) and whether finished.
   * --------------------------------------------------------------------- */
  function computeLeg(positions, targets, radius) {
    radius = radius || 85;
    const NL = targets.length;
    let leg = 0, cd = 0;
    for (let i = 0; i < positions.length; i++) {
      if (leg >= NL) break;
      if (cd > 0) { cd--; continue; }
      const tgt = targets[leg];
      const p = positions[i];
      if (distM(p.lat, p.lon, tgt.lat, tgt.lon) < radius) { leg++; cd = 2; }
    }
    return { leg, finished: leg >= NL && NL > 0 };
  }

  // Wind dial on a <canvas>. wfrom = bearing the wind is coming FROM (deg).
  function drawWindDial(canvas, wfrom, dark) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, cx = W / 2, cy = W / 2, r = W / 2 - 5;
    const mut = dark ? '#8fb0c4' : '#5b6b82';
    const acc = dark ? BRAND.cyan : BRAND.primary;
    ctx.clearRect(0, 0, W, W);
    ctx.globalAlpha = .5; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = mut; ctx.lineWidth = 1; ctx.stroke();
    [0, 90, 180, 270].forEach(a => {
      const ra = (a - 90) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ra) * (r - 4), cy + Math.sin(ra) * (r - 4));
      ctx.lineTo(cx + Math.cos(ra) * r, cy + Math.sin(ra) * r);
      ctx.strokeStyle = mut; ctx.lineWidth = 1; ctx.stroke();
    });
    ctx.globalAlpha = 1;
    const ca = (wfrom - 90) * Math.PI / 180;
    const tx = cx + Math.cos(ca) * (r - 3), ty = cy + Math.sin(ca) * (r - 3);
    const hx = cx - Math.cos(ca) * (r - 3), hy = cy - Math.sin(ca) * (r - 3);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
    ctx.strokeStyle = acc; ctx.lineWidth = 2.5; ctx.stroke();
    const ang = Math.atan2(hy - ty, hx - tx);
    ctx.beginPath(); ctx.moveTo(hx, hy);
    ctx.lineTo(hx - 8 * Math.cos(ang - .38), hy - 8 * Math.sin(ang - .38));
    ctx.lineTo(hx - 8 * Math.cos(ang + .38), hy - 8 * Math.sin(ang + .38));
    ctx.closePath(); ctx.fillStyle = acc; ctx.fill();
    ctx.globalAlpha = .6; ctx.fillStyle = mut; ctx.font = '8px Inter,sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('N', cx, cy - r - 2); ctx.globalAlpha = 1;
  }

  function tileLayer(map, dark) {
    const cfg = dark
      ? { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', sub: 'abcd', attr: '© OpenStreetMap, © CARTO' }
      : { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', sub: 'abcd', attr: '© OpenStreetMap, © CARTO' };
    return L.tileLayer(cfg.url, { attribution: cfg.attr, subdomains: cfg.sub, maxZoom: 19 }).addTo(map);
  }

  global.SrtMap = {
    BRAND, BOAT_PALETTE, MARK_STYLE,
    distM, brg, deg2dir, lerp, fmtClock, boatColour,
    boatIcon, markIcon, drawWindDial, tileLayer,
    SrtCourse, computeLeg,
  };

})(typeof window !== 'undefined' ? window : globalThis);
