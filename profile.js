/* =============================================================================
   OCC AIOS · OPERATOR PROFILE  (your command-center tiles)
   -----------------------------------------------------------------------------
   SAFE TO EDIT BY HAND. The 3-hourly auto-refresh only rewrites data.js — it
   NEVER touches this file, so your numbers stay put.

   Fill in "value" with your real number (e.g. "65.8K"). Leave it as "" or null
   and the tile shows an editable placeholder. Or just ask Claude:
       "set my YouTube subs to 12.4K and MRR to $3,200"
============================================================================= */

window.DASHBOARD_PROFILE = {
  // Active projects — shown in the RADAR side-rail. The fuller picture
  // (today / money / pending / wishlist) lives in the 🧭 HQ tab (hq.js).
  projects: [
    { name: "ERB · 4 AI certs (instructor)", status: "ACTIVE", note: "Reusable slides + handout per course — recurring income" },
    { name: "Booth Render Pipeline",         status: "ACTIVE", note: "Deck → 8 photoreal renders (Blender depth + FLUX-Krea). Consolidate 4 folders → 1" },
    { name: "FlyTaxi app",                    status: "DEV",    note: "Define the smallest usable MVP" },
    { name: "AIOS Cockpit + Radar",           status: "LIVE",   note: "This dashboard — HQ tab + news auto-refresh every 3h" },
    { name: "garett-3d Experiment 1",         status: "ACTIVE", note: "Coded; run run_all.py → 65% gate" },
    { name: "ComfyUI course",                 status: "ACTIVE", note: "Notes → sellable syllabus" },
  ],
};
