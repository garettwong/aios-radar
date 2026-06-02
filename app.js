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
  $("search-box").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); refreshBoard(); });

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
      '<div class="signal-details">' + detailFrames(s.summary, s.why, s.action, s.teacher, s.link) + "</div>";
    card.querySelector(".ca.read").addEventListener("click", (e) => { e.stopPropagation(); toggleRead(s); });
    card.querySelector(".ca.save").addEventListener("click", (e) => { e.stopPropagation(); toggleSave(s); });
    card.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button")) return; card.classList.toggle("open"); });
    return card;
  }
  function block(label, text) {
    if (!text) return "";
    return `<div class="detail-block"><span class="detail-label">${label}</span><span class="detail-text">${esc(text)}</span></div>`;
  }
  // 4 clear framed sections (Summary / Why / Action / Teacher) + source — used by RADAR and LIBRARY
  function detailFrames(summary, why, action, teacher, link) {
    const f = (ico, label, txt, cls) =>
      `<div class="frame ${cls}"><div class="frame-ico">${ico}</div><div class="frame-body">` +
      `<span class="frame-label">${label}</span><div class="frame-text">${txt ? esc(txt) : "—"}</div></div></div>`;
    const lk = link
      ? `<a class="source-link" href="${esc(link)}" target="_blank" rel="noopener">SOURCE ↗</a>`
      : `<span class="source-link disabled">SOURCE — n/a</span>`;
    return f("🎯", "SUMMARY", summary, "f-sum") +
           f("💡", "WHY IT MATTERS", why, "f-why") +
           f("🔧", "PRACTICAL ACTION", action, "f-act") +
           f("🎓", "TEACHER NOTE", teacher, "f-teach") +
           `<div class="frame-source">${lk}</div>`;
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
      '<div class="signal-details">' + detailFrames(it.summary, it.why, it.action, it.teacher || it.plain || it.terms, it.link) + "</div>";
    card.querySelector(".ca.read").addEventListener("click", (e) => { e.stopPropagation(); toggleRead(it); });
    card.querySelector(".ca.save").addEventListener("click", (e) => { e.stopPropagation(); toggleSave(it); });
    card.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button")) return; card.classList.toggle("open"); });
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
    const order = ["Job / Opportunity", "AI Tools", "Popular AI Tools", "AI Terms", "AI 3D", "AI Trends", "AI News"];
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
    $("lib-search").addEventListener("input", (e) => { libQuery = e.target.value.trim().toLowerCase(); libLimit = 120; renderLibrary(); });
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
    h.innerHTML = v === "library"
      ? `📚 <b>LIBRARY</b> — everything archived &amp; searchable: <b>${briefs}</b> signals from all your email briefs + <b>${arch}</b> reference items (incl. 242 AI terms).`
      : `📡 <b>RADAR</b> — your <b>newest</b> email brief only (auto-pulled every 3h). Step back through past briefs with 📅 EDITION; the full history is in 📚 LIBRARY.`;
  }
  function setupNav() {
    document.querySelectorAll(".vnav").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        document.querySelectorAll(".vnav").forEach((b) => b.classList.toggle("active", b === btn));
        $("radar-view").hidden = (v !== "radar");
        $("library-view").hidden = (v !== "library");
        setViewHelp(v);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    setViewHelp("radar");
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
  }

  renderProfile();
  setupLibrary();
  setupNav();
  mount();
})();
