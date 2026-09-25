/* HM Coach dashboard – renders the view model written by `garmin-coach sync`. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/_(.+?)_/g, "<i>$1</i>");
  const de = (n, d = 1) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const dateFmt = (iso, opts) => new Date(iso + (iso.length === 10 ? "T12:00:00" : "")).toLocaleDateString("de-DE", opts);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const SPORT = {
    run: { icon: "🏃", label: "Lauf" }, bike: { icon: "🚴", label: "Rad" }, strength: { icon: "🏋️", label: "Kraft" },
    row: { icon: "🚣", label: "Rudern" }, swim: { icon: "🏊", label: "Schwimmen" }, sail: { icon: "⛵", label: "Segeln" },
    other: { icon: "⚡", label: "Training" },
  };
  // Sport colours follow the categorical chart palette; every chip also carries an icon, so colour is never the only cue.
  const PHASE_COLOR = { reset: "var(--text-muted)", base1: "var(--series-3)", base2: "var(--series-1)", build: "var(--series-7)", specific: "var(--series-2)", taper: "var(--series-4)" };
  const LEVEL = { green: ["var(--good)", "Bereit"], yellow: ["var(--warning)", "Vorsicht"], red: ["var(--critical)", "Erholung"] };

  let DATA = null;

  // ------------------------------------------------------------------ data & crypto
  async function decrypt(envelope, passphrase) {
    const env = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(env.salt), iterations: env.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, key, b64(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function fetchJSON(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function load(passphrase) {
    if (window.__COACH_DEMO__) return window.__COACH_DEMO__;
    const demo = new URLSearchParams(location.search).has("demo");
    if (demo) return fetchJSON("demo-data.json");
    try {
      const env = await fetchJSON("data.enc");
      const pass = passphrase || store.get("coach-pass");
      if (!pass) throw Object.assign(new Error("locked"), { locked: true });
      return await decrypt(env, pass);
    } catch (err) {
      if (err.locked || err.name === "OperationError") throw Object.assign(err, { locked: true });
      try { return await fetchJSON("data.json"); } catch { /* fall through */ }
      try { return await fetchJSON("demo-data.json"); } catch { throw err; }
    }
  }

  async function boot(passphrase, remember) {
    try {
      DATA = await load(passphrase);
      if (passphrase && remember) store.set("coach-pass", passphrase);
      $("#lock").classList.add("hidden");
      $("#app").classList.remove("hidden");
      render();
    } catch (err) {
      if (err.locked) {
        if (passphrase) $("#lock-error").textContent = "Passphrase stimmt nicht.";
        else store.del("coach-pass");
        $("#app").classList.add("hidden");
        $("#lock").classList.remove("hidden");
        $("#pass").focus();
      } else {
        $("#lock").classList.add("hidden");
        $("#app").classList.remove("hidden");
        $("#view-today").innerHTML = `<div class="card empty">Noch keine Daten. Der erste Abgleich läuft über GitHub Actions (alle 30 Minuten).<br><small>${esc(err.message)}</small></div>`;
      }
    }
  }

  // ------------------------------------------------------------------ small components
  const scoreClass = (s) => (s == null ? "" : s >= 85 ? "s-good" : s >= 60 ? "s-ok" : "s-bad");
  const scoreBadge = (s) => (s == null ? "" : `<span class="score ${scoreClass(s)}">${s}</span>`);
  const sizeOf = (s) => (s.distance_km ? `${de(s.distance_km)} km` : `${s.duration_min}'`);

  function stateLabel(s) {
    if (s.status === "done") return s.score != null ? scoreBadge(s.score) : `<span class="state-ico">✓ erledigt</span>`;
    if (s.status === "missed") return `<span class="state-ico">verpasst</span>`;
    if (s.status === "skipped") return `<span class="state-ico">–</span>`;
    return `<span class="state-ico">${s.duration_min}'</span>`;
  }

  function sessionCard(s) {
    const sp = SPORT[s.sport] || SPORT.other;
    const badges = [
      s.key ? `<span class="badge key">Schlüssel</span>` : "",
      s.sport === "sail" ? `<span class="badge sail">Priorität</span>` : "",
      s.optional ? `<span class="badge opt">optional</span>` : "",
    ].join(" ");
    const meta = [sizeOf(s), s.pace_label && s.profile !== "hills" && s.sport === "run" ? s.pace_label : null].filter(Boolean).join(" · ");
    return `<div class="session">
      <div class="sport-ico ${s.sport === "sail" ? "sail" : s.key ? "key" : ""}" aria-hidden="true">${sp.icon}</div>
      <div>
        <div class="t">${esc(s.title)} ${badges}</div>
        <div class="d">${esc(s.detail)}</div>
        <div class="m">${esc(meta)}</div>
        ${s.adjusted ? `<div class="adjusted">↻ ${esc(s.adjusted)}</div>` : ""}
      </div>
      <div>${stateLabel(s)}</div>
    </div>`;
  }

  function ring(score, color) {
    const r = 40, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, score ?? 0));
    return `<div class="ring"><svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
      <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
      <circle cx="46" cy="46" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${(c * v) / 100} ${c}"/></svg>
      <div class="val"><div><b class="num">${score ?? "–"}</b><span>READINESS</span></div></div></div>`;
  }

  function tile(label, value, unit, delta) {
    return `<div class="card tile"><div class="label">${esc(label)}</div>
      <div class="value num">${value}${unit ? ` <small>${esc(unit)}</small>` : ""}</div>
      ${delta ? `<div class="delta">${delta}</div>` : ""}</div>`;
  }

  // ------------------------------------------------------------------ views
  // ------------------------------------------------------------------ home ("Heute")
  const sportOf = (k) => SPORT[k] || SPORT.other;
  const sportVar = (k) => `var(--c-${SPORT[k] ? k : "other"})`;
  const weekday = (iso, len = "short") => dateFmt(iso, { weekday: len });
  const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  function ringSvg(value, max, color, size = 76, stroke = 8) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, (value ?? 0) / max));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="transform:rotate(-90deg)">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c * v} ${c}"/></svg>`;
  }

  function heroBand() {
    const g = DATA.goal, m = DATA.metrics;
    const now = DATA.plan.findIndex((w) => w.status === "current");
    const segs = DATA.plan.map((w, i) => `<i class="seg ${i < now ? "past" : i === now ? "now" : ""}" style="--pc:${PHASE_COLOR[w.phase]}" title="W${w.index + 1} ${esc(w.phase_label)}"></i>`).join("");
    const gap = g.predicted_s - g.target_s;
    return `<section class="hero-band">
      <div class="hero-main">
        <div class="eyebrow">${g.week_no ? `Woche ${g.week_no} von ${g.weeks_total} · ${esc(DATA.week.phase_label)}${DATA.week.deload ? " · Entlastung" : ""}` : `Plan startet am ${dateFmt(g.plan_start, { day: "2-digit", month: "2-digit" })}`}</div>
        <h2>Auf dem Weg zu ${esc(g.target)}</h2>
        <div class="plan-strip" role="img" aria-label="Planfortschritt">${segs}</div>
        <div class="plan-strip-legend"><span>${dateFmt(DATA.plan[0].start, { day: "2-digit", month: "2-digit" })}</span><span>🏁 ${dateFmt(g.date, { day: "2-digit", month: "2-digit" })}</span></div>
      </div>
      <div class="bib">
        <div class="bib-top">${esc(g.race)}</div>
        <div class="bib-num num">${g.days_to_go}</div>
        <div class="bib-sub">Tage bis zum Start</div>
        <div class="bib-row"><span>Ziel <b class="num">${esc(g.target)}</b></span><span>Prognose <b class="num">${esc(g.predicted)}</b></span></div>
        <div class="bib-gap ${gap <= 0 ? "ok" : ""}">${gap <= 0 ? "Auf Zielkurs" : `noch ${Math.floor(gap / 60)}:${String(Math.round(gap % 60)).padStart(2, "0")} bis zum Ziel`} · VDOT ${de(g.vdot)}</div>
      </div>
    </section>`;
  }

  function dayCheck() {
    const t = DATA.today, w = t.wellness || {}, m = DATA.metrics, r = t.readiness;
    const wl = DATA.wellness.slice(0, -1).slice(-7);
    const rhrAvg = avg(wl.map((x) => x.rhr)), hrvAvg = avg(wl.map((x) => x.hrv));
    const sleepCol = w.sleep_score == null ? "var(--text-muted)" : w.sleep_score >= 80 ? "var(--good)" : w.sleep_score >= 60 ? "var(--warning)" : "var(--critical)";
    const sleepWord = w.sleep_score == null ? "Keine Schlafdaten" : w.sleep_score >= 80 ? "Gut geschlafen" : w.sleep_score >= 60 ? "Okay geschlafen" : "Schlecht geschlafen";
    const [lvlCol, lvlWord] = r ? LEVEL[r.level] : ["var(--text-muted)", "Warte auf Uhr"];
    const bodyText = !r ? "Sobald die Uhr die Nacht synchronisiert hat, erscheint hier dein Zustand."
      : r.level === "green" ? "Dein Körper ist erholt – die geplante Belastung passt."
      : r.level === "yellow" ? "Leicht angeschlagen – Schlüsseleinheit etwas entschärfen."
      : "Dein Körper braucht Erholung – heute nur locker.";
    const trend = (v, ref, unit, upGood) => {
      if (v == null || ref == null) return "";
      const d = v - ref; if (Math.abs(d) < 1) return `<em class="flat">±0</em>`;
      const good = upGood ? d > 0 : d < 0;
      return `<em class="${good ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d))}${unit}</em>`;
    };
    const tsbWord = m.tsb > 5 ? "frisch" : m.tsb > -10 ? "ausgewogen" : m.tsb > -25 ? "belastet" : "sehr müde";
    const sessions = t.sessions.length ? t.sessions.map((s) => {
      const sp = sportOf(s.sport);
      return `<div class="today-item" style="--sc:${sportVar(s.sport)}">
        <div class="ti-ico">${sp.icon}</div>
        <div class="ti-body"><div class="ti-t">${esc(s.title)}${s.key ? ' <span class="badge key">Schlüssel</span>' : ""}${s.optional ? ' <span class="badge opt">optional</span>' : ""}</div>
          <div class="ti-d">${esc(s.detail)}</div>
          <div class="ti-m">${esc(sizeOf(s))}${s.pace_label && s.sport === "run" && s.profile !== "hills" ? " · " + esc(s.pace_label) : ""}</div>
          ${s.adjusted ? `<div class="adjusted">↻ ${esc(s.adjusted)}</div>` : ""}</div>
        <div>${stateLabel(s)}</div></div>`;
    }).join("") : `<div class="rest-day">🛌 Ruhetag – Beine hoch, gut essen, früh schlafen.</div>`;
    return `<section class="card daycheck">
      <header class="card-head"><h3>Tagescheck</h3><span class="muted">${dateFmt(t.date, { weekday: "long", day: "2-digit", month: "long" })}</span></header>
      <div class="dc-grid">
        <div class="dc-cell">
          <div class="dc-label">😴 Schlaf</div>
          <div class="dc-ring">${ringSvg(w.sleep_score, 100, sleepCol)}<div class="dc-val"><b class="num">${w.sleep_score ?? "–"}</b><span>Score</span></div></div>
          <div class="dc-word">${sleepWord}</div>
          <div class="dc-sub num">${w.sleep_h ? `${de(w.sleep_h)} h Schlaf` : ""}</div>
        </div>
        <div class="dc-cell">
          <div class="dc-label">💪 Körper</div>
          <div class="dc-ring">${ringSvg(r?.score, 100, lvlCol)}<div class="dc-val"><b class="num">${r?.score ?? "–"}</b><span>Readiness</span></div></div>
          <div class="dc-word"><i class="dot" style="background:${lvlCol}"></i>${lvlWord}</div>
          <div class="vitals">
            <span>HRV <b class="num">${w.hrv ?? "–"}</b> ${trend(w.hrv, hrvAvg, "", true)}</span>
            <span>Ruhepuls <b class="num">${w.rhr ?? "–"}</b> ${trend(w.rhr, rhrAvg, "", false)}</span>
            <span>Body Battery <b class="num">${w.body_battery ?? "–"}</b></span>
            <span>Frische <b class="num">${m.tsb > 0 ? "+" : ""}${de(m.tsb, 0)}</b> <em class="flat">${tsbWord}</em></span>
          </div>
        </div>
        <div class="dc-cell dc-today">
          <div class="dc-label">📋 Heute steht an</div>
          <p class="dc-verdict" style="--lc:${lvlCol}">${bodyText}</p>
          ${t.note ? `<div class="adjusted">↻ ${esc(t.note)}</div>` : ""}
          <div class="today-list">${sessions}</div>
          ${t.next ? `<div class="dc-next">Als Nächstes → ${esc(t.next)}</div>` : ""}
        </div>
      </div>
    </section>`;
  }

  function weekDone() {
    const wk = DATA.week;
    const from = wk.start, to = addDays(wk.start, 6);
    const done = DATA.activities.filter((a) => a.start.slice(0, 10) >= from && a.start.slice(0, 10) <= to).reverse();
    const planned = wk.days.flatMap((d) => d.sessions).filter((s) => s.sport !== "sail" && !s.optional);
    const doneCount = planned.filter((s) => s.status === "done").length;
    const bySport = wk.actual.by_sport || {};
    const total = Object.values(bySport).reduce((a, b) => a + b, 0);
    const order = ["run", "bike", "row", "strength", "swim", "sail", "other"].filter((k) => bySport[k]);
    const bar = total ? order.map((k) => `<i style="width:${(bySport[k] / total) * 100}%;background:${sportVar(k)}" title="${sportOf(k).label} ${de(bySport[k])} h"></i>`).join("") : "";
    const legend = order.map((k) => `<span><i style="background:${sportVar(k)}"></i>${sportOf(k).label} <b class="num">${de(bySport[k])} h</b></span>`).join("");
    const scores = done.map((a) => a.score).filter((s) => s != null);
    const list = done.map((a) => {
      const i = DATA.activities.indexOf(a);
      const facts = [a.distance_km ? `${de(a.distance_km)} km` : null, a.duration, a.pace ? `${a.pace}/km` : null].filter(Boolean).join(" · ");
      return `<button class="done-row" data-act="${i}" style="--sc:${sportVar(a.sport)}">
        <span class="dr-ico">${sportOf(a.sport).icon}</span>
        <span class="dr-body"><span class="dr-t">${esc(a.name)}</span><span class="dr-d">${weekday(a.start.slice(0, 10))} · ${esc(facts)}</span></span>
        ${a.score != null ? scoreBadge(a.score) : `<span class="state-ico">${esc(a.rating || "✓")}</span>`}</button>`;
    }).join("");
    const kmPct = wk.planned_km ? Math.min(100, (wk.actual.run_km / wk.planned_km) * 100) : 0;
    const hPct = wk.planned_h ? Math.min(100, (wk.actual.hours / wk.planned_h) * 100) : 0;
    return `<section class="card weekdone">
      <header class="card-head"><h3>Diese Woche erledigt</h3><span class="muted">KW ${isoWeek(wk.start)}</span></header>
      <div class="wd-stats">
        <div><div class="k">Einheiten</div><div class="v num">${doneCount}<small>/${planned.length}</small></div></div>
        <div><div class="k">Laufen</div><div class="v num">${de(wk.actual.run_km)}<small>/${de(wk.planned_km, 0)} km</small></div><div class="mini-meter"><i style="width:${kmPct}%;background:var(--c-run)"></i></div></div>
        <div><div class="k">Training</div><div class="v num">${de(wk.actual.hours)}<small>/${de(wk.planned_h)} h</small></div><div class="mini-meter"><i style="width:${hPct}%;background:var(--accent)"></i></div></div>
        <div><div class="k">Ø Bewertung</div><div class="v num">${scores.length ? Math.round(avg(scores)) : "–"}<small>/100</small></div></div>
      </div>
      ${total ? `<div class="sport-bar" role="img" aria-label="Stunden nach Sportart">${bar}</div><div class="sport-legend">${legend}</div>` : ""}
      <div class="done-list">${list || '<div class="empty">Diese Woche noch nichts erledigt.</div>'}</div>
    </section>`;
  }

  function calendar() {
    const todayIso = DATA.today.date;
    const head = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => `<div class="cal-h">${d}</div>`).join("");
    const chip = (s, done) => {
      const sp = sportOf(s.sport);
      const size = s.distance_km ? `${de(s.distance_km)} km` : `${s.duration_min}'`;
      const cls = [s.status || (done ? "done" : ""), s.key ? "key" : "", s.optional ? "opt" : ""].join(" ");
      const mark = s.status === "done" || done ? (s.score != null ? `<b class="cs ${scoreClass(s.score)}">${s.score}</b>` : `<b class="cs">✓</b>`) : s.status === "missed" ? `<b class="cs miss">✕</b>` : "";
      return `<div class="chip-s ${cls}" style="--sc:${sportVar(s.sport)}"><span class="ci">${sp.icon}</span><span class="ct">${esc(s.title || s.name)}</span><span class="cz num">${size}</span>${mark}</div>`;
    };
    const rows = DATA.calendar.map((w, wi) => {
      const cells = w.days.map((d, di) => {
        const items = d.sessions.map((s) => chip(s)).concat(d.unplanned.map((u) => chip({ ...u, title: u.name, status: "done" }, true))).join("");
        const cls = [d.date === todayIso ? "today" : "", d.date < todayIso ? "past" : ""].join(" ");
        return `<div class="cal-cell ${cls}" data-w="${wi}" data-d="${di}" role="button" tabindex="0" aria-label="${dateFmt(d.date, { weekday: "long", day: "2-digit", month: "long" })}">
          <div class="cal-date">${dateFmt(d.date, { day: "numeric" })}${d.date.endsWith("-01") ? " " + dateFmt(d.date, { month: "short" }) : ""}</div>${items}</div>`;
      }).join("");
      const sum = w.actual ? `<b class="num">${de(w.actual.run_km, 0)}</b>/${w.planned_km != null ? de(w.planned_km, 0) : "–"} km` : `<b class="num">${w.planned_km != null ? de(w.planned_km, 0) : "–"}</b> km`;
      return `<div class="cal-week ${w.start === DATA.week.start ? "current" : ""}">
        <div class="cal-side" style="--pc:${w.phase ? PHASE_COLOR[w.phase] : "var(--text-muted)"}">
          <div class="cw">KW ${isoWeek(w.start)}</div><div class="cp">${esc(w.phase_label)}${w.deload ? " · Entl." : ""}</div>
          <div class="csum">${sum}</div>${w.sailing_days ? `<div class="csail">⛵ ${w.sailing_days} T</div>` : ""}</div>
        ${cells}</div>`;
    }).join("");
    const legend = ["run", "bike", "row", "strength", "sail"].map((k) => `<span><i style="background:${sportVar(k)}"></i>${sportOf(k).label}</span>`).join("");
    return `<section class="card cal">
      <header class="card-head"><h3>Kalender</h3><div class="sport-legend">${legend}<span><i class="keymark"></i>Schlüssel</span></div></header>
      <div class="cal-grid"><div class="cal-week cal-head"><div class="cal-h"></div>${head}</div>${rows}</div>
      <p class="muted cal-hint">Tag antippen für Details.</p>
    </section>`;
  }

  function openDay(d) {
    const items = d.sessions.map((s) => sessionCard(s)).join("") + d.unplanned.map((u) => sessionCard({ ...u, title: u.name, detail: "ungeplant", status: "done" })).join("");
    openSheet(`<h2>${dateFmt(d.date, { weekday: "long", day: "2-digit", month: "long" })}</h2>
      ${d.note ? `<div class="adjusted">↻ ${esc(d.note)}</div>` : ""}
      <div style="margin-top:8px">${items || '<div class="rest-day">Ruhetag</div>'}</div>`);
  }

  function upcoming() {
    const todayIso = DATA.today.date;
    const days = DATA.calendar.flatMap((w) => w.days).filter((d) => d.date >= todayIso).slice(0, 7);
    const cols = days.map((d, i) => {
      const open = d.sessions.filter((s) => s.status !== "done");
      const done = d.sessions.filter((s) => s.status === "done");
      const items = open.map((s) => `<div class="up-item ${s.key ? "key" : ""} ${s.optional ? "opt" : ""}" style="--sc:${sportVar(s.sport)}">
          <div class="up-top"><span class="up-ico">${sportOf(s.sport).icon}</span><span class="up-sport">${sportOf(s.sport).label}</span>${s.key ? '<span class="up-key" title="Schlüsseleinheit">◆</span>' : ""}</div>
          <div class="up-t">${esc(s.title)}</div>
          <div class="up-d">${esc(s.detail)}</div>
          <div class="up-m num">${esc(sizeOf(s))}${s.pace_label && s.sport === "run" && s.profile !== "hills" ? " · " + esc(s.pace_label) : ""}</div>
          ${s.adjusted ? `<div class="up-adj">↻ angepasst</div>` : ""}</div>`).join("");
      const doneNote = done.length ? `<div class="up-done">✓ ${done.length} erledigt</div>` : "";
      const label = i === 0 ? "Heute" : i === 1 ? "Morgen" : weekday(d.date, "long");
      return `<div class="up-day ${i === 0 ? "today" : ""}" data-day="${d.date}">
        <div class="up-head"><b>${label}</b><span>${dateFmt(d.date, { day: "2-digit", month: "2-digit" })}</span></div>
        ${items || (done.length ? "" : '<div class="up-rest">Ruhetag</div>')}${doneNote}</div>`;
    }).join("");
    const plannedKm = days.flatMap((d) => d.sessions).filter((s) => s.sport === "run" && !s.optional && s.status !== "done").reduce((a, s) => a + (s.distance_km || 0), 0);
    const keys = days.flatMap((d) => d.sessions).filter((s) => s.key && s.status !== "done").length;
    return `<section class="card upcoming">
      <header class="card-head"><h3>Anstehende Trainings</h3><span class="muted">nächste 7 Tage · ${de(plannedKm, 0)} km Laufen · ${keys} Schlüsseleinheit${keys === 1 ? "" : "en"}</span></header>
      <div class="up-strip">${cols}</div>
    </section>`;
  }

  function renderToday() {
    $("#view-today").innerHTML = upcoming() + `<div class="home-grid">${dayCheck()}${weekDone()}</div>` + calendar()
      + `<p class="muted stand">Stand ${new Date(DATA.generated_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · Fitness ${de(DATA.metrics.ctl, 0)} · Ermüdung ${de(DATA.metrics.atl, 0)} · Umfangsfaktor ${Math.round((DATA.metrics.scale ?? 1) * 100)} %</p>`;
    $("#view-today").onclick = (e) => {
      const act = e.target.closest("[data-act]");
      if (act) return openActivity(DATA.activities[+act.dataset.act]);
      const cell = e.target.closest(".cal-cell");
      if (cell) return openDay(DATA.calendar[+cell.dataset.w].days[+cell.dataset.d]);
      const up = e.target.closest(".up-day");
      if (up) openDay(DATA.calendar.flatMap((w) => w.days).find((d) => d.date === up.dataset.day));
    };
    $("#view-today").onkeydown = (e) => { if (e.key === "Enter" && e.target.classList.contains("cal-cell")) e.target.click(); };
  }

  function renderWeek() {
    const wk = DATA.week;
    const todayIso = DATA.today.date;
    const kmPct = wk.planned_km ? Math.min(100, (wk.actual.run_km / wk.planned_km) * 100) : 0;
    const hPct = wk.planned_h ? Math.min(100, (wk.actual.hours / wk.planned_h) * 100) : 0;
    const days = wk.days.map((d) => {
      const items = d.sessions.map((s) => {
        const sp = SPORT[s.sport] || SPORT.other;
        return `<div class="mini ${s.sport === "sail" ? "sail" : ""} ${s.status === "missed" ? "missed" : ""}" style="--sc:${sportVar(s.sport)}">
          <div class="l"><div class="t">${sp.icon} ${esc(s.title)} ${s.key ? '<span class="badge key">S</span>' : ""}${s.optional ? ' <span class="badge opt">opt.</span>' : ""}</div>
          <div class="d">${esc(sizeOf(s))}${s.pace_label && s.sport === "run" && s.profile !== "hills" ? " · " + esc(s.pace_label) : ""}${s.adjusted ? " · ↻ angepasst" : ""}</div></div>
          ${stateLabel(s)}</div>`;
      });
      d.unplanned.forEach((u) => items.push(`<div class="mini"><div class="l"><div class="t">${(SPORT[u.sport] || SPORT.other).icon} ${esc(u.name)}</div><div class="d">ungeplant</div></div><span class="state-ico">✓</span></div>`));
      return `<div class="day ${d.date === todayIso ? "today" : ""}">
        <div class="dname"><b>${d.weekday}</b><span>${dateFmt(d.date, { day: "2-digit" })}.</span></div>
        <div class="day-sessions">${items.join("") || `<div class="rest">Ruhetag</div>`}${d.note ? `<div class="adjusted">↻ ${esc(d.note)}</div>` : ""}</div>
      </div>`;
    }).join("");
    $("#view-week").innerHTML = `
      <div class="card">
        <h3>${esc(wk.phase_label)}${wk.deload ? " · Entlastungswoche" : ""}</h3>
        <p class="hint">KW ${isoWeek(wk.start)} · ${dateFmt(wk.start, { day: "2-digit", month: "2-digit" })} – ${dateFmt(addDays(wk.start, 6), { day: "2-digit", month: "2-digit" })}</p>
        <div class="grid two">
          <div><div class="meter" role="img" aria-label="Laufumfang"><i style="width:${kmPct}%"></i></div>
            <div class="meter-row"><span>Laufen ${de(wk.actual.run_km)} km</span><span>von ${de(wk.planned_km)} km</span></div></div>
          <div><div class="meter" role="img" aria-label="Trainingsstunden"><i style="width:${hPct}%"></i></div>
            <div class="meter-row"><span>Training ${de(wk.actual.hours)} h</span><span>von ${de(wk.planned_h)} h${wk.actual.sail_h ? ` · ⛵ ${de(wk.actual.sail_h)} h` : ""}</span></div></div>
        </div>
      </div>
      <div class="section-title">Tage</div>
      <div class="card">${days}</div>
      ${DATA.last_week ? `<div class="section-title">Letzte Woche</div><div class="card"><div class="secondary" style="font-size:14px">
        ${DATA.last_week.compliance != null ? `Schlüsseleinheiten ${Math.round(DATA.last_week.compliance * 100)} % · ` : ""}Laufen ${de(DATA.last_week.done_km)} / ${de(DATA.last_week.planned_km)} km<br>
        <span class="muted">Anpassung: ${esc(DATA.last_week.reason)}</span></div></div>` : ""}`;
  }

  function renderPlan() {
    const weeks = DATA.plan;
    const rows = weeks.map((w, i) => {
      const tags = [
        w.deload ? `<span class="badge">Entlastung</span>` : "",
        w.reentry ? `<span class="badge">Wiedereinstieg</span>` : "",
        w.sailing_days ? `<span class="badge sail">⛵ ${w.sailing_days} T</span>` : "",
        w.race_week ? `<span class="badge key">Rennen</span>` : "",
      ].join("");
      const vol = w.actual ? `${de(w.actual.run_km, 0)} / ${de(w.run_km, 0)} km` : `${de(w.run_km, 0)} km`;
      return `<div class="week-row ${w.status === "current" ? "current" : ""}" data-i="${i}">
        <div class="wk"><b>W${w.index + 1}</b>${dateFmt(w.start, { day: "2-digit", month: "2-digit" })}</div>
        <div><div class="ph"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${PHASE_COLOR[w.phase]};margin-right:6px"></i>${esc(w.phase_label)}</div><div class="tags">${tags}</div></div>
        <div class="vol num">${vol}<div class="muted" style="font-size:12px">${de(w.hours)} h</div></div>
        <div class="week-detail hidden">${w.key_sessions.map((k) => `<div><b>${k.day}</b> ${esc(k.title)} – ${esc(k.detail)}${k.distance_km ? ` · ${de(k.distance_km)} km` : ""}</div>`).join("") || "<div>Keine Schlüsseleinheit</div>"}
          ${w.sailing.length ? `<div>⛵ ${esc(w.sailing.join(", "))}</div>` : ""}</div>
      </div>`;
    }).join("");

    const paces = DATA.paces.map((p) => `<tr><td>${esc(p.label)}</td><td class="r num">${p.now}</td><td class="r num muted">${p.goal}</td></tr>`).join("");
    const sailing = DATA.sailing.map((b) => `<tr><td>${esc(b.title)}${b.tentative ? ' <span class="badge opt">offen</span>' : ""}</td>
      <td class="r num">${dateFmt(b.start, { day: "2-digit", month: "2-digit" })}–${dateFmt(b.end, { day: "2-digit", month: "2-digit" })}</td></tr>`).join("");

    $("#view-plan").innerHTML = `
      <div class="card">
        <h3>Laufumfang pro Woche</h3>
        <p class="hint">Geplant vs. gelaufen – bis zum ${esc(DATA.goal.race)}</p>
        <div class="legend"><span><i class="box" style="background:var(--planned)"></i>Geplant</span><span><i class="box" style="background:var(--series-1)"></i>Gelaufen</span><span><i class="box" style="background:var(--sail);border-radius:50%"></i>Segeltage</span></div>
        <div class="chart" id="chart-plan"></div>
        <div class="phase-legend">${Object.entries({ reset: "Übergang", base1: "Grundlage 1", base2: "Grundlage 2", build: "Aufbau", specific: "HM-spezifisch", taper: "Taper" }).map(([k, v]) => `<span><i style="background:${PHASE_COLOR[k]}"></i>${v}</span>`).join("")}</div>
      </div>
      <div class="section-title">Wochen</div>
      <div class="card" id="week-list">${rows}</div>
      <div class="grid two" style="margin-top:12px">
        <div class="card"><h3>Trainingstempo</h3><p class="hint">Aus deinem aktuellen VDOT ${de(DATA.goal.vdot)} – rechts: Zielniveau</p>
          <table><thead><tr><th>Bereich</th><th class="r">Jetzt /km</th><th class="r">Ziel /km</th></tr></thead><tbody>${paces}</tbody></table></div>
        <div class="card"><h3>Segeln – hat Priorität</h3><p class="hint">Diese Tage sind geblockt, Schlüsseleinheiten werden verschoben</p>
          <table><tbody>${sailing}</tbody></table></div>
      </div>`;
    $("#week-list").addEventListener("click", (e) => {
      const row = e.target.closest(".week-row");
      if (row) row.querySelector(".week-detail").classList.toggle("hidden");
    });
    planChart($("#chart-plan"), weeks);
  }

  function renderAnalysis() {
    const paces = DATA.paces.map((p) => `<tr><td>${esc(p.label)}</td><td class="r num">${p.now}</td><td class="r num muted">${p.goal}</td></tr>`).join("");
    const m = DATA.metrics;
    $("#view-analysis").innerHTML = heroBand() + `
      <div class="grid two" style="margin-bottom:12px">
        <div class="card"><h3>Trainingstempo</h3><p class="hint">Aus deinem aktuellen VDOT ${de(DATA.goal.vdot)} – rechts dein Zielniveau</p>
          <table><thead><tr><th>Bereich</th><th class="r">Jetzt /km</th><th class="r">Ziel /km</th></tr></thead><tbody>${paces}</tbody></table></div>
        <div class="card"><h3>Leistungswerte</h3><p class="hint">Aus Garmin und deinem Training</p>
          <div class="perf-kv">
            <div><span>VO2max</span><b class="num">${m.vo2max ? de(m.vo2max) : "–"}</b></div>
            <div><span>Laktatschwelle</span><b class="num">${m.lt_pace ? `${Math.floor(m.lt_pace / 60)}:${String(m.lt_pace % 60).padStart(2, "0")} /km` : "–"}</b></div>
            <div><span>Schwellenpuls</span><b class="num">${m.lt_hr ?? "–"}${m.lt_hr ? " bpm" : ""}</b></div>
            <div><span>Fitness (CTL)</span><b class="num">${de(m.ctl, 0)}</b></div>
            <div><span>Ermüdung (ATL)</span><b class="num">${de(m.atl, 0)}</b></div>
            <div><span>Belastungsquote</span><b class="num">${m.acwr ?? "–"}</b></div>
          </div></div>
      </div>
      <div class="card">
        <h3>Fitness & Ermüdung</h3><p class="hint">Trainingsbelastung der letzten 120 Tage (Garmin Load)</p>
        <div class="legend"><span><i style="background:var(--series-1)"></i>Fitness (CTL)</span><span><i style="background:var(--series-2)"></i>Ermüdung (ATL)</span></div>
        <div class="chart" id="chart-pmc"></div>
      </div>
      <div class="card" style="margin-top:12px">
        <h3>Frische (TSB)</h3><p class="hint">Über 0 = erholt · unter −20 = hohe Ermüdung</p>
        <div class="chart" id="chart-tsb"></div>
      </div>
      <div class="grid two" style="margin-top:12px">
        <div class="card"><h3>Wochenumfang Laufen</h3><p class="hint">Letzte 12 Wochen, Strich = Plan</p>
          <div class="chart" id="chart-history"></div></div>
        <div class="card"><h3>HRV</h3><p class="hint">Nacht-Durchschnitt, Band = deine Baseline</p>
          <div class="chart" id="chart-hrv"></div></div>
      </div>
      <div class="card" style="margin-top:12px"><h3>Schlaf-Score</h3><p class="hint">Letzte 30 Nächte</p><div class="chart" id="chart-sleep"></div></div>
      <div class="section-title">Anpassungen des Coaches</div>
      <div class="card feed">${DATA.log.map((l) => `<div class="item"><div class="when">${new Date(l.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · ${esc(l.kind)}</div>${esc(l.text)}</div>`).join("") || '<div class="empty">Noch keine Anpassungen.</div>'}</div>`;

    const pmc = DATA.pmc;
    lineChart($("#chart-pmc"), pmc.map((p) => p.date), [
      { label: "Fitness", color: "var(--series-1)", values: pmc.map((p) => p.ctl) },
      { label: "Ermüdung", color: "var(--series-2)", values: pmc.map((p) => p.atl) },
    ], { extra: (i) => [["Frische", (pmc[i].tsb > 0 ? "+" : "") + de(pmc[i].tsb, 0)], ["Load", de(pmc[i].load, 0)]] });
    barChart($("#chart-tsb"), pmc.map((p) => p.date), pmc.map((p) => p.tsb), { diverging: true, height: 130, label: "Frische" });
    const h = DATA.history;
    barChart($("#chart-history"), h.map((x) => x.start), h.map((x) => x.run_km), {
      label: "Gelaufen", unit: "km", target: h.map((x) => x.planned_km), xFmt: (d) => "KW" + isoWeek(d), everyLabel: 3,
    });
    const wl = DATA.wellness;
    lineChart($("#chart-hrv"), wl.map((x) => x.date), [{ label: "HRV", color: "var(--series-1)", values: wl.map((x) => x.hrv ?? null) }],
      { band: wl.map((x) => [x.hrv_low ?? null, x.hrv_high ?? null]), unit: "ms", height: 200 });
    barChart($("#chart-sleep"), wl.map((x) => x.date), wl.map((x) => x.sleep_score ?? null), { label: "Schlaf", height: 150, max: 100 });
  }

  function renderLog() {
    const list = DATA.activities.map((a, i) => {
      const sp = SPORT[a.sport] || SPORT.other;
      const facts = [a.distance_km ? `${de(a.distance_km)} km` : null, a.duration, a.pace ? `${a.pace} /km` : null, a.avg_hr ? `Ø ${Math.round(a.avg_hr)} bpm` : null].filter(Boolean).join(" · ");
      return `<div class="act" data-i="${i}"><div class="sport-ico ${a.sport === "sail" ? "sail" : ""}" aria-hidden="true">${sp.icon}</div>
        <div style="min-width:0"><div class="t">${esc(a.name)}</div><div class="d">${new Date(a.start.replace(" ", "T")).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${esc(facts)}</div></div>
        <div>${a.score != null ? scoreBadge(a.score) : `<span class="state-ico">${esc(a.rating || "")}</span>`}</div></div>`;
    }).join("");
    $("#view-log").innerHTML = `<div class="card">${list || '<div class="empty">Noch keine Einheiten.</div>'}</div>`;
    $("#view-log").onclick = (e) => {
      const row = e.target.closest(".act");
      if (row) openActivity(DATA.activities[+row.dataset.i]);
    };
  }

  function openActivity(a) {
    const z = a.hr_zones_s;
    const total = z ? z.reduce((s, v) => s + (v || 0), 0) : 0;
    const zoneColors = ["var(--accent-soft)", "var(--series-1)", "var(--series-4)", "var(--series-2)", "var(--critical)"];
    const zones = total ? `<div class="zones" role="img" aria-label="Herzfrequenzzonen">${z.map((v, i) => `<i style="width:${(v / total) * 100}%;background:${zoneColors[i]}" title="Z${i + 1}"></i>`).join("")}</div>
      <div class="zone-legend">${z.map((v, i) => `<span>Z${i + 1} ${Math.round((v / total) * 100)}%</span>`).join("")}</div>` : "";
    openSheet(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
        <div><h2>${esc(a.headline || a.name)}</h2><div class="muted" style="font-size:13px">${esc(a.name)} · ${new Date(a.start.replace(" ", "T")).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}</div></div>
        ${scoreBadge(a.score)}</div>
      ${zones}
      <div class="md" style="margin-top:12px">${a.lines.map((l) => `<p>${md(l)}</p>`).join("")}</div>
      ${a.tips.length ? `<ul>${a.tips.map((t) => `<li>${md(t)}</li>`).join("")}</ul>` : ""}`);
  }

  function openSheet(html) {
    const back = document.createElement("div");
    back.className = "sheet-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.innerHTML = `<div class="grab"></div>${html}`;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const close = () => { back.remove(); sheet.remove(); document.removeEventListener("keydown", onKey); };
    back.onclick = close;
    sheet.querySelector(".grab").onclick = close;
    document.addEventListener("keydown", onKey);
    document.body.append(back, sheet);
  }

  // ------------------------------------------------------------------ charts (inline SVG)
  const NS = "http://www.w3.org/2000/svg";
  // Round axis bounds to a "nice" step so ticks read 0 / 20 / 40 …
  function niceScale(minV, maxV, count = 4) {
    const span = Math.max(1e-9, maxV - minV);
    const raw = span / count, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    const lo = Math.floor(minV / step) * step, hi = Math.ceil(maxV / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(+t.toFixed(6));
    return { lo, hi, ticks };
  }
  function frame(el, height) {
    const width = Math.max(280, el.clientWidth || 600);
    el.innerHTML = "";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    el.appendChild(svg);
    const tip = document.createElement("div");
    tip.className = "tooltip hidden";
    el.appendChild(tip);
    return { svg, tip, width, height };
  }
  const node = (svg, tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.appendChild(n);
    return n;
  };
  function yAxis(svg, pad, width, y, ticks, fmt = (v) => v) {
    const g = node(svg, "g", { class: "axis" });
    ticks.forEach((t) => {
      node(g, "line", { x1: pad.l, x2: width - pad.r, y1: y(t), y2: y(t), class: "gridline" });
      node(g, "text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }, fmt(t));
    });
  }
  function showTip(tip, x, y, title, rows) {
    tip.innerHTML = `<b>${esc(title)}</b>` + rows.map(([k, v, c]) => `<div class="row"><span>${c ? `<i class="sw" style="background:${c}"></i>` : ""}${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.remove("hidden");
  }
  function hover(el, svg, width, pad, n, xAt, onMove) {
    const overlay = node(svg, "rect", { x: pad.l, y: 0, width: width - pad.l - pad.r, height: "100%", fill: "transparent" });
    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const scale = width / box.width;
      const px = (ev.clientX - box.left) * scale;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(xAt(i) - px); if (d < bd) { bd = d; best = i; } }
      onMove(best, scale);
    };
    overlay.addEventListener("pointermove", move);
    overlay.addEventListener("pointerdown", move);
    el.addEventListener("pointerleave", () => onMove(-1));
  }
  const shortDate = (d) => dateFmt(d, { day: "2-digit", month: "2-digit" });

  function lineChart(el, dates, series, opts = {}) {
    const H = opts.height || 220, pad = { l: 34, r: 10, t: 10, b: 24 };
    const { svg, tip, width } = frame(el, H);
    const all = series.flatMap((s) => s.values).concat((opts.band || []).flat()).filter((v) => v != null);
    const sc = niceScale(opts.band ? Math.max(0, Math.min(...all) - 5) : 0, Math.max(...all, 1));
    const max = sc.hi, min = sc.lo;
    const x = (i) => pad.l + (i / Math.max(1, dates.length - 1)) * (width - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
    yAxis(svg, pad, width, y, sc.ticks, (v) => Math.round(v));
    const ax = node(svg, "g", { class: "axis" });
    const step = Math.max(1, Math.round(dates.length / 5));
    dates.forEach((d, i) => { if (i % step === 0) node(ax, "text", { x: x(i), y: H - 6, "text-anchor": "middle" }, shortDate(d)); });
    if (opts.band) {
      const pts = opts.band.map((b, i) => (b[0] != null && b[1] != null ? [x(i), y(b[0]), y(b[1])] : null)).filter(Boolean);
      if (pts.length > 1) node(svg, "path", { d: "M" + pts.map((p) => `${p[0]},${p[2]}`).join("L") + "L" + pts.reverse().map((p) => `${p[0]},${p[1]}`).join("L") + "Z", fill: "var(--series-1)", opacity: 0.1 });
    }
    series.forEach((s) => {
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i) + "," + y(v); pen = true; });
      node(svg, "path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
      const li = s.values.length - 1;
      if (s.values[li] != null) node(svg, "circle", { cx: x(li), cy: y(s.values[li]), r: 4, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2 });
    });
    const cross = node(svg, "line", { y1: pad.t, y2: H - pad.b, stroke: "var(--text-muted)", "stroke-width": 1, opacity: 0 });
    const dots = series.map((s) => node(svg, "circle", { r: 4, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 }));
    hover(el, svg, width, pad, dates.length, x, (i, scale) => {
      if (i < 0) { tip.classList.add("hidden"); cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); return; }
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 0.5);
      series.forEach((s, k) => { const v = s.values[i]; dots[k].setAttribute("opacity", v == null ? 0 : 1); if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); } });
      const rows = series.map((s) => [s.label, s.values[i] == null ? "–" : de(s.values[i], 0) + (opts.unit ? " " + opts.unit : ""), s.color]);
      const top = Math.min(...series.map((s) => (s.values[i] == null ? H : y(s.values[i]))));
      showTip(tip, x(i) / scale, top / scale, dateFmt(dates[i], { weekday: "short", day: "2-digit", month: "2-digit" }), rows.concat(opts.extra ? opts.extra(i) : []));
    });
  }

  function barChart(el, cats, values, opts = {}) {
    const H = opts.height || 200, pad = { l: 34, r: 10, t: 10, b: 24 };
    const { svg, tip, width } = frame(el, H);
    const vals = values.filter((v) => v != null).concat((opts.target || []).filter((v) => v != null));
    const sc = niceScale(opts.diverging ? Math.min(...vals, -1) : 0, opts.max || Math.max(...vals, 1));
    const hi = sc.hi, lo = sc.lo;
    const band = (width - pad.l - pad.r) / cats.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const x = (i) => pad.l + band * i + band / 2;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    yAxis(svg, pad, width, y, sc.ticks, (v) => Math.round(v));
    const ax = node(svg, "g", { class: "axis" });
    const every = opts.everyLabel || Math.max(1, Math.round(cats.length / 5));
    cats.forEach((c, i) => { if (i % every === 0) node(ax, "text", { x: x(i), y: H - 6, "text-anchor": "middle" }, opts.xFmt ? opts.xFmt(c) : shortDate(c)); });
    const r = Math.min(4, bw / 2);
    values.forEach((v, i) => {
      if (v == null || v === 0) return;
      const up = v > 0, y0 = y(0), y1 = y(v), h = Math.abs(y1 - y0);
      const color = opts.diverging ? (up ? "var(--series-1)" : "var(--series-2)") : "var(--series-1)";
      const left = x(i) - bw / 2, top = up ? y1 : y0, rr = Math.min(r, h);
      // Rounded data end, square at the baseline.
      const d = up
        ? `M${left},${y0}V${top + rr}Q${left},${top} ${left + rr},${top}H${left + bw - rr}Q${left + bw},${top} ${left + bw},${top + rr}V${y0}Z`
        : `M${left},${y0}V${y1 - rr}Q${left},${y1} ${left + rr},${y1}H${left + bw - rr}Q${left + bw},${y1} ${left + bw},${y1 - rr}V${y0}Z`;
      node(svg, "path", { d, fill: color });
    });
    if (opts.target) opts.target.forEach((t, i) => { if (t != null) node(svg, "line", { x1: x(i) - bw / 2 - 2, x2: x(i) + bw / 2 + 2, y1: y(t), y2: y(t), stroke: "var(--text-primary)", "stroke-width": 2, "stroke-linecap": "round" }); });
    if (opts.diverging) node(svg, "line", { x1: pad.l, x2: width - pad.r, y1: y(0), y2: y(0), stroke: "var(--text-muted)", "stroke-width": 1 });
    const hl = node(svg, "rect", { width: band, y: pad.t, height: H - pad.t - pad.b, fill: "var(--text-primary)", opacity: 0 });
    hover(el, svg, width, pad, cats.length, x, (i, scale) => {
      if (i < 0) { tip.classList.add("hidden"); hl.setAttribute("opacity", 0); return; }
      hl.setAttribute("x", x(i) - band / 2); hl.setAttribute("opacity", 0.05);
      const rows = [[opts.label || "Wert", values[i] == null ? "–" : de(values[i], opts.unit === "km" ? 1 : 0) + (opts.unit ? " " + opts.unit : "")]];
      if (opts.target && opts.target[i] != null) rows.push(["Plan", de(opts.target[i], 1) + " km"]);
      showTip(tip, x(i) / scale, y(Math.max(values[i] ?? 0, opts.target?.[i] ?? 0, 0)) / scale, opts.xFmt ? opts.xFmt(cats[i]) + " · " + shortDate(cats[i]) : dateFmt(cats[i], { weekday: "short", day: "2-digit", month: "2-digit" }), rows);
    });
  }

  function planChart(el, weeks) {
    const H = 230, pad = { l: 34, r: 10, t: 22, b: 24 };
    const { svg, tip, width } = frame(el, H);
    const sc = niceScale(0, Math.max(...weeks.map((w) => Math.max(w.run_km, w.actual?.run_km || 0))) + 6);
    const max = sc.hi;
    const band = (width - pad.l - pad.r) / weeks.length;
    const bw = Math.max(3, Math.min(24, band - 2));
    const x = (i) => pad.l + band * i + band / 2;
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    yAxis(svg, pad, width, y, sc.ticks, (v) => Math.round(v));
    const ax = node(svg, "g", { class: "axis" });
    weeks.forEach((w, i) => { if ((i % 4 === 0 && i < weeks.length - 2) || w.race_week) node(ax, "text", { x: x(i), y: H - 6, "text-anchor": "middle" }, w.race_week ? "🏁" : shortDate(w.start)); });
    const bar = (i, v, fill, inset = 0) => {
      if (!v) return;
      const left = x(i) - bw / 2 + inset, w = bw - inset * 2, top = y(v), base = y(0), rr = Math.min(4, w / 2, base - top);
      node(svg, "path", { d: `M${left},${base}V${top + rr}Q${left},${top} ${left + rr},${top}H${left + w - rr}Q${left + w},${top} ${left + w},${top + rr}V${base}Z`, fill });
    };
    weeks.forEach((w, i) => {
      node(svg, "rect", { x: x(i) - band / 2 + 1, y: 4, width: band - 2, height: 4, rx: 2, fill: PHASE_COLOR[w.phase], opacity: 0.85 });
      bar(i, w.run_km, "var(--planned)");
      if (w.actual) bar(i, w.actual.run_km, "var(--series-1)", Math.min(3, bw / 5));
      if (w.sailing_days) node(svg, "circle", { cx: x(i), cy: y(w.run_km) - 8, r: 4, fill: "var(--sail)", stroke: "var(--surface-1)", "stroke-width": 2 });
      if (w.status === "current") node(svg, "text", { x: x(i), y: y(0) + 14, "text-anchor": "middle", fill: "var(--accent)", "font-size": 11, "font-weight": 700 }, "▲");
    });
    const hl = node(svg, "rect", { width: band, y: pad.t, height: H - pad.t - pad.b, fill: "var(--text-primary)", opacity: 0 });
    hover(el, svg, width, pad, weeks.length, x, (i, scale) => {
      if (i < 0) { tip.classList.add("hidden"); hl.setAttribute("opacity", 0); return; }
      const w = weeks[i];
      hl.setAttribute("x", x(i) - band / 2); hl.setAttribute("opacity", 0.05);
      const rows = [["Phase", w.phase_label + (w.deload ? " (Entl.)" : "")], ["Geplant", de(w.run_km) + " km"]];
      if (w.actual) rows.push(["Gelaufen", de(w.actual.run_km) + " km", "var(--series-1)"]);
      rows.push(["Training", de(w.hours) + " h"]);
      if (w.sailing_days) rows.push(["Segeln", w.sailing_days + " Tage", "var(--sail)"]);
      showTip(tip, x(i) / scale, y(Math.max(w.run_km, w.actual?.run_km || 0)) / scale, `Woche ${w.index + 1} · ${shortDate(w.start)}`, rows);
    });
  }

  // ------------------------------------------------------------------ helpers & shell
  function addDays(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function isoWeek(iso) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const w1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  }

  let current = store.get("coach-tab") || "today";
  const renderers = { today: renderToday, week: renderWeek, plan: renderPlan, analysis: renderAnalysis, log: renderLog };

  function show(view) {
    current = view;
    store.set("coach-tab", view);
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    renderers[view]();
    window.scrollTo({ top: 0 });
  }

  function render() {
    const g = DATA.goal;
    $("#title").textContent = "HM Coach";
    $("#subtitle").textContent = g.week_no
      ? `${DATA.week.phase_label} · Woche ${g.week_no} von ${g.weeks_total}`
      : `Plan startet am ${dateFmt(g.plan_start, { day: "2-digit", month: "2-digit" })}`;
    $("#countdown-chip").textContent = `🏁 ${g.days_to_go} Tage`;
    show(current in renderers ? current : "today");
  }

  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) show(b.dataset.view);
  });
  $("#refresh").addEventListener("click", () => boot());
  $("#lock-form").addEventListener("submit", (e) => {
    e.preventDefault();
    $("#lock-error").textContent = "";
    boot($("#pass").value, $("#remember").checked);
  });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => DATA && renderers[current](), 150); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DATA) boot(); });

  if ("serviceWorker" in navigator && location.protocol === "https:" && !window.__COACH_DEMO__) navigator.serviceWorker.register("sw.js").catch(() => {});
  boot();
})();
