/* AIOS Sync (client) — keeps your ticks + to-dos the same on PC and iPhone.
 *
 * HOW IT WORKS, honestly:
 *  - The dashboard page is read-only, so it can't save your taps back to itself.
 *  - Instead, your taps (ticks, to-dos, deletes, order) are ENCRYPTED with your HQ
 *    password and parked in your own private Google Apps Script store (free).
 *  - Every device pulls that store every few seconds and pushes when you change
 *    something. So a tick on your phone shows up on your PC, and vice-versa.
 *  - Everything is encrypted before it leaves the page. Google/anyone only sees
 *    scrambled text; only your password can read it.
 *
 * Turn it on: tap  ☁ Sync  (top bar) and paste your Web App URL (see tools/aios_sync.gs).
 * It stays OFF and totally inert until you do that — never breaks the dashboard.
 */
(function () {
  "use strict";
  var SYNC_KEYS = ["hq_checks_v1", "hq_deleted_v1", "hq_order_v1", "aios_todos_v1"];
  var URL_KEY = "aios_sync_url";   // the Web App /exec link (this device only)
  var PW_KEY = "hq_pw_v1";          // your HQ password, saved by the unlock screen
  var TS_KEY = "aios_sync_ts";      // last state timestamp this device has seen

  // raw setItem captured BEFORE we patch it, so our own writes don't loop
  var _set = localStorage.setItem.bind(localStorage);

  function getURL() { try { return localStorage.getItem(URL_KEY) || ""; } catch (e) { return ""; } }
  function getPW() { try { return localStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
  function active() { return !!getURL() && !!getPW() && !!(window.crypto && window.crypto.subtle); }

  /* ---------------- crypto: PBKDF2-SHA256(150k) -> AES-GCM-256 ---------------- */
  function b64e(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64d(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function deriveKey(pw, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function encryptJSON(obj, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ct) {
      var out = new Uint8Array(28 + ct.byteLength);
      out.set(salt, 0); out.set(iv, 16); out.set(new Uint8Array(ct), 28);
      return b64e(out.buffer);
    });
  }
  function decryptB64(str, pw) {
    var raw = b64d(str);
    var salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
    return deriveKey(pw, salt).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    }).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ---------------- merge helpers (used once, on first connect) ---------------- */
  function parseObj(s) { try { var o = JSON.parse(s || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; } }
  function parseArr(s) { try { var a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function mergeTodos(a, b) {
    var map = {}, seen = {}, out = [];
    (a || []).forEach(function (t) { if (t && t.id != null) map[t.id] = t; });
    (b || []).forEach(function (t) { if (t && t.id != null && !(t.id in map)) map[t.id] = t; });
    (a || []).concat(b || []).forEach(function (t) { if (t && t.id != null && !seen[t.id]) { seen[t.id] = 1; out.push(map[t.id]); } });
    return out;
  }
  // first-connect union: never lose anything that already exists on either side
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
  function applyKV(kv) {
    var changed = false;
    SYNC_KEYS.forEach(function (k) { if (k in kv && kv[k] !== localStorage.getItem(k)) { _set(k, kv[k]); changed = true; } });
    return changed;
  }
  function rerender() { if (typeof window.AIOS_RERENDER === "function") { try { window.AIOS_RERENDER(); } catch (e) {} } }

  /* ---------------- pull (JSONP, reads across origins) ---------------- */
  function pull() {
    if (!active()) return;
    var url = getURL(), pw = getPW();
    var cb = "aiosSync" + Math.floor(Math.random() * 1e9);
    var s = document.createElement("script");
    var done = false;
    window[cb] = function (resp) {
      done = true;
      try {
        if (resp && resp.ok && resp.data) decryptB64(resp.data, pw).then(applyRemote).catch(function () {});
        else applyRemote(null); // empty store → maybe first device; still run first-connect push
      } finally { delete window[cb]; if (s.parentNode) s.remove(); }
    };
    s.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "action=get&cb=" + cb + "&t=" + Date.now();
    s.onerror = function () { if (!done) { delete window[cb]; if (s.parentNode) s.remove(); } };
    document.body.appendChild(s);
  }

  function applyRemote(state) {
    var firstConnect = localStorage.getItem(TS_KEY) === null;
    if (firstConnect) {
      // merge local + remote so nothing is lost, then push the union up for the other device
      var merged = mergeKV((state && state.kv) || {});
      var changed = applyKV(merged);
      var ts = Math.max(Date.now(), ((state && state.ts) || 0) + 1);
      _set(TS_KEY, String(ts));
      if (changed) rerender();
      pushNow(ts);
      return;
    }
    if (!state || typeof state.ts !== "number") return;
    var localTs = +(localStorage.getItem(TS_KEY) || 0);
    if (state.ts <= localTs) return;            // we already have this or newer
    var changed2 = applyKV(state.kv || {});
    _set(TS_KEY, String(state.ts));
    if (changed2) rerender();
  }

  /* ---------------- push (POST, fire-and-forget) ---------------- */
  var pushTimer = null;
  function schedulePush() { if (!active()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1200); }
  function pushNow(forceTs) {
    if (!active()) return;
    var url = getURL(), pw = getPW();
    var ts = forceTs || Math.max(Date.now(), (+(localStorage.getItem(TS_KEY) || 0)) + 1);
    encryptJSON({ ts: ts, kv: gatherKV() }, pw).then(function (data) {
      _set(TS_KEY, String(ts));
      fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "set", data: data }) }).catch(function () {});
    }).catch(function () {});
  }

  /* ---------------- detect local changes: patch setItem for our keys ---------------- */
  try {
    localStorage.setItem = function (k, v) { _set(k, v); if (SYNC_KEYS.indexOf(k) >= 0) schedulePush(); };
  } catch (e) {}

  /* ---------------- the ☁ Sync button ---------------- */
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
    var v = window.prompt("Paste your AIOS Sync link (ends with /exec).\n\nGet it from the 5-min Google setup in tools/aios_sync.gs.\nLeave blank + OK to turn sync OFF on this device.", cur || "");
    if (v === null) return;
    v = v.trim();
    if (!v) { try { localStorage.removeItem(URL_KEY); } catch (e) {} refreshBtn(); alert("Sync is now OFF on this device."); return; }
    if (!/^https:\/\/script\.google\.com\/.*\/exec/.test(v)) {
      if (!confirm("That doesn't look like a Google Apps Script /exec link.\nSave it anyway?")) return;
    }
    _set(URL_KEY, v);
    refreshBtn();
    if (!getPW()) {
      alert("Sync link saved on this device. ✓\n\nLast step: open 🧭 HQ, unlock it once, and tick “Remember on this device” so sync can use your password. Do this on PC and iPhone. Then your ticks + to-dos stay in sync.");
    } else {
      alert("Sync is ON. ✓  Pulling your data now — your ticks + to-dos will match across devices within a few seconds.");
      pull();
    }
  }

  /* ---------------- start ---------------- */
  function start() {
    refreshBtn();
    var b = document.getElementById("sync-btn");
    if (b) b.addEventListener("click", setup);
    pull();
    setInterval(pull, 10000);
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) pull(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
