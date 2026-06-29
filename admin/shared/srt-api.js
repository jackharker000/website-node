/* =============================================================================
 * srt-api.js — Sail Race Tracker shared API client (Phase 2 contract)
 *
 * This is the SINGLE place the dashboards talk to the deployed Cloudflare
 * Worker. Keep it in lockstep with the Phase-2 backend (srt-backend). Every
 * endpoint and JSON shape the front-ends rely on is documented here.
 *
 * Base URL (deployed, live):
 *   https://srt-backend.srt-jackharker.workers.dev
 *
 * ---------------------------------------------------------------------------
 * PUBLIC (viewer) endpoints — no auth
 * ---------------------------------------------------------------------------
 *   GET  /health
 *        -> { ok:true, service, env, ts }
 *
 *   GET  /races
 *        -> { races: [ { id, name, venue, status, start_time, course_id } ] }
 *        status ∈ draft | armed | running | finished
 *
 *   GET  /races/:id
 *        -> { race:  { id, name, venue, status, start_time, course_id,
 *                      frame_epoch_ms, slot_count, toa_ms, guard_ms, created_ms },
 *             course:{ id, name, leg_marks:number[], leg_labels:string[],
 *                      marks:[ { id, name, type, lat, lon, seq } ] } | null,
 *             boats: [ { id, sail_number, name, colour, class, node_id } ] }
 *        mark.type ∈ start | windward | leeward | finish | wing | ...
 *
 *   GET  /races/:id/tracks?from=<ms>&to=<ms>
 *        -> { race_id, from, to, downsample_ms,
 *             tracks: { "<node_id>": [ { ts_ms, lat, lon, sog, cog } ] } }
 *        Server-downsampled (one point per node per downsample_ms bucket).
 *
 *   WS   /races/:id/live
 *        On connect: { type:"snapshot", race_id, positions:[LivePosition] }
 *        Then:       { type:"fix",      race_id, position:LivePosition }
 *                    { type:"state",    race_id, state:"running" }
 *        Send the literal string "ping" -> { type:"pong" }  (keepalive)
 *
 *   LivePosition = { node_id, boat_id, ts_ms, lat, lon,
 *                    sog, cog, battery_mv, rssi }   (extras may be null)
 *
 * ---------------------------------------------------------------------------
 * ADMIN endpoints — require admin key
 *   Authorization: Bearer <ADMIN_KEY>   (or  X-Admin-Key: <ADMIN_KEY>)
 *   Optional X-Admin-Actor: you@example.com   (recorded in audit_log)
 * ---------------------------------------------------------------------------
 *   POST   /admin/boats          { sail_number, name, colour, class, node_id } -> { id, ... }
 *   PATCH  /admin/boats/:id       (any subset of the above) -> { ok:true }
 *   DELETE /admin/boats/:id       -> { ok:true }
 *   PATCH  /admin/nodes/:id       { slot, channel }  -> { ok:true }   (TDMA slot)
 *   POST   /admin/marks          { course_id, name, type, lat, lon, seq } -> { id, ... }
 *   PUT    /admin/courses/:id     { name, leg_marks:number[], leg_labels:string[] } -> { ok:true }
 *   POST   /admin/races          { name, venue, status?, course_id, slot_count?, toa_ms?, guard_ms? } -> { id, ... }
 *   POST   /admin/races/:id/arm    -> { ok, race_id, status:"armed" }   (sets frame_epoch_ms)
 *   POST   /admin/races/:id/start  -> { ok, race_id, status:"running" } (sets start_time)
 *   POST   /admin/races/:id/finish -> { ok, race_id, status:"finished" }
 *   GET    /admin/audit           -> { audit:[ { id, ts_ms, actor, action, entity, old_value, new_value } ] }
 *
 * GATEWAY-key endpoint (shape reference only; admin app can mirror it read-only
 * if given the gateway key — but normally the organiser confirms armed state via
 * GET /races/:id which is public):
 *   GET /race/current  (Bearer GATEWAY_KEY) ->
 *      { race_id, state, armed, slot_count, toa_ms, guard_ms, frame_epoch_ms,
 *        start_time, slots:[ { node_id, slot } ],
 *        course:{ id, name, marks:[...], leg_marks, leg_labels } }
 * ===========================================================================*/

