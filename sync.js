/* AIOS Sync (client) — keeps your ticks + to-dos the same on PC and iPhone.
 *
 * - The dashboard page is read-only, so it can't save your taps to itself.
 * - Instead your taps (ticks, to-dos, deletes, order) are ENCRYPTED with your HQ
 *   password and parked in your own free Google Apps Script store.
 * - Reads + writes both go over GET (the only thing that survives Google's redirect
 *   reliably). Writes are split into small chunks the server reassembles, so any
 *   size works. Everything is encrypted before it leaves the page.
 *
 * Turn it on: tap  ☁ Sync  (top bar) and paste your Web App URL (see AIOS-sync-code.txt).
 * Stays OFF and inert until you do — never breaks the dashboard.
 */
(function () {
  "use strict";
  var SYNC_KEYS = ["hq_checks_v1", "hq_deleted_v1", "hq_order_v1", "aios_todos_v1"];
  var URL_KEY = "aios_sync_url", PW_KEY = "hq_pw_v1", TS_KEY = "aios_sync_ts";
  var _set = localStorage.setItem.bind(localStorage);   // raw setter, captured before we patch

  function getURL() { try { return localStorage.getItem(URL_KEY) || ""; } catch (e) { return ""; } }
  function getPW() { try { return localStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
  function active() { return !!getURL() && !!getPW() && !!(window.crypto && window.crypto.subtle); }

  /* ---- crypto: PBKDF2-SHA256(150k) -> AES-GCM-256; blob = base64(salt16|iv12|ct) ---- */
  function b64e(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64d(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function deriveKey(pw, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function encryptJSON(obj, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ct) {
      var out = new Uint8Array(28 + ct.byteLength); out.set(salt, 0); out.set(iv, 16); out.set(new Uint8Array(ct), 28);
      return b64e(out.buffer);
    });
  }
  function decryptB64(str, pw) {
    var raw = b64d(str), salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
    return deriveKey(pw, salt).then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct); })
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ---- merge helpers (first connect only, so nothing is lost) ---- */
  function parseObj(s) { try { var o = JSON.parse(s || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; } }
  function parseArr(s) { try { var a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function mergeTodos(a, b) {
    var map = {}, seen = {}, out = [];
    (a || []).forEach(function (t) { if (t && t.id != null) map[t.id] = t; });
    (b || []).forEach(function (t) { if (t && t.id != null && !(t.id in map)) map[t.id] = t; });
    (a || []).concat(b || []).forEach(function (t) { if (t && t.id != null && !seen[t.id]) { seen[t.id] = 1; out.push(map[t.id]); } });
    return out;
  }
  function mergeKV(remoteKV) {
    var out = {};
    ["hq_checks_v1", "hq_deleted_v1"].forEach(function (k) {
      out[k] = JSON.stringify(Object.assign({}, parseObj(localStorage.getItem(k)), parseObj(remoteKV[k])));
    });
    var ro = parseObj(remoteKV["hq_order_v1"]);
    out["hq_order_v1"] = (ro && Object.keys(ro).length) ? remoteKV["hq_order_v1"] : (localStorage.getItem("hq_order_v1") || remoteKV["hq_order_v1"] || "{}");
    out["aios_todos_v1"] = JSON.stringify(mergeTodos(parseArr(localStorage.getItem("aios_todos_v1")), parseArr(remoteKV["aios_todos_v1"])));
    return out;
  }

  function gatherKV() { var kv = {}; SYNC_KEYS.forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) kv[k] = v; }); return kv; }
  function applyKV(kv) { var changed = false; SYNC_KEYS.forEach(function (k) { if (k in kv && kv[k] !== localStorage.getItem(k)) { _set(k, kv[k]); changed = true; } }); return changed; }
  function rerender() { if (typeof window.AIOS_RERENDER === "function") { try { window.AIOS_RERENDER(); } catch (e) {} } }

  /* ---- JSONP GET (reads cross-origin; also carries each write chunk) ---- */
  function jsonpGet(src) {
    return new Promise(function (resolve) {
      var cb = "aiosSync" + Math.floor(Math.random() * 1e9), s = document.createElement("script"), done = false;
      window[cb] = function (resp) { done = true; try { resolve(resp); } finally { delete window[cb]; if (s.parentNode) s.remove(); } };
      s.onerror = function () { if (!done) { delete window[cb]; if (s.parentNode) s.remove(); resolve(null); } };
      s.src = src + (src.indexOf("?") < 0 ? "?" : "&") + "cb=" + cb + "&t=" + Date.now();
      document.body.appendChild(s);
    });
  }

  function pull() {
    if (!active()) return;
    var pw = getPW(), url = getURL();
    jsonpGet(url + (url.indexOf("?") < 0 ? "?" : "&") + "action=get").then(function (resp) {
      if (resp && resp.ok && resp.data) decryptB64(resp.data, pw).then(applyRemote).catch(function () {});
      else applyRemote(null);
    });
  }

  function applyRemote(state) {
    var firstConnect = localStorage.getItem(TS_KEY) === null;
    if (firstConnect) {                       // union local+remote so nothing is lost, then push it up
      var merged = mergeKV((state && state.kv) || {}), changed = applyKV(merged);
      var ts = Math.max(Date.now(), ((state && state.ts) || 0) + 1);
      _set(TS_KEY, String(ts));
      if (changed) rerender();
      pushNow(ts);
      return;
    }
    if (!state || typeof state.ts !== "number") return;
    var localTs = +(localStorage.getItem(TS_KEY) || 0);
    if (state.ts <= localTs) return;          // already have this or newer
    var changed2 = applyKV(state.kv || {});
    _set(TS_KEY, String(state.ts));
    if (changed2) rerender();
  }

  /* ---- chunked GET write: small pieces the server reassembles + commits ---- */
  var pushing = false, pushAgain = false;
  function pushNow(forceTs) {
    if (!active()) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    var url = getURL(), pw = getPW();
    var ts = forceTs || Math.max(Date.now(), (+(localStorage.getItem(TS_KEY) || 0)) + 1);
    function finish() { pushing = false; if (pushAgain) { pushAgain = false; schedulePush(); } }
    encryptJSON({ ts: ts, kv: gatherKV() }, pw).then(function (data) {
      var CH = 1200, chunks = [];
      for (var k = 0; k < data.length; k += CH) chunks.push(data.substring(k, k + CH));
      if (!chunks.length) chunks = [""];
      var sid = "s" + Math.floor(Math.random() * 1e9).toString(36), n = chunks.length, idx = 0;
      (function sendNext() {
        if (idx >= n) { _set(TS_KEY, String(ts)); finish(); return; }
        var src = url + (url.indexOf("?") < 0 ? "?" : "&") + "action=put&sid=" + sid + "&i=" + idx + "&n=" + n + "&data=" + encodeURIComponent(chunks[idx]);
        jsonpGet(src).then(function () { idx++; sendNext(); });
      })();
    }).catch(finish);
  }

  /* ---- detect local changes by patching setItem for our keys ---- */
  var pushTimer = null;
  function schedulePush() { if (!active()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1200); }
  try { localStorage.setItem = function (k, v) { _set(k, v); if (SYNC_KEYS.indexOf(k) >= 0) schedulePush(); }; } catch (e) {}

  /* ---- the ☁ Sync button ---- */
  function refreshBtn() {
    var b = document.getElementById("sync-btn"); if (!b) return;
    var on = !!getURL();
    b.textContent = on ? "☁ Sync ✓" : "☁ Sync";
    b.classList.toggle("on", on);
    b.title = on ? "Cross-device sync is ON for this device. Tap to change or turn off."
                 : "Turn on sync so your ticks + to-dos match on PC and iPhone.";
  }
  function setup() {
    var cur = getURL();
    var v = window.prompt("Paste your AIOS Sync link (ends with /exec).\nLeave blank + OK to turn sync OFF on this device.", cur || "");
    if (v === null) return;
    v = v.trim();
    if (!v) { try { localStorage.removeItem(URL_KEY); } catch (e) {} refreshBtn(); alert("Sync is now OFF on this device."); return; }
    if (!/^https:\/\/script\.google\.com\/.*\/exec/.test(v)) {
      if (!confirm("That doesn't look like a Google Apps Script /exec link.\nSave it anyway?")) return;
    }
    _set(URL_KEY, v);
    refreshBtn();
    if (!getPW()) {
      alert("Sync link saved. ✓\n\nLast step: open 🧭 HQ, unlock it once with “Remember on this device” ticked, so sync can use your password. Do this on PC and iPhone.");
    } else {
      alert("Sync is ON. ✓  Syncing now — your ticks + to-dos will match across devices within a few seconds.");
      pull();
    }
  }

  function start() {
    refreshBtn();
    var b = document.getElementById("sync-btn"); if (b) b.addEventListener("click", setup);
    pull();
    setInterval(pull, 10000);
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) pull(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
