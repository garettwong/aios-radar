/* =============================================================================
   AIOS · OCC AI OPPORTUNITY RADAR — app logic
   Reads DASHBOARD_DATA (latest) + DASHBOARD_ARCHIVE (history) + DASHBOARD_PROFILE.
   News-first layout, with per-card mark-as-read (hide) + save, persisted locally.
============================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  const shortDate = (d) => String(d || "").replace(/\s*GMT[+-]\d+\s*$/, "").trim();

  const DATA = window.DASHBOARD_DATA;
  const ARCHIVE = window.DASHBOARD_ARCHIVE;
  const PROFILE = window.DASHBOARD_PROFILE;
  const HQ = window.DASHBOARD_HQ;
  const CAT = window.AIOS_CATALOG;
  if (!DATA) {
    document.body.innerHTML = '<p style="font-family:monospace;color:#f87171;padding:40px">data.js failed to load.</p>';
    return;
  }
  const META = DATA.meta || {};

  let editions =
    ARCHIVE && Array.isArray(ARCHIVE.editions) && ARCHIVE.editions.length
      ? ARCHIVE.editions
      : [{ key: "latest", label: META.latestBrief || "Latest", briefs: DATA.briefs }];
  // default to the newest COMPLETE edition (both columns have signals)
  let currentIdx = (function () {
    const i = editions.findIndex((e) => {
      const bs = e.briefs || [];
      const t = bs.find((b) => b.id === "trend" && (b.signals || []).length);
      const j = bs.find((b) => b.id === "job" && (b.signals || []).length);
      return t && j;
    });
    return i < 0 ? 0 : i;
  })();

  const REL_ORDER = ["Advanced", "Intermediate", "Beginner"];
  let activeRel = "ALL";
  let query = "";
  let showRead = true;   // read items STAY visible (shaded); "Unread only" hides them
  let savedOnly = false;
  // library (AICC catalog) state
  let libType = "ALL", libQuery = "", libShowRead = true, libSavedOnly = false, libLimit = 120, libItems = [];

  /* ---------------- read / saved persistence ---------------- */
  const READ_KEY = "aios_read_v1", SAVED_KEY = "aios_saved_v1";
  const loadMap = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch (e) { return {}; } };
  const saveMap = (k, o) => { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} };
  let readMap = loadMap(READ_KEY), savedMap = loadMap(SAVED_KEY);
  const sigKey = (s) => (s.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const isRead = (s) => !!readMap[sigKey(s)];
  const isSaved = (s) => !!savedMap[sigKey(s)];
  function toggleRead(s) {
    const k = sigKey(s);
    if (readMap[k]) delete readMap[k]; else readMap[k] = 1;
    saveMap(READ_KEY, readMap); refreshBoard();
  }
  function toggleSave(s) {
    const k = sigKey(s);
    if (savedMap[k]) delete savedMap[k]; else savedMap[k] = 1;
    saveMap(SAVED_KEY, savedMap); refreshBoard();
  }

  /* ---------------- header ---------------- */
  $("brand-tagline").textContent = META.tagline || "";
  $("meta-operator").textContent = META.operator || "—";

  /* ---------------- font scale ---------------- */
  const FS_KEY = "aios_fs", FS = [1.15, 1.35, 1.6, 1.9], FS_LABEL = ["S", "M", "L", "XL"];
  let fsIdx;
  (function () { const v = localStorage.getItem(FS_KEY); fsIdx = v === null ? 2 : Math.max(0, Math.min(FS.length - 1, parseInt(v) || 0)); })();
  function applyFS() {
    document.documentElement.style.setProperty("--fs", FS[fsIdx]);
    try { localStorage.setItem(FS_KEY, fsIdx); } catch (e) {}
    if ($("fs-level")) $("fs-level").textContent = FS_LABEL[fsIdx];
  }
  $("fs-dec").addEventListener("click", () => { fsIdx = Math.max(0, fsIdx - 1); applyFS(); });
  $("fs-inc").addEventListener("click", () => { fsIdx = Math.min(FS.length - 1, fsIdx + 1); applyFS(); });
  applyFS();

  /* ---------------- filters + view toggles + search ---------------- */
  const filterRow = $("filter-row");
  ["ALL", ...REL_ORDER].forEach((r) => {
    const chip = el("button", "chip" + (r === "ALL" ? " active" : ""), esc(r));
    chip.addEventListener("click", () => {
      activeRel = r;
      filterRow.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
      chip.classList.add("active");
      refreshBoard();
    });
    filterRow.appendChild(chip);
  });
  const tRead = $("toggle-read"), tSaved = $("toggle-saved");
  tRead.addEventListener("click", () => { showRead = !showRead; tRead.classList.toggle("active", !showRead); refreshBoard(); });
  tSaved.addEventListener("click", () => { savedOnly = !savedOnly; tSaved.classList.toggle("active", savedOnly); refreshBoard(); });
  var _sbEl = $("search-box"); if (_sbEl) _sbEl.addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); refreshBoard(); });

  document.querySelectorAll(".markall").forEach((btn) => {
    btn.addEventListener("click", () => {
      const brief = briefById(btn.dataset.col);
      if (!brief) return;
      (brief.signals || []).filter(passFilter).forEach((s) => { readMap[sigKey(s)] = 1; });
      saveMap(READ_KEY, readMap); refreshBoard();
    });
  });

  /* ---------------- edition dropdown ---------------- */
  const sel = $("edition-select");
  if (editions.length > 1) {
    $("edition-wrap").hidden = false;
    editions.forEach((e, i) => {
      const o = el("option"); o.value = i;
      o.textContent = (i === 0 ? "● LATEST · " : "") + (e.label || e.key);
      sel.appendChild(o);
    });
    sel.value = currentIdx;
    sel.addEventListener("change", () => { currentIdx = parseInt(sel.value) || 0; mount(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  }

  /* ---------------- helpers over current edition ---------------- */
  const curBriefs = () => editions[currentIdx].briefs || [];
  const briefById = (id) => curBriefs().find((b) => b.id === id);
  function allSignals() {
    const a = [];
    curBriefs().forEach((b) => (b.signals || []).forEach((s) => a.push(Object.assign({ briefId: b.id, briefDate: b.date }, s))));
    return a;
  }
  const relClass = (r) => (r || "none").replace(/[^a-zA-Z]/g, "");

  function passFilter(s) {
    if (activeRel !== "ALL" && s.relevance !== activeRel) return false;
    if (query) {
      const hay = [s.title, s.summary, s.why, s.action, s.teacher, s.category, s.source].join(" ").toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }
  function passView(s) {
    if (savedOnly) return isSaved(s);
    if (!showRead && isRead(s) && !isSaved(s)) return false;
    return true;
  }

  /* ---------------- signal card ---------------- */
  function signalCard(s) {
    const card = el("article", "signal acc-" + relClass(s.relevance) + (isRead(s) ? " is-read" : "") + (isSaved(s) ? " is-saved" : ""));
    const link = s.link
      ? `<a class="source-link" href="${esc(s.link)}" target="_blank" rel="noopener">SOURCE ↗</a>`
      : `<span class="source-link disabled">SOURCE — n/a</span>`;
    card.innerHTML =
      '<div class="signal-top">' +
        `<span class="tag cat">${esc(s.category)}</span>` +
        `<span class="tag src">${esc(s.source || "—")}</span>` +
        `<span class="tag rel rel-${relClass(s.relevance)}">${esc(s.relevance || "")}</span>` +
        '<span class="card-actions">' +
          `<span class="tag num">N${esc(s.n)}</span>` +
          `<button class="ca save${isSaved(s) ? " on" : ""}" title="Save">★</button>` +
          `<button class="ca read${isRead(s) ? " on" : ""}" title="Mark read / hide">✓</button>` +
        "</span>" +
      "</div>" +
      `<h3 class="signal-title">${esc(s.title)}</h3>` +
      `<div class="signal-meta"><span class="signal-date">🗓 ${esc(shortDate(s.briefDate))}</span>` +
        (isSaved(s) ? '<span class="saved-flag">★ SAVED</span>' : "") +
        (isRead(s) ? '<span class="read-flag">✓ READ</span>' : "") + "</div>" +
      `<p class="signal-summary">${esc(s.summary)}</p>` +
      '<div class="signal-details">' + detailFrames(s.summary, s.why, s.action, s.teacher) + noteBoxHTML(s) + sourceRow(s.link) + "</div>";
    card.querySelector(".ca.read").addEventListener("click", (e) => { e.stopPropagation(); toggleRead(s); });
    card.querySelector(".ca.save").addEventListener("click", (e) => { e.stopPropagation(); toggleSave(s); });
    card.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button") || e.target.closest(".note-box")) return; card.classList.toggle("open"); });
    wireNoteBox(card, s);
    return card;
  }
  function block(label, text) {
    if (!text) return "";
    return `<div class="detail-block"><span class="detail-label">${label}</span><span class="detail-text">${esc(text)}</span></div>`;
  }
  function sourceRow(link) {
    const lk = link
      ? `<a class="source-link" href="${esc(link)}" target="_blank" rel="noopener">SOURCE ↗</a>`
      : `<span class="source-link disabled">SOURCE — n/a</span>`;
    return `<div class="frame-source">${lk}</div>`;
  }
  // 4 clear framed sections (Summary / Why / Action / Teacher) — used by RADAR and LIBRARY
  function detailFrames(summary, why, action, teacher) {
    const f = (ico, label, txt, cls) =>
      `<div class="frame ${cls}"><div class="frame-ico">${ico}</div><div class="frame-body">` +
      `<span class="frame-label">${label}</span><div class="frame-text">${txt ? esc(txt) : "—"}</div></div></div>`;
    return f("🎯", "SUMMARY", summary, "f-sum") +
           f("💡", "WHY IT MATTERS", why, "f-why") +
           f("🔧", "PRACTICAL ACTION", action, "f-act") +
           f("🎓", "TEACHER NOTE", teacher, "f-teach");
  }

  /* ---------------- render columns ---------------- */
  function renderColumns() {
    [["trend", "AI TRENDS"], ["job", "OPPORTUNITY"]].forEach(([id, fallback]) => {
      const brief = briefById(id);
      const host = $(id + "-signals");
      host.innerHTML = "";
      $(id + "-title").textContent = (brief && brief.title ? brief.title : fallback).toUpperCase();
      $(id + "-subtitle").textContent = (brief && brief.subtitle) || "";
      const all = brief ? (brief.signals || []) : [];
      const list = all.filter((s) => passFilter(s) && passView(s));
      list.forEach((s) => host.appendChild(signalCard(Object.assign({ briefDate: brief.date }, s))));
      const unread = all.filter((s) => passFilter(s) && !isRead(s)).length;
      $(id + "-count").textContent = unread + " new";
      if (!brief || all.length === 0) {
        host.appendChild(el("div", "empty-note", "No " + fallback.toLowerCase() + " in this edition."));
      } else if (list.length === 0) {
        host.appendChild(el("div", "empty-note", savedOnly ? "No saved items here yet — tap ★ on a card to save it." : "Nothing unread — switch off “Unread only” to see your read items."));
      }
    });
  }

  /* ---------------- stats / relevance / actions ---------------- */
  function renderStats() {
    const all = allSignals();
    const unread = all.filter((s) => !isRead(s)).length;
    const saved = all.filter((s) => isSaved(s)).length;
    const cells = [
      [unread, "UNREAD", "cyan"],
      [all.length, "IN EDITION", ""],
      [saved, "SAVED", "amber"],
      [editions.length, "EDITIONS", "green"],
    ];
    const grid = $("stats-grid"); grid.innerHTML = "";
    cells.forEach(([num, label, cls]) => {
      const stat = el("div", "stat");
      stat.innerHTML = `<div class="stat-num ${cls}">${num}</div><div class="stat-label">${label}</div>`;
      grid.appendChild(stat);
    });
    $("meta-unread").textContent = unread;
  }

  function renderRelevance() {
    const all = allSignals(); const counts = {};
    REL_ORDER.forEach((k) => (counts[k] = 0));
    all.forEach((s) => { if (counts[s.relevance] != null) counts[s.relevance]++; });
    const max = Math.max(1, ...REL_ORDER.map((k) => counts[k]));
    const host = $("relevance-bars"); host.innerHTML = "";
    REL_ORDER.forEach((k) => {
      const row = el("div", "bar-row");
      row.innerHTML = `<span class="bar-label">${k}</span><span class="bar-track"><span class="bar-fill ${k}" style="width:${(counts[k] / max) * 100}%"></span></span><span class="bar-val">${counts[k]}</span>`;
      host.appendChild(row);
    });
  }

  const ACT_KEY = "aios_actions_done_v2";
  const loadDone = () => { try { return JSON.parse(localStorage.getItem(ACT_KEY) || "{}"); } catch (e) { return {}; } };
  const saveDone = (d) => { try { localStorage.setItem(ACT_KEY, JSON.stringify(d)); } catch (e) {} };
  function renderActions() {
    const done = loadDone(); const edKey = editions[currentIdx].key;
    const host = $("action-list"); host.innerHTML = "";
    const items = allSignals().filter((s) => s.action);
    items.forEach((s) => {
      const id = edKey + "|" + s.briefId + "-" + s.n;
      const row = el("div", "action" + (done[id] ? " done" : ""));
      row.innerHTML = '<span class="box"></span>' + `<span><span class="action-text">${esc(s.action)}</span><br><span class="action-src">${esc(s.category)} · N${esc(s.n)}</span></span>`;
      row.addEventListener("click", () => { const cur = loadDone(); if (cur[id]) delete cur[id]; else cur[id] = 1; saveDone(cur); renderActions(); });
      host.appendChild(row);
    });
    const completed = items.filter((s) => done[edKey + "|" + s.briefId + "-" + s.n]).length;
    $("action-progress").textContent = completed + "/" + items.length;
  }

  /* ---------------- context: callouts + quick read ---------------- */
  function renderFocus() {
    const host = $("focus-row"); host.innerHTML = "";
    const icons = { trend: "★", job: "✦" };
    curBriefs().forEach((b) => {
      if (!b.callout || !b.callout.text) return;
      const card = el("article", "panel callout callout-" + (b.accent || "cyan"));
      card.innerHTML = `<div class="panel-head"><span class="panel-title">${icons[b.id] || "▸"} ${esc((b.callout.label || "").toUpperCase())}</span></div><p class="callout-text">${esc(b.callout.text)}</p>`;
      host.appendChild(card);
    });
  }
  function renderStrip() {
    const host = $("strip-row"); host.innerHTML = "";
    curBriefs().forEach((b) => {
      const lis = (b.quickRead || []).map((t) => `<li>${esc(t)}</li>`).join("");
      const tag = b.id === "trend" ? "TRENDS" : "OPPORTUNITY";
      const card = el("article", "panel");
      card.innerHTML = `<div class="panel-head"><span class="panel-title">▸ QUICK READ · ${tag}</span></div><ul class="quickread-list">${lis || "<li>—</li>"}</ul>`;
      host.appendChild(card);
    });
  }

  /* ---------------- HQ cockpit (once) ---------------- */
  var HQ_CHK = "hq_checks_v1";
  var hqChecks = (function () { try { return JSON.parse(localStorage.getItem(HQ_CHK) || "{}"); } catch (e) { return {}; } })();
  function hqSaveChecks() { try { localStorage.setItem(HQ_CHK, JSON.stringify(hqChecks)); } catch (e) {} }
  function hqKey(s) { var h = 5381, t = String(s || ""); for (var i = 0; i < t.length; i++) h = (((h << 5) + h) ^ t.charCodeAt(i)) >>> 0; return "k" + h.toString(16); }
  function hqIsDone(s) { return !!hqChecks[hqKey(s)]; }
  function hqTagClass(tag) {
    const t = String(tag || "").toLowerCase();
    if (/\$|money|bill|teach|client/.test(t)) return "tag-money";
    if (/messy|noise|todo|setup|dev/.test(t)) return "tag-messy";
    if (/coded|idea|pending|after|ready/.test(t)) return "tag-status";
    return "";
  }
  function hqRow(name, tag, note, next) {
    return `<div class="hq-row ${hqIsDone(name) ? "done" : ""}" data-k="${hqKey(name)}" title="Tap to mark done"><div class="hq-row-top"><span class="hq-name">${esc(name)}</span>` +
      (tag ? `<span class="hq-tag ${hqTagClass(tag)}">${esc(tag)}</span>` : "") + `</div>` +
      (note ? `<div class="hq-note">${esc(note)}</div>` : "") +
      (next ? `<div class="hq-next"><b>next:</b> ${esc(next)}</div>` : "") + `</div>`;
  }
  function renderHQ() {
    var HQ = window.DASHBOARD_HQ;
    var _lock = $("hq-lock"), _content = $("hq-content");
    if (!HQ) {
      // Locked (encrypted cockpit present but not yet unlocked) → show the password screen.
      if (window.DASHBOARD_HQ_ENC && window.HQ_UNLOCK && _lock) {
        if (_content) _content.hidden = true;
        _lock.hidden = false;
        window.HQ_UNLOCK.renderLock(_lock, function (obj) { window.DASHBOARD_HQ = obj; renderHQ(); });
      }
      return;
    }
    if (_lock) _lock.hidden = true;
    if (_content) _content.hidden = false;
    const hello = $("hq-hello");
    if (hello) hello.innerHTML = (HQ.hello || "") + (HQ.updated ? `<span class="hq-upd">⟳ updated ${esc(HQ.updated)}</span>` : "") + `<div class="hq-taphint">💡 Tap any task or ☐ box to check it off — your ticks are saved on this device.</div>`;
    if ($("hq-today-date")) $("hq-today-date").textContent = (HQ.today && HQ.today.date) || "";
    const today = $("hq-today");
    if (today) {
      const f = (HQ.today && HQ.today.focus) || [];
      today.innerHTML = f.length
        ? `<ul class="hq-focus">` + f.map((x) => `<li class="${hqIsDone(x.t) ? "done" : ""}" data-k="${hqKey(x.t)}" title="Tap to mark done"><div class="hq-t">${esc(x.t)}</div>${x.why ? `<div class="hq-why">${esc(x.why)}</div>` : ""}</li>`).join("") + `</ul>`
        : `<div class="hq-why">No focus set yet — your morning agent will fill this in.</div>`;
    }
    const m = HQ.money || {};
    if ($("hq-money-tag")) $("hq-money-tag").textContent = "this month";
    const money = $("hq-money");
    if (money) {
      money.innerHTML =
        (m.thisMonth ? `<div class="hq-money-head">${esc(m.thisMonth)}</div>` : "") +
        `<div class="hq-label">BRAINSTORM — pick what fits, ignore the rest</div>` +
        `<ul class="hq-bs">` + (m.brainstorm || []).map((b) => `<li><div class="bs-idea">${esc(b.idea)}</div><div class="bs-how">${esc(b.how)}</div></li>`).join("") + `</ul>` +
        `<div class="hq-label">DO THIS — tap to tick off</div>` +
        `<ul class="hq-actions">` + (m.actions || []).map((a) => `<li class="${hqIsDone(a) ? "done" : ""}" data-k="${hqKey(a)}" title="Tap to tick off">${esc(a)}</li>`).join("") + `</ul>`;
    }
    const pend = HQ.pending || [];
    if ($("hq-pending-count")) $("hq-pending-count").textContent = pend.length;
    const pendHost = $("hq-pending");
    if (pendHost) pendHost.innerHTML = pend.map((p) => hqRow(p.name, p.tag, p.note, null)).join("");
    const wish = HQ.wishlist || [];
    if ($("hq-wish-count")) $("hq-wish-count").textContent = wish.length;
    const wishHost = $("hq-wish");
    if (wishHost) wishHost.innerHTML = wish.map((w) => hqRow(w.name, w.status, null, w.next)).join("");
    const l = HQ.learn || {};
    const learn = $("hq-learn");
    if (learn) {
      learn.innerHTML =
        (l.headline ? `<div class="hq-label">${esc(l.headline)}</div>` : "") +
        `<ul class="hq-learn-points">` + (l.points || []).map((p) => `<li>${p}</li>`).join("") + `</ul>` +
        (l.more ? `<div class="hq-more">${esc(l.more)}</div>` : "");
    }
    if (!renderHQ._wired) {
      var hc = $("hq-content");
      if (hc) hc.addEventListener("click", function (e) {
        var it = e.target.closest("[data-k]");
        if (!it || !hc.contains(it) || e.target.closest("a")) return;
        var k = it.getAttribute("data-k");
        if (hqChecks[k]) delete hqChecks[k]; else hqChecks[k] = 1;
        hqSaveChecks();
        it.classList.toggle("done");
      });
      renderHQ._wired = true;
    }
  }

  /* ---------------- profile (once) ---------------- */
  function renderProfile() {
    if (!PROFILE) return;
    if (PROFILE.projects && PROFILE.projects.length) {
      $("projects-panel").hidden = false; $("projects-count").textContent = PROFILE.projects.length;
      const host = $("project-list"); host.innerHTML = "";
      PROFILE.projects.forEach((pr) => {
        const row = el("div", "project");
        row.innerHTML = `<div class="project-top"><span class="project-name">${esc(pr.name)}</span><span class="project-status st-${esc((pr.status || "").toLowerCase())}">${esc(pr.status || "")}</span></div>` + (pr.note ? `<div class="project-note">${esc(pr.note)}</div>` : "");
        host.appendChild(row);
      });
    }
  }

  /* ---------------- clock + modal ---------------- */
  function tick() {
    const now = new Date(); const p = (n) => String(n).padStart(2, "0");
    $("clock-time").textContent = p(now.getHours()) + ":" + p(now.getMinutes()) + ":" + p(now.getSeconds());
    $("clock-date").textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  }
  tick(); setInterval(tick, 1000);
  const overlay = $("modal-overlay");
  $("refresh-btn").addEventListener("click", () => location.reload());
  $("modal-close").addEventListener("click", () => (overlay.hidden = true));
  $("reload-btn").addEventListener("click", () => location.reload());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.hidden = true; });

  // floating Back-to-top (shows after scrolling; mainly for mobile)
  const toTop = $("to-top");
  if (toTop) {
    window.addEventListener("scroll", () => toTop.classList.toggle("show", window.scrollY > 300));
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // re-balance library columns when crossing the desktop/mobile breakpoint
  let _libRz;
  window.addEventListener("resize", () => { clearTimeout(_libRz); _libRz = setTimeout(renderLibrary, 200); });

  /* ---------------- board refresh + mount ---------------- */
  function refreshBoard() { renderColumns(); renderStats(); renderLibrary(); }

  /* ---------------- LIBRARY (all email briefs + Codex archive + vocabulary) ---------------- */
  function buildLibraryItems() {
    const out = [], seen = new Set();
    const push = (it) => {
      const k = (it.title || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!k || seen.has(k)) return;
      seen.add(k); out.push(it);
    };
    // Codex bulk archive (incl. 242 AI Terms)
    (window.AIOS_BASICS && AIOS_BASICS.items ? AIOS_BASICS.items : []).forEach((it) => push(Object.assign({ source2: "Study" }, it)));
    (CAT && CAT.items ? CAT.items : []).forEach((it) => push(Object.assign({ source2: "Archive" }, it)));
    // Every email-brief edition's signals
    if (window.DASHBOARD_ARCHIVE && DASHBOARD_ARCHIVE.editions) {
      DASHBOARD_ARCHIVE.editions.forEach((ed) => (ed.briefs || []).forEach((b) => (b.signals || []).forEach((s) => push({
        source2: "Brief",
        type: b.id === "trend" ? "AI Trends" : "Job / Opportunity",
        title: s.title,
        date: (b.date || "").replace(/\s*GMT.*$/, "").replace(/\s*·\s*/, " "),
        source: s.source || "", link: s.link || null,
        summary: s.summary || "", why: s.why || "", plain: "", terms: "", action: s.action || "", teacher: s.teacher || "",
        relevance: s.relevance, status: "",
      }))));
    }
    out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return out;
  }
  function libMatches(it) {
    if (libType !== "ALL" && it.type !== libType) return false;
    if (libSavedOnly && !isSaved(it)) return false;
    if (!libShowRead && isRead(it) && !isSaved(it)) return false;
    if (libQuery) {
      const hay = [it.title, it.summary, it.why, it.plain, it.terms, it.type, it.source].join(" ").toLowerCase();
      if (!hay.includes(libQuery)) return false;
    }
    return true;
  }
  function libCard(it) {
    const isTerm = it.type === "AI Terms";
    const card = el("article", "signal lib-card" + (isRead(it) ? " is-read" : "") + (isSaved(it) ? " is-saved" : ""));
    const link = it.link
      ? `<a class="source-link" href="${esc(it.link)}" target="_blank" rel="noopener">SOURCE ↗</a>`
      : `<span class="source-link disabled">SOURCE — n/a</span>`;
    card.innerHTML =
      '<div class="signal-top">' +
        `<span class="tag cat">${esc(it.type)}</span>` +
        (it.source2 ? `<span class="tag ${it.source2 === "Brief" ? "src2-brief" : "src2-arch"}">${it.source2 === "Brief" ? "📨 brief" : "📚 archive"}</span>` : "") +
        (it.source ? `<span class="tag src">${esc(it.source)}</span>` : "") +
        '<span class="card-actions">' +
          `<button class="ca save${isSaved(it) ? " on" : ""}" title="Save">★</button>` +
          `<button class="ca read${isRead(it) ? " on" : ""}" title="Mark read / hide">✓</button>` +
        "</span>" +
      "</div>" +
      `<h3 class="signal-title">${esc(it.title)}</h3>` +
      `<div class="signal-meta"><span class="signal-date">🗓 ${esc(it.date || "—")}</span>` +
        (isSaved(it) ? '<span class="saved-flag">★ SAVED</span>' : "") +
        (isRead(it) ? '<span class="read-flag">✓ READ</span>' : "") + "</div>" +
      `<p class="signal-summary">${esc(it.summary)}</p>` +
      '<div class="signal-details">' + detailFrames(it.summary, it.why, it.action, it.teacher || it.plain || it.terms) + noteBoxHTML(it) + sourceRow(it.link) + "</div>";
    card.querySelector(".ca.read").addEventListener("click", (e) => { e.stopPropagation(); toggleRead(it); });
    card.querySelector(".ca.save").addEventListener("click", (e) => { e.stopPropagation(); toggleSave(it); });
    card.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button") || e.target.closest(".note-box")) return; card.classList.toggle("open"); });
    wireNoteBox(card, it);
    return card;
  }
  function renderLibrary() {
    const left = $("lib-col-left"), right = $("lib-col-right");
    if (!left || !right) return;
    const all = libItems;
    const list = all.filter(libMatches);
    left.innerHTML = ""; right.innerHTML = "";
    const shown = list.slice(0, libLimit);
    const twoCol = window.matchMedia("(min-width: 821px)").matches;
    shown.forEach((it, i) => (twoCol && i % 2 === 1 ? right : left).appendChild(libCard(it)));
    const more = list.length - shown.length;
    const lm = $("lib-loadmore");
    lm.hidden = more <= 0;
    lm.textContent = "Load more (" + more + " more)";
    const unread = list.filter((it) => !isRead(it)).length;
    $("lib-meta").innerHTML = "Showing <b>" + shown.length + "</b> of <b>" + list.length + "</b> " +
      (libType === "ALL" ? "items" : esc(libType)) + " · " + unread + " unread" +
      (libQuery ? ' · search "' + esc(libQuery) + '"' : "");
  }
  function setupLibrary() {
    libItems = buildLibraryItems();
    const items = libItems;
    $("lib-nav-count").textContent = items.length.toLocaleString();
    const order = ["AI Basic Knowledge 101", "Job / Opportunity", "AI Tools", "Popular AI Tools", "AI Terms", "AI 3D", "AI Trends", "AI News"];
    const present = Array.from(new Set(items.map((x) => x.type)));
    const types = order.filter((t) => present.includes(t)).concat(present.filter((t) => order.indexOf(t) < 0));
    const counts = {};
    items.forEach((x) => { counts[x.type] = (counts[x.type] || 0) + 1; });
    const row = $("lib-type-row");
    const mkChip = (label, val) => {
      const c = el("button", "chip" + (val === "ALL" ? " active" : ""), esc(label));
      c.addEventListener("click", () => { libType = val; libLimit = 120; row.querySelectorAll(".chip").forEach((x) => x.classList.remove("active")); c.classList.add("active"); renderLibrary(); });
      return c;
    };
    row.appendChild(mkChip("ALL (" + items.length + ")", "ALL"));
    types.forEach((t) => row.appendChild(mkChip((t === "AI Terms" ? "📖 AI Terms" : t) + " (" + (counts[t] || 0) + ")", t)));
    var _lsEl = $("lib-search"); if (_lsEl) _lsEl.addEventListener("input", (e) => { libQuery = e.target.value.trim().toLowerCase(); libLimit = 120; renderLibrary(); });
    const lr = $("lib-toggle-read"), ls = $("lib-toggle-saved");
    lr.addEventListener("click", () => { libShowRead = !libShowRead; lr.classList.toggle("active", !libShowRead); renderLibrary(); });
    ls.addEventListener("click", () => { libSavedOnly = !libSavedOnly; ls.classList.toggle("active", libSavedOnly); renderLibrary(); });
    $("lib-loadmore").addEventListener("click", () => { libLimit += 120; renderLibrary(); });
    renderLibrary();
  }
  function setViewHelp(v) {
    const h = $("view-help"); if (!h) return;
    const briefs = libItems.filter((x) => x.source2 === "Brief").length;
    const arch = libItems.filter((x) => x.source2 === "Archive").length;
    h.innerHTML = v === "hq"
      ? `🧭 <b>HQ</b> — your cockpit: today's focus, money moves, pending work, and wishlist. Auto-updated each morning.`
      : v === "library"
      ? `📚 <b>LIBRARY</b> — everything archived &amp; searchable: <b>${briefs}</b> signals from all your email briefs + <b>${arch}</b> reference items (incl. 242 AI terms).`
      : v === "todo"
      ? `📝 <b>TO-DO</b> — your private notes &amp; follow-ups. Add one from the box at the bottom of any news card; set a date to get a reminder.`
      : `📡 <b>RADAR</b> — your <b>newest</b> email brief only (auto-pulled every 3h). Step back through past briefs with 📅 EDITION; the full history is in 📚 LIBRARY.`;
  }
  function setupNav() {
    document.querySelectorAll(".vnav").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        var _gs = $("global-search"); if (_gs) _gs.value = "";
        if ($("search-view")) $("search-view").hidden = true;
        if ($("gs-clear")) $("gs-clear").hidden = true;
        document.querySelectorAll(".vnav").forEach((b) => b.classList.toggle("active", b === btn));
        $("hq-view").hidden = (v !== "hq");
        $("radar-view").hidden = (v !== "radar");
        $("library-view").hidden = (v !== "library");
        $("todo-view").hidden = (v !== "todo");
        if (v === "todo") renderTodoGate();
        setViewHelp(v);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    if (!window.DASHBOARD_HQ && !window.DASHBOARD_HQ_ENC) {
      // No cockpit at all — behave exactly like the classic radar: hide the HQ tab, default to RADAR.
      var _hqb = document.querySelector('.vnav[data-view="hq"]');
      if (_hqb) { _hqb.style.display = "none"; _hqb.classList.remove("active"); }
      var _rb = document.querySelector('.vnav[data-view="radar"]');
      if (_rb) _rb.classList.add("active");
      if ($("hq-view")) $("hq-view").hidden = true;
      if ($("radar-view")) $("radar-view").hidden = false;
      setViewHelp("radar");
    } else {
      setViewHelp("hq");
    }
  }
  function mount() {
    $("meta-updated").textContent = editions[currentIdx].label || META.latestBrief || "—";
    $("footer-note").textContent = "Edition " + (editions[currentIdx].label || "") + " · operator " + (META.operator || "—");
    const all = allSignals(); const samples = all.filter((s) => s.sample).length;
    const banner = $("status-banner"); banner.hidden = false;
    banner.className = "status-banner " + (samples ? "warn" : "live");
    banner.innerHTML = samples
      ? `<b>● DATA PARTIAL</b> &nbsp;${samples} sample card(s) — click ⟳ REFRESH.`
      : `<b>● LIVE</b> &nbsp;edition <b>${esc(editions[currentIdx].label || "")}</b> · ${editions.length} editions archived · ✓ marks read (stays, shaded) · ★ saves`;
    renderFocus(); renderStrip(); renderColumns(); renderStats(); renderRelevance(); renderActions();
    renderHQ();
  }

  /* ======================================================================
     TO-DO — capture inspirations from any news card; keep them private;
     (after a 5-minute Google setup) sync to a private Google Sheet + reminders.
  ====================================================================== */
  const TODO_CFG = { appsUrl: "" }; // paste your Google Web App URL here after setup
  const TODO_KEY = "aios_todos_v1", TPASS_KEY = "aios_todo_pass_v1", TOPEN_KEY = "aios_todo_open_v1";
  const loadTodos = () => { try { return JSON.parse(localStorage.getItem(TODO_KEY) || "[]"); } catch (e) { return []; } };
  let todos = loadTodos();
  const saveTodos = () => { try { localStorage.setItem(TODO_KEY, JSON.stringify(todos)); } catch (e) {} };
  let todoFilter = "open", todoQuery = "", todoUnlocked = false, todoPassVal = "";
  const todayStr = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  const hashPass = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const todoHasPass = () => !!localStorage.getItem(TPASS_KEY);

  function addTodo(t) {
    const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    todos.unshift(Object.assign({ id, created: new Date().toISOString(), status: "open", suggestion: "", synced: false }, t));
    saveTodos(); renderTodos(); cloudPush(todos[0]);
  }
  function patchTodo(id, patch) { const i = todos.findIndex((x) => x.id === id); if (i < 0) return; Object.assign(todos[i], patch, { synced: false }); saveTodos(); renderTodos(); cloudPush(todos[i]); }
  function dropTodo(id) { todos = todos.filter((x) => x.id !== id); saveTodos(); renderTodos(); }

  /* ======================================================================
     ASK AI — type a question in any card, tap "🤖 Ask AI". The question is
     sent to your PC (card → Google Form → private Sheet), your own Claude
     answers it, and the answer + summary come back here. No API key.
  ====================================================================== */
  const ASK_CFG = {
    formUrl: "https://docs.google.com/forms/d/e/1FAIpQLScwdkwAgPQvJQ0GAFmYoNJGbuyNg7agvSbl6lQ_gXmUEnwbqA/formResponse",
    entry: "entry.708014478", sep: "|~|"
  };
  const Q_KEY = "aios_questions_v1", AADD_KEY = "aios_ask_action_added_v1";
  let askQuestions = (() => { try { return JSON.parse(localStorage.getItem(Q_KEY) || "[]"); } catch (e) { return []; } })();
  const saveQuestions = () => { try { localStorage.setItem(Q_KEY, JSON.stringify(askQuestions)); } catch (e) {} };
  function itemKey(item) {
    const base = (item && (item.title || "")) + "|" + (item && (item.briefDate || item.date || ""));
    let h = 5381; for (let i = 0; i < base.length; i++) h = (((h << 5) + h) ^ base.charCodeAt(i)) >>> 0;
    return "k" + h.toString(16);
  }
  const questionsFor = (key) => askQuestions.filter((q) => q.key === key);
  function qaHTML(item) {
    const qs = questionsFor(itemKey(item)); if (!qs.length) return "";
    const A = window.AIOS_ANSWERS || {};
    return '<div class="qa-list">' + qs.map((rec) => {
      const ans = A[rec.qid];
      if (ans && ans.a) return '<div class="qa-item" data-qid="' + rec.qid + '">' +
        '<div class="qa-q">❓ ' + esc(rec.q) + '</div>' +
        '<div class="qa-a">🤖 ' + esc(ans.a) + '</div>' +
        (ans.summary ? '<div class="qa-sum">📌 ' + esc(ans.summary) + '</div>' : '') +
        (ans.action ? '<div class="qa-act">✅ Added to To-Do: ' + esc(ans.action) + '</div>' : '') + '</div>';
      return '<div class="qa-item waiting" data-qid="' + rec.qid + '">' +
        '<div class="qa-q">❓ ' + esc(rec.q) + '</div>' +
        '<div class="qa-a">⏳ Sent to your AI — the answer will appear here shortly.</div></div>';
    }).join("") + '</div>';
  }
  function askPost(qid, title, q) {
    try {
      const body = new URLSearchParams();
      body.append(ASK_CFG.entry, qid + ASK_CFG.sep + (title || "") + ASK_CFG.sep + q);
      fetch(ASK_CFG.formUrl, { method: "POST", mode: "no-cors", body: body });
    } catch (e) {}
  }
  function applyAnswers() {
    const A = window.AIOS_ANSWERS || {};
    document.querySelectorAll(".qa-item.waiting").forEach((elm) => {
      const qid = elm.getAttribute("data-qid"), ans = A[qid];
      if (!ans || !ans.a) return;
      const rec = askQuestions.find((x) => x.qid === qid) || { q: "" };
      elm.classList.remove("waiting");
      elm.innerHTML = '<div class="qa-q">❓ ' + esc(rec.q) + '</div>' +
        '<div class="qa-a">🤖 ' + esc(ans.a) + '</div>' +
        (ans.summary ? '<div class="qa-sum">📌 ' + esc(ans.summary) + '</div>' : '') +
        (ans.action ? '<div class="qa-act">✅ Added to To-Do: ' + esc(ans.action) + '</div>' : '');
    });
    // auto-add any AI-flagged actions to the To-Do list (once per question)
    let added; try { added = JSON.parse(localStorage.getItem(AADD_KEY) || "[]"); } catch (e) { added = []; }
    const set = new Set(added); let changed = false;
    askQuestions.forEach((rec) => {
      const ans = A[rec.qid];
      if (ans && ans.action && !set.has(rec.qid)) {
        addTodo({ srcTitle: rec.title || "", note: ans.action, category: "From AI", date: "", link: null, remindOn: "" });
        set.add(rec.qid); changed = true;
      }
    });
    if (changed) localStorage.setItem(AADD_KEY, JSON.stringify([...set]));
  }
  function pollAnswers() {
    fetch("answers.js?_=" + Date.now(), { cache: "no-store" }).then((r) => r.text()).then((txt) => {
      const m = txt.match(/AIOS_ANSWERS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (!m) return;
      try {
        const server = JSON.parse(m[1]);
        let local = {}; try { local = JSON.parse(localStorage.getItem(LANS_KEY) || "{}"); } catch (e) {}
        window.AIOS_ANSWERS = Object.assign({}, server, local); // device (instant) answers win
        applyAnswers();
      } catch (e) {}
    }).catch(() => {});
  }

  /* ---- INSTANT mode: ask Gemini straight from the browser (free tier).
         The key is saved ONLY on this device (localStorage), never in the public code. ---- */
  const GKEY = "aios_gemini_key_v1", LANS_KEY = "aios_local_answers_v1", GMODEL = "gemini-3.5-flash";
  const getGKey = () => { try { return localStorage.getItem(GKEY) || ""; } catch (e) { return ""; } };
  function loadLocalAnswers() {
    try {
      const d = JSON.parse(localStorage.getItem(LANS_KEY) || "{}");
      window.AIOS_ANSWERS = Object.assign({}, window.AIOS_ANSWERS || {}, d);
    } catch (e) {}
  }
  function saveLocalAnswer(qid, obj) {
    let d; try { d = JSON.parse(localStorage.getItem(LANS_KEY) || "{}"); } catch (e) { d = {}; }
    d[qid] = obj; try { localStorage.setItem(LANS_KEY, JSON.stringify(d)); } catch (e) {}
    window.AIOS_ANSWERS = window.AIOS_ANSWERS || {}; window.AIOS_ANSWERS[qid] = obj;
  }
  async function askGemini(key, title, q, ctx) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GMODEL + ":generateContent?key=" + encodeURIComponent(key);
    const prompt = "You are helping a Hong Kong teacher who is a non-native English speaker. " +
      "He is reading the item below and asks a follow-up question. " +
      "ANSWER HIS EXACT QUESTION, using the item as context. Do NOT just repeat a definition — reply to what he actually asked.\n\n" +
      "ITEM TITLE: " + (title || "") + "\n" +
      "ITEM CONTENT: " + (ctx || "(no extra detail given)") + "\n\n" +
      "HIS QUESTION: " + q + "\n\n" +
      "Give a direct answer to his specific question and connect it to the item above. " +
      "Use SIMPLE, FORMAL, PLAIN English. Short sentences. Define any technical term. No idioms, no slang.\n\n" +
      "Return ONLY a JSON object with keys: \"a\" (your direct answer, 2 to 4 short sentences), " +
      "\"summary\" (one short line, max 12 words), " +
      "\"action\" (an EMPTY string \"\" in almost all cases; put a short to-do line ONLY if he clearly wants to DO a task himself, e.g. \"remind me\" or \"prepare a slide\").";
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { let t = ""; try { t = await r.text(); } catch (e) {} throw new Error("HTTP " + r.status + " " + t.slice(0, 160)); }
    const data = await r.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const out = parts.map((p) => p.text || "").join("").trim();
    let o; try { o = JSON.parse(out); } catch (e) { o = { a: out || "(no answer)", summary: "", action: "" }; }
    return { a: (o.a || "").trim(), summary: (o.summary || "").trim(), action: (o.action || "").trim() };
  }
  function setupAiKey() {
    const btn = $("ai-key-btn"); if (!btn) return;
    const refresh = () => { btn.textContent = getGKey() ? "🔑 AI ✓" : "🔑 AI"; btn.classList.toggle("on", !!getGKey()); };
    refresh();
    btn.addEventListener("click", () => {
      const v = prompt("Paste your FREE Gemini API key for INSTANT answers.\n\nGet one free (no card) at:\nhttps://aistudio.google.com/apikey\n\nThe key is saved ONLY on this device. To remove it, clear the box and press OK.", "");
      if (v === null) return;
      try { if (v.trim()) localStorage.setItem(GKEY, v.trim()); else localStorage.removeItem(GKEY); } catch (e) {}
      refresh();
      alert(v.trim() ? "Saved on this device. Your questions are now answered instantly." : "Key removed. Questions will use the slower PC method.");
    });
  }

  function noteBoxHTML(item) {
    return '<div class="note-box">' +
      '<span class="note-label">📝 My note / question</span>' +
      '<textarea class="note-input" rows="2" placeholder="Type a question to ask your AI, or an idea to save…"></textarea>' +
      '<div class="note-row"><label class="note-remind-lbl">⏰ <input type="date" class="note-remind" title="Remind me on this date (optional)"></label>' +
      '<button class="note-ask" type="button">🤖 Ask AI</button>' +
      '<button class="note-add" type="button">＋ To-Do</button><span class="note-msg"></span></div>' +
      qaHTML(item) + '</div>';
  }
  function wireNoteBox(card, item) {
    const box = card.querySelector(".note-box"); if (!box) return;
    box.addEventListener("click", (e) => e.stopPropagation());
    const ta = box.querySelector(".note-input"), rem = box.querySelector(".note-remind"), msg = box.querySelector(".note-msg");
    box.querySelector(".note-add").addEventListener("click", () => {
      if (!ta.value.trim() && !rem.value) { msg.textContent = "type something first"; setTimeout(() => (msg.textContent = ""), 2000); return; }
      addTodo({ srcTitle: item.title || "", note: ta.value.trim(), category: item.category || item.type || "Note",
        date: shortDate(item.briefDate || item.date || ""), link: item.link || null, remindOn: rem.value || "" });
      ta.value = ""; rem.value = ""; msg.textContent = "✓ added to To-Do"; setTimeout(() => (msg.textContent = ""), 2500);
    });
    const askBtn = box.querySelector(".note-ask");
    if (askBtn) askBtn.addEventListener("click", () => {
      const q = ta.value.trim();
      if (!q) { msg.textContent = "type a question first"; setTimeout(() => (msg.textContent = ""), 2000); return; }
      const qid = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      askQuestions.push({ qid: qid, key: itemKey(item), title: item.title || "", q: q, ts: new Date().toISOString() });
      saveQuestions();
      ta.value = "";
      const refreshQA = () => { const ql = box.querySelector(".qa-list"), html = qaHTML(item); if (ql) ql.outerHTML = html; else box.insertAdjacentHTML("beforeend", html); };
      refreshQA();
      const gkey = getGKey();
      if (gkey) {
        // INSTANT — ask Gemini directly from the browser, WITH the card's content as context
        msg.textContent = "🤖 thinking…";
        const ctx = [item.summary, item.why, item.action, item.teacher || item.plain || item.terms].filter(Boolean).join("  •  ");
        askGemini(gkey, item.title || "", q, ctx).then((ans) => {
          ans.q = q; ans.ts = new Date().toISOString().slice(0, 16).replace("T", " ");
          saveLocalAnswer(qid, ans); applyAnswers();
          msg.textContent = "✓ answered"; setTimeout(() => (msg.textContent = ""), 2000);
        }).catch(() => {
          msg.textContent = "⚠ key problem — tap 🔑 AI at top to fix"; setTimeout(() => (msg.textContent = ""), 4500);
        });
      } else {
        // FALLBACK — send to your PC via the form (slower)
        askPost(qid, item.title || "", q);
        msg.textContent = "🤖 sent to your AI"; setTimeout(() => (msg.textContent = ""), 2500);
      }
    });
  }

  /* ---- biometric (Face ID / Touch ID) unlock via WebAuthn, with passphrase fallback ---- */
  const BIO_KEY = "aios_bio_id_v1";
  const _b64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  const _unb64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
  const _rand = (n) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return u; };
  const bioSupported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  async function bioRegister() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: _rand(32), rp: { name: "AIOS To-Do", id: location.hostname },
      user: { id: _rand(16), name: "garett", displayName: "Garett" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000, attestation: "none" } });
    localStorage.setItem(BIO_KEY, _b64(cred.rawId));
  }
  async function bioUnlock() {
    const id = localStorage.getItem(BIO_KEY);
    const pk = { challenge: _rand(32), timeout: 60000, userVerification: "required", rpId: location.hostname };
    if (id) pk.allowCredentials = [{ type: "public-key", id: _unb64(id) }];
    await navigator.credentials.get({ publicKey: pk });
  }

  function renderTodoGate() {
    // Password removed — the To-Do list opens directly on every device.
    if ($("todo-lock")) $("todo-lock").hidden = true;
    if ($("todo-main")) $("todo-main").hidden = false;
    todoUnlocked = true;
    renderTodos();
  }

  function todoCard(t) {
    const card = el("article", "todo-card" + (t.status === "done" ? " done" : ""));
    const link = t.link ? `<a class="source-link" href="${esc(t.link)}" target="_blank" rel="noopener">SOURCE ↗</a>` : "";
    card.innerHTML = '<div class="todo-top">' +
        `<span class="tag cat">${esc(t.category || "Note")}</span>` +
        (t.date ? `<span class="tag src">🗓 ${esc(t.date)}</span>` : "") +
        (t.remindOn ? `<span class="tag rem">⏰ ${esc(t.remindOn)}</span>` : "") +
        '<span class="todo-actions">' +
          `<button class="ca tdone" type="button">${t.status === "done" ? "↺ reopen" : "✓ done"}</button>` +
          '<button class="ca tdel" type="button" title="Delete">🗑</button></span></div>' +
      (t.srcTitle ? `<div class="todo-src">📰 ${esc(t.srcTitle)}</div>` : "") +
      '<span class="note-label">📝 My note</span>' +
      `<textarea class="todo-note" rows="2" placeholder="(type your idea)">${esc(t.note || "")}</textarea>` +
      '<div class="todo-row2"><label class="note-remind-lbl">⏰ Remind me <input type="date" class="todo-remind" value="' + esc(t.remindOn || "") + '"></label></div>' +
      '<div class="todo-sugg">' + (t.suggestion ? `<div class="sugg-text"><b>🤖 AI answer:</b> ${esc(t.suggestion)}</div>` : '<button class="sugg-btn" type="button">🤖 Ask AI to answer</button>') + '</div>' +
      (link ? `<div class="frame-source">${link}</div>` : "");
    card.querySelector(".tdone").addEventListener("click", () => patchTodo(t.id, { status: t.status === "done" ? "open" : "done" }));
    card.querySelector(".tdel").addEventListener("click", () => { if (confirm("Delete this to-do?")) dropTodo(t.id); });
    card.querySelector(".todo-note").addEventListener("change", (e) => patchTodo(t.id, { note: e.target.value }));
    card.querySelector(".todo-remind").addEventListener("change", (e) => patchTodo(t.id, { remindOn: e.target.value }));
    const sb = card.querySelector(".sugg-btn"); if (sb) sb.addEventListener("click", () => getSuggestion(t));
    return card;
  }

  function renderTodos() {
    const host = $("todo-list"); if (!host) return;
    let list = todos.slice();
    if (todoFilter === "open") list = list.filter((t) => t.status === "open");
    else if (todoFilter === "done") list = list.filter((t) => t.status === "done");
    if (todoQuery) list = list.filter((t) => ((t.srcTitle || "") + " " + (t.note || "") + " " + (t.category || "")).toLowerCase().includes(todoQuery));
    host.innerHTML = "";
    if (!list.length) host.appendChild(el("div", "empty-note", todos.length
      ? "Nothing here. Change the filter above, or add notes from any news card."
      : "No to-dos yet. Open any news card, type a note at the bottom, and tap “＋ Add to my To-Do”."));
    list.forEach((t) => host.appendChild(todoCard(t)));
    updateTodoNavCount(); renderTodoReminders();
  }
  function renderTodoReminders() {
    const host = $("todo-reminders"); if (!host) return;
    const today = todayStr();
    const due = todos.filter((t) => t.status === "open" && t.remindOn && t.remindOn <= today);
    const soon = todos.filter((t) => t.status === "open" && t.remindOn && t.remindOn > today).sort((a, b) => a.remindOn.localeCompare(b.remindOn)).slice(0, 3);
    if (!due.length && !soon.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML = (due.length ? `<div class="rem-due">⏰ <b>${due.length}</b> reminder${due.length > 1 ? "s" : ""} due now</div>` : "") +
      soon.map((t) => `<div class="rem-soon">📅 ${esc(t.remindOn)} — ${esc((t.srcTitle || t.note || "").slice(0, 60))}</div>`).join("");
  }
  function updateTodoNavCount() {
    const open = todos.filter((t) => t.status === "open").length;
    if ($("todo-nav-count")) $("todo-nav-count").textContent = open;
    const due = todos.filter((t) => t.status === "open" && t.remindOn && t.remindOn <= todayStr()).length;
    const nav = document.querySelector('.vnav[data-view="todo"]'); if (nav) nav.classList.toggle("has-due", due > 0);
  }

  function cloudPush(t) {
    if (!TODO_CFG.appsUrl || !t) return;
    try { fetch(TODO_CFG.appsUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(Object.assign({ action: "save", secret: todoPassVal }, t)) }); t.synced = true; saveTodos(); } catch (e) {}
  }
  function syncAll() {
    if (!TODO_CFG.appsUrl) { alert("Cloud sync is not set up yet.\n\nFinish the 5-minute Google step, then paste your link into app.js (TODO_CFG.appsUrl). After that this button saves every note to your private Google Sheet, on every device."); return; }
    todos.forEach(cloudPush); alert("Your notes were sent to your private Google Sheet.");
  }
  function getSuggestion(t) {
    if (!TODO_CFG.appsUrl) {
      alert("AI answering is doable and almost ready.\n\nIt needs a one-time 5-minute Google + Gemini setup. After that: write your question in the note, tap “Ask AI to answer”, and the answer appears here and stays saved.");
      return;
    }
    // JSONP call so the dashboard can read the answer across origins
    const cb = "aiosAns" + Math.floor(Math.random() * 1e9);
    const s = document.createElement("script");
    let done = false;
    window[cb] = (data) => { done = true; try { if (data && data.answer) patchTodo(t.id, { suggestion: data.answer }); } finally { delete window[cb]; s.remove(); } };
    const secret = localStorage.getItem("aios_sync_secret") || todoPassVal || "";
    s.src = TODO_CFG.appsUrl + "?action=ask&secret=" + encodeURIComponent(secret) +
      "&title=" + encodeURIComponent(t.srcTitle || "") + "&q=" + encodeURIComponent(t.note || "") + "&callback=" + cb;
    s.onerror = () => { if (!done) { delete window[cb]; s.remove(); alert("Could not reach the AI helper — check the Google setup."); } };
    patchTodo(t.id, { suggestion: "… thinking …" });
    document.body.appendChild(s);
  }

  function setupTodo() {
    var _tsEl = $("todo-search"); if (_tsEl) _tsEl.addEventListener("input", (e) => { todoQuery = e.target.value.trim().toLowerCase(); renderTodos(); });
    document.querySelectorAll(".todo-filter").forEach((b) => b.addEventListener("click", () => {
      todoFilter = b.dataset.f; document.querySelectorAll(".todo-filter").forEach((x) => x.classList.toggle("active", x === b)); renderTodos(); }));
    $("todo-sync").addEventListener("click", syncAll);
    var _lb = $("todo-lockbtn"); if (_lb) _lb.style.display = "none";
    updateTodoNavCount();
  }

  /* ---------------- GLOBAL SEARCH (news + library + to-dos in one) ---------------- */
  function renderGlobalSearch() {
    const sv = $("search-view"), inp = $("global-search");
    if (!sv || !inp) return;
    const q = (inp.value || "").trim().toLowerCase();
    if ($("gs-clear")) $("gs-clear").hidden = !q;
    if (!q) {
      sv.hidden = true;
      const active = document.querySelector(".vnav.active");
      const v = active ? active.dataset.view : "radar";
      $("hq-view").hidden = (v !== "hq");
      $("radar-view").hidden = (v !== "radar");
      $("library-view").hidden = (v !== "library");
      $("todo-view").hidden = (v !== "todo");
      return;
    }
    $("hq-view").hidden = true; $("radar-view").hidden = true; $("library-view").hidden = true; $("todo-view").hidden = true;
    sv.hidden = false;
    const libHits = libItems.filter((it) =>
      [it.title, it.summary, it.why, it.action, it.teacher, it.plain, it.terms, it.type, it.source].join(" ").toLowerCase().includes(q));
    const todoHits = todos.filter((t) =>
      ((t.srcTitle || "") + " " + (t.note || "") + " " + (t.category || "") + " " + (t.suggestion || "")).toLowerCase().includes(q));
    const cap = 200;
    $("search-meta").innerHTML =
      `🔍 <b>${todoHits.length}</b> to-do${todoHits.length === 1 ? "" : "s"} &amp; <b>${libHits.length}</b> news / library item${libHits.length === 1 ? "" : "s"} for “<b>${esc(inp.value.trim())}</b>”` +
      (libHits.length > cap ? ` · showing first ${cap}` : "");
    const res = $("search-results"); res.innerHTML = "";
    if (!todoHits.length && !libHits.length) { res.appendChild(el("div", "empty-note", "Nothing found — try another word.")); return; }
    todoHits.forEach((t) => res.appendChild(todoCard(t)));
    libHits.slice(0, cap).forEach((it) => res.appendChild(libCard(it)));
  }
  function setupGlobalSearch() {
    const inp = $("global-search"); if (!inp) return;
    inp.addEventListener("input", renderGlobalSearch);
    const c = $("gs-clear");
    if (c) c.addEventListener("click", () => { inp.value = ""; renderGlobalSearch(); inp.focus(); });
  }

  loadLocalAnswers();   // merge this device's instant answers before the cards render
  renderProfile();
  setupLibrary();
  setupNav();
  setupTodo();
  setupGlobalSearch();
  setupAiKey();
  mount();
  // Ask-AI: show any answers already delivered, then check for new ones periodically
  applyAnswers();
  setTimeout(pollAnswers, 3000);
  setInterval(pollAnswers, 20000);
})();