(function (global) {
  'use strict';

  const DEFAULT_BASE = 'https://srt-backend.srt-jackharker.workers.dev';

  function trimSlash(u) { return (u || '').replace(/\/+$/, ''); }

  /* -----------------------------------------------------------------------
   * SrtApi — REST client. Construct with { base, adminKey, actor }.
   * adminKey/actor are only needed for admin (organiser) calls.
   * --------------------------------------------------------------------- */
  class SrtApi {
    constructor(opts = {}) {
      this.base = trimSlash(opts.base || DEFAULT_BASE);
      this.adminKey = opts.adminKey || null;
      this.actor = opts.actor || null;
    }

    setAdmin(key, actor) { this.adminKey = key || null; if (actor) this.actor = actor; }

    _headers(admin) {
      const h = { 'Content-Type': 'application/json' };
      if (admin) {
        if (!this.adminKey) throw new Error('admin key not set');
        h['Authorization'] = 'Bearer ' + this.adminKey;
        if (this.actor) h['X-Admin-Actor'] = this.actor;
      }
      return h;
    }

    async _req(method, path, { admin = false, body } = {}) {
      const res = await fetch(this.base + path, {
        method,
        headers: this._headers(admin),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      const text = await res.text();
      if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
      if (!res.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status));
        err.status = res.status; err.body = data;
        throw err;
      }
      return data;
    }

    // ---- health / viewer (public) ----
    health()                 { return this._req('GET', '/health'); }
    listRaces()              { return this._req('GET', '/races'); }
    getRace(id)              { return this._req('GET', '/races/' + id); }
    getTracks(id, from, to) {
      const q = new URLSearchParams();
      if (from != null) q.set('from', from);
      if (to != null) q.set('to', to);
      const qs = q.toString();
      return this._req('GET', '/races/' + id + '/tracks' + (qs ? '?' + qs : ''));
    }

    // ---- admin: boats ----
    createBoat(b)            { return this._req('POST', '/admin/boats', { admin: true, body: b }); }
    updateBoat(id, b)        { return this._req('PATCH', '/admin/boats/' + id, { admin: true, body: b }); }
    deleteBoat(id)           { return this._req('DELETE', '/admin/boats/' + id, { admin: true }); }

    // ---- admin: TDMA slot / channel on a node ----
    setNodeSlot(nodeId, { slot, channel }) {
      return this._req('PATCH', '/admin/nodes/' + nodeId, { admin: true, body: { slot, channel } });
    }

    // ---- admin: course ----
    createMark(m)            { return this._req('POST', '/admin/marks', { admin: true, body: m }); }
    saveCourse(id, c)        { return this._req('PUT', '/admin/courses/' + id, { admin: true, body: c }); }

    // ---- admin: race control ----
    createRace(r)            { return this._req('POST', '/admin/races', { admin: true, body: r }); }
    armRace(id)              { return this._req('POST', '/admin/races/' + id + '/arm', { admin: true }); }
    startRace(id)            { return this._req('POST', '/admin/races/' + id + '/start', { admin: true }); }
    finishRace(id)           { return this._req('POST', '/admin/races/' + id + '/finish', { admin: true }); }

    // ---- admin: audit ----
    getAudit()               { return this._req('GET', '/admin/audit', { admin: true }); }

    // ---- websocket URL helper ----
    liveUrl(raceId) {
      const ws = this.base.replace(/^http/i, 'ws');
      return ws + '/races/' + raceId + '/live';
    }
  }

  /* -----------------------------------------------------------------------
   * SrtLive — resilient WebSocket subscription to a race's live room.
   *
   *   const live = new SrtLive(api, raceId, {
   *     onSnapshot(positions) {},   // array of LivePosition
   *     onFix(position)       {},   // single LivePosition
   *     onState(state)        {},   // "armed"|"running"|"finished"|...
   *     onStatus(s)           {},   // "connecting"|"open"|"closed"
   *   });
   *   live.start();  ... later: live.stop();
   *
   * Handles auto-reconnect with backoff and a 25s "ping" keepalive.
   * --------------------------------------------------------------------- */
  class SrtLive {
    constructor(api, raceId, handlers = {}) {
      this.api = api;
      this.raceId = raceId;
      this.h = handlers;
      this.ws = null;
      this.stopped = false;
      this.retry = 0;
      this._ping = null;
      this._reconnectTimer = null;
    }

    start() {
      this.stopped = false;
      this._connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this._reconnectTimer);
      clearInterval(this._ping);
      if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    }

    _emitStatus(s) { if (this.h.onStatus) this.h.onStatus(s); }

    _connect() {
      this._emitStatus('connecting');
      let ws;
      try { ws = new WebSocket(this.api.liveUrl(this.raceId)); }
      catch { return this._scheduleReconnect(); }
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        this._emitStatus('open');
        clearInterval(this._ping);
        this._ping = setInterval(() => {
          if (ws.readyState === 1) { try { ws.send('ping'); } catch {} }
        }, 25000);
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'snapshot' && this.h.onSnapshot) this.h.onSnapshot(m.positions || []);
        else if (m.type === 'fix' && this.h.onFix && m.position) this.h.onFix(m.position);
        else if (m.type === 'state' && this.h.onState) this.h.onState(m.state);
        // m.type === 'pong' -> keepalive ack, ignore
      };

      ws.onclose = () => {
        clearInterval(this._ping);
        this._emitStatus('closed');
        if (!this.stopped) this._scheduleReconnect();
      };

      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    _scheduleReconnect() {
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 6);
      const delay = Math.min(1000 * Math.pow(1.7, this.retry), 15000);
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this._connect(), delay);
    }
  }

  global.SrtApi = SrtApi;
  global.SrtLive = SrtLive;
  global.SRT_DEFAULT_BASE = DEFAULT_BASE;

})(typeof window !== 'undefined' ? window : globalThis);
