/* Weekend Planner – vanilla JS, no build step. */
(() => {
'use strict';

/* ============================ constants ============================ */
const CATEGORIES = {
  work:     { label: 'Work',       color: 'var(--cat-work)' },
  sports:   { label: 'Sports',     color: 'var(--cat-sports)' },
  meal:     { label: 'Meal',       color: 'var(--cat-meal)' },
  activity: { label: 'Activity',   color: 'var(--cat-activity)' },
  errand:   { label: 'Errand',     color: 'var(--cat-errand)' },
  travel:   { label: 'Travel',     color: 'var(--cat-travel)' },
  info:     { label: 'Info',       color: 'var(--cat-info)' },
  other:    { label: 'Other',      color: 'var(--cat-other)' },
};
const MEAL_WINDOWS = {
  breakfast: [6 * 60 + 30, 10 * 60 + 30],
  lunch:     [11 * 60,     14 * 60],
  dinner:    [17 * 60,     21 * 60],
};
const MEAL_DEFAULT_MIN = { breakfast: 45, lunch: 60, dinner: 75 };
const MIN_FREE_WINDOW = 30;   // minutes
const SNAP = 15;              // minutes
const STORAGE_KEY = 'weekend-planner.plan';
const THEME_KEY = 'weekend-planner.theme';
const API_CANDIDATES = ['api/plan', 'api.php'];

/* ============================ state ============================ */
let plan = null;
let history = [];
let storageMode = 'none';   // 'server' | 'local'
let apiUrl = null;
let saveTimer = null;
let view = 'grid';
let dayDialogResolve = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ============================ time helpers ============================ */
const pad = (n) => String(n).padStart(2, '0');
const toMin = (hhmm) => { const [h, m] = (hhmm || '00:00').split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const fmt12 = (hhmm) => {
  const m = toMin(hhmm);
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return mm ? `${h12}:${pad(mm)}${ap}` : `${h12}${ap}`;
};
const fmtRange = (s, e) => `${fmt12(s)}–${fmt12(e)}`;
const fmtDur = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};
function dateAdd(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayName(iso, long = false) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: long ? 'long' : 'short' });
}
function dayLabel(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
const uid = (p = 'ev') => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const snap = (m) => Math.round(m / SNAP) * SNAP;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function days() {
  const out = [];
  for (let i = 0; i < plan.meta.dayCount; i++) out.push(dateAdd(plan.meta.startDate, i));
  return out;
}
const personById = (id) => plan.meta.people.find((p) => p.id === id);

/* ============================ storage ============================ */
async function tryFetchJson(url, opts) {
  try {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts));
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function loadPlan() {
  for (const url of API_CANDIDATES) {
    const data = await tryFetchJson(url);
    if (data && Array.isArray(data.events)) {
      apiUrl = url; storageMode = 'server';
      return data;
    }
  }
  storageMode = 'local';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && Array.isArray(p.events)) return p; }
  } catch (e) { /* ignore */ }
  const seed = await tryFetchJson('data/plan.default.json');
  if (seed) return seed;
  throw new Error('Could not load plan from server, browser storage, or data/plan.default.json');
}

function persistNow() {
  const text = JSON.stringify(plan);
  try { localStorage.setItem(STORAGE_KEY, text); } catch (e) { /* quota */ }
  if (storageMode === 'server' && apiUrl) {
    setPill('saving');
    fetch(apiUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text })
      .then((r) => { if (!r.ok) throw new Error(r.status); setPill('server'); })
      .catch(() => { storageMode = 'local'; setPill('local'); toast('Server unreachable. Saving in this browser only.'); });
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 350);
}
function setPill(mode) {
  const el = $('#storagePill');
  el.className = 'storage-pill ' + (mode === 'saving' ? 'server saving' : mode);
  el.textContent = mode === 'server' ? '● Saved to server' : mode === 'saving' ? '● Saving…' : '● Browser only';
  el.title = mode === 'local'
    ? 'No server found. Your plan is saved in this browser’s localStorage. Run `node server.js` to save to disk.'
    : 'Saved to data/plan.json via the local server.';
}

/* ============================ history (undo) ============================ */
function pushHistory() {
  history.push(JSON.stringify(plan));
  if (history.length > 60) history.shift();
  $('#btnUndo').disabled = false;
}
function undo() {
  if (!history.length) return;
  plan = JSON.parse(history.pop());
  $('#btnUndo').disabled = history.length === 0;
  save(); renderAll(); toast('Undone');
}
/** Wrap a mutation: snapshot, mutate, save, re-render. */
function mutate(fn, opts = {}) {
  pushHistory();
  fn();
  save();
  if (!opts.silent) renderAll();
}

/* ============================ derived data ============================ */
function timedEvents(date) {
  return plan.events
    .filter((e) => e.date === date && !e.allDay)
    .sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));
}
function allDayEvents(date) {
  return plan.events.filter((e) => e.date === date && e.allDay);
}
function isBusy(e) { return !e.allDay && e.category !== 'info'; }

/** Busy intervals (minutes) for a date, including drive time before each event. */
function busyIntervals(date) {
  return timedEvents(date).filter(isBusy).map((e) => {
    const s = toMin(e.start) - (Number(e.travelMin) || 0);
    const en = toMin(e.end) + (Number(e.travelMin) || 0);
    return [s, en];
  }).sort((a, b) => a[0] - b[0]);
}
/** Free windows between dayStart and dayEnd. */
function freeWindows(date, lo = plan.meta.dayStartHour * 60, hi = plan.meta.dayEndHour * 60) {
  const out = [];
  let cursor = lo;
  for (const [s, e] of busyIntervals(date)) {
    if (s > cursor && s - cursor >= MIN_FREE_WINDOW) out.push([cursor, Math.min(s, hi)]);
    cursor = Math.max(cursor, e);
    if (cursor >= hi) break;
  }
  if (hi - cursor >= MIN_FREE_WINDOW) out.push([cursor, hi]);
  return out.filter(([s, e]) => e - s >= MIN_FREE_WINDOW && s < hi);
}
/** Overlaps between busy events that share a person. */
function conflicts() {
  const out = [];
  for (const date of days()) {
    const evs = timedEvents(date).filter(isBusy);
    for (let i = 0; i < evs.length; i++) for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i], b = evs[j];
      const shared = (a.who || []).filter((w) => (b.who || []).includes(w));
      if (!shared.length) continue;
      const s = Math.max(toMin(a.start), toMin(b.start)), e = Math.min(toMin(a.end), toMin(b.end));
      if (e > s) out.push({ date, a, b, overlap: e - s, who: shared });
    }
  }
  return out;
}
function nextEvent() {
  const today = todayIso(), nm = nowMin();
  const list = plan.events.filter((e) => !e.allDay && e.category !== 'info')
    .map((e) => ({ e, key: e.date + 'T' + e.start }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return list.find(({ e }) => e.date > today || (e.date === today && toMin(e.end) > nm))?.e || null;
}
function openQuestionCount() {
  return plan.questions.filter((q) => !q.resolved).length + plan.events.filter((e) => e.status === 'needs-confirm').length;
}

/* ============================ render: chrome ============================ */
function renderHeader() {
  $('#planTitle').textContent = plan.meta.title;
  $('#planSubtitle').textContent = plan.meta.subtitle || '';
  document.title = plan.meta.title + ' · Weekend Planner';
  document.documentElement.style.setProperty('--days', plan.meta.dayCount);
  const n = openQuestionCount();
  $('#openCount').textContent = n ? String(n) : '';
}
function renderLegend() {
  const el = $('#legend');
  el.innerHTML = Object.entries(CATEGORIES).map(([k, c]) =>
    `<span><span class="dot" style="background:${c.color}"></span>${c.label}</span>`).join('') +
    plan.meta.people.map((p) => `<span><span class="dot" style="background:${p.color};border-radius:50%"></span>${p.name}</span>`).join('');
}
function renderNextUp() {
  const el = $('#nextUp');
  const ev = nextEvent();
  const conf = conflicts();
  const unresolved = openQuestionCount();
  const parts = [];
  if (ev) {
    const leave = ev.travelMin ? ` · leave by ${fmt12(fromMin(toMin(ev.start) - ev.travelMin))}` : '';
    parts.push(`<div><span class="k">Next up</span><span class="v">${esc(ev.title)}</span> <span>${dayName(ev.date)} ${fmtRange(ev.start, ev.end)}${ev.location ? ' · ' + esc(ev.location) : ''}${leave}</span></div>`);
  } else {
    parts.push(`<div><span class="k">Next up</span><span class="v">Nothing scheduled ahead</span></div>`);
  }
  const totalFree = days().reduce((sum, d) => sum + freeWindows(d).reduce((s, [a, b]) => s + (b - a), 0), 0);
  parts.push(`<div><span class="k">Open time (${plan.meta.dayStartHour}am–${plan.meta.dayEndHour - 12}pm)</span><span class="v">${fmtDur(totalFree)}</span> across ${plan.meta.dayCount} days</div>`);
  parts.push(`<div><span class="k">To confirm</span><span class="v ${unresolved ? 'warn' : ''}">${unresolved ? unresolved + ' open item' + (unresolved > 1 ? 's' : '') : 'All clear'}</span></div>`);
  if (conf.length) parts.push(`<div><span class="k">Conflicts</span><span class="v warn">${conf.length} overlap${conf.length > 1 ? 's' : ''}</span></div>`);
  el.innerHTML = parts.join('');
}
function renderConflicts() {
  const el = $('#conflicts');
  const conf = conflicts();
  el.innerHTML = conf.map((c) =>
    `<div>⚠ ${dayName(c.date)}: <b>${esc(c.a.title)}</b> overlaps <b>${esc(c.b.title)}</b> by ${fmtDur(c.overlap)} (${c.who.map((w) => personById(w)?.name || w).join(', ')})</div>`
  ).join('');
}

/* ============================ render: schedule grid ============================ */
function catColor(cat) { return (CATEGORIES[cat] || CATEGORIES.other).color; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderGrid() {
  const grid = $('#scheduleGrid');
  const showFree = $('#showFree').checked;
  const showWork = $('#showWork').checked;
  const startH = plan.meta.dayStartHour, endH = plan.meta.dayEndHour;
  const hourH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour-h')) || 56;
  const pxPerMin = hourH / 60;
  const today = todayIso();
  const conflictIds = new Set(conflicts().flatMap((c) => [c.a.id, c.b.id]));
  const ds = days();

  let html = `<div class="corner"></div>`;
  for (const d of ds) html += `<div class="day-head ${d === today ? 'today' : ''}"><div class="dname">${dayName(d, true)}</div><div class="ddate">${dayLabel(d)}</div></div>`;

  // all-day row
  html += `<div class="allday-row"><div class="lbl">All day</div>`;
  for (const d of ds) {
    html += `<div class="allday-cell">` + allDayEvents(d).filter((e) => showWork || e.category !== 'work').map((e) =>
      `<div class="allday-chip ${e.status}" style="--cat:${catColor(e.category)}" data-id="${e.id}" title="${esc(e.title)}">${esc(e.title)}</div>`).join('') + `</div>`;
  }
  html += `</div>`;

  // time column
  html += `<div class="time-col">`;
  for (let h = startH; h < endH; h++) html += `<div class="hr">${fmt12(fromMin(h * 60))}</div>`;
  html += `</div>`;

  // day columns
  for (const d of ds) {
    const colH = (endH - startH) * hourH;
    html += `<div class="day-col ${d === today ? 'today' : ''}" data-date="${d}" style="height:${colH}px">`;
    if (showFree) {
      for (const [s, e] of freeWindows(d)) {
        const top = (s - startH * 60) * pxPerMin, h = (e - s) * pxPerMin;
        html += `<div class="free" style="top:${top}px;height:${h}px" data-date="${d}" data-start="${s}" data-end="${e}" title="Add something here"><span class="plus">+</span> open ${fmtDur(e - s)}<br>${fmtRange(fromMin(s), fromMin(e))}</div>`;
      }
    }
    const evs = timedEvents(d).filter((e) => showWork || e.category !== 'work');
    const cols = layoutColumns(evs);
    for (const e of evs) {
      const s = clamp(toMin(e.start), startH * 60, endH * 60), en = clamp(toMin(e.end), startH * 60, endH * 60);
      if (en <= s) continue;
      const top = (s - startH * 60) * pxPerMin, h = Math.max(18, (en - s) * pxPerMin);
      const lay = cols.get(e.id);
      const width = 100 / lay.total, left = lay.col * width;
      const leave = e.travelMin ? `<span class="leave">leave ${fmt12(fromMin(toMin(e.start) - e.travelMin))}</span>` : '';
      const who = (e.who || []).map((w) => `<span style="background:${personById(w)?.color || '#999'}" title="${esc(personById(w)?.name || w)}"></span>`).join('');
      html += `<div class="ev ${e.status} ${conflictIds.has(e.id) ? 'conflict' : ''} ${en - s < 40 ? 'short' : ''}" data-id="${e.id}"
        style="top:${top}px;height:${h}px;left:calc(${left}% + 3px);right:auto;width:calc(${width}% - 6px);--cat:${catColor(e.category)}" title="${esc(e.title)}&#10;${fmtRange(e.start, e.end)}${e.location ? '&#10;' + esc(e.location) : ''}">
        <div class="who">${who}</div>
        <div class="t">${esc(e.title)}${e.status === 'needs-confirm' ? ' ?' : ''}</div>
        <div class="m">${fmtRange(e.start, e.end)}${e.location ? ` <span class="loc">${esc(e.location)}</span>` : ''} ${leave}</div>
        <div class="rs"></div></div>`;
    }
    if (d === today) {
      const nm = nowMin();
      if (nm >= startH * 60 && nm <= endH * 60) html += `<div class="now-line" style="top:${(nm - startH * 60) * pxPerMin}px"></div>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;
}

/** Assign side-by-side columns to overlapping events. */
function layoutColumns(evs) {
  const result = new Map();
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds = [];
    const assign = new Map();
    for (const e of cluster) {
      const s = toMin(e.start), en = toMin(e.end);
      let col = colEnds.findIndex((ce) => ce <= s);
      if (col === -1) { col = colEnds.length; colEnds.push(en); } else colEnds[col] = en;
      assign.set(e.id, col);
    }
    for (const e of cluster) result.set(e.id, { col: assign.get(e.id), total: colEnds.length });
    cluster = []; clusterEnd = -1;
  };
  for (const e of evs) {
    const s = toMin(e.start), en = toMin(e.end);
    if (cluster.length && s >= clusterEnd) flush();
    cluster.push(e); clusterEnd = Math.max(clusterEnd, en);
  }
  flush();
  return result;
}

/* ============================ render: schedule list ============================ */
function renderList() {
  const el = $('#scheduleList');
  const showFree = $('#showFree').checked;
  const showWork = $('#showWork').checked;
  const conflictIds = new Set(conflicts().flatMap((c) => [c.a.id, c.b.id]));
  el.innerHTML = days().map((d) => {
    const items = [];
    for (const e of allDayEvents(d).filter((e) => showWork || e.category !== 'work')) {
      items.push({ sort: -1, html: `<div class="list-ev ${e.status}" data-id="${e.id}" style="--cat:${catColor(e.category)}"><div class="time">all day</div><div><div class="t">${esc(e.title)}${statusBadge(e)}</div>${e.notes ? `<div class="m">${esc(e.notes)}</div>` : ''}</div></div>` });
    }
    for (const e of timedEvents(d).filter((e) => showWork || e.category !== 'work')) {
      const leave = e.travelMin ? ` · leave by ${fmt12(fromMin(toMin(e.start) - e.travelMin))}` : '';
      items.push({ sort: toMin(e.start), html: `<div class="list-ev ${e.status}" data-id="${e.id}" style="--cat:${catColor(e.category)}"><div class="time">${fmt12(e.start)}<br><small>${fmt12(e.end)}</small></div><div><div class="t">${esc(e.title)}${statusBadge(e)}${conflictIds.has(e.id) ? '<span class="badge">overlap</span>' : ''}</div><div class="m">${e.location ? '📍 ' + esc(e.location) : ''}${leave}${e.notes ? '<br>' + esc(e.notes) : ''}</div></div></div>` });
    }
    if (showFree) for (const [s, e] of freeWindows(d)) {
      items.push({ sort: s + 0.5, html: `<div class="list-free" data-date="${d}" data-start="${s}" data-end="${e}"><div>${fmt12(fromMin(s))}</div><div>+ open ${fmtDur(e - s)} until ${fmt12(fromMin(e))}</div></div>` });
    }
    items.sort((a, b) => a.sort - b.sort);
    return `<div class="list-day"><h3>${dayName(d, true)}<small>${dayLabel(d)}</small></h3>${items.map((i) => i.html).join('') || '<div class="hint">Nothing scheduled.</div>'}</div>`;
  }).join('');
}
function statusBadge(e) {
  if (e.status === 'needs-confirm') return '<span class="badge">confirm</span>';
  if (e.status === 'tentative') return '<span class="badge">tentative</span>';
  return '';
}

/* ============================ render: meals ============================ */
function mealEventId(date, meal) { return `meal-${date}-${meal}`; }
function mealWindow(date, meal) {
  const [lo, hi] = MEAL_WINDOWS[meal];
  // ignore this meal's own scheduled event when computing the window
  const own = plan.events.find((e) => e.id === mealEventId(date, meal));
  const saved = own ? plan.events.splice(plan.events.indexOf(own), 1) : null;
  const wins = freeWindows(date, lo, hi).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  if (saved) plan.events.push(saved[0]);
  return wins;
}
function renderMeals() {
  const el = $('#mealsGrid');
  const ds = days();
  let html = `<div></div>` + ds.map((d) => `<div class="mh">${dayName(d, true)}<small>${dayLabel(d)}</small></div>`).join('');
  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    html += `<div class="ml">${meal}</div>`;
    for (const d of ds) {
      const m = (plan.meals[d] && plan.meals[d][meal]) || { plan: '', where: '', time: '', note: '' };
      const wins = mealWindow(d, meal);
      const need = MEAL_DEFAULT_MIN[meal];
      let winHtml;
      if (!wins.length) winHtml = `<div class="win tight">No open window in the usual ${meal} hours</div>`;
      else {
        const [s, e] = wins[0];
        winHtml = `<div class="win ${e - s < need ? 'tight' : ''}">Open ${fmtRange(fromMin(s), fromMin(e))}${wins.length > 1 ? ` (+${wins.length - 1} more)` : ''}</div>`;
      }
      const ev = plan.events.find((x) => x.id === mealEventId(d, meal));
      const sched = ev ? `<div class="scheduled" data-id="${ev.id}">On schedule: ${fmtRange(ev.start, ev.end)}${ev.location ? ' · ' + esc(ev.location) : ''} ✎</div>` : '';
      html += `<div class="meal" data-date="${d}" data-meal="${meal}">
        ${winHtml}
        <input type="text" class="m-plan" placeholder="What are we eating?" value="${esc(m.plan)}">
        <div class="row2"><input type="text" class="m-where" placeholder="Where" value="${esc(m.where)}"><input type="time" class="m-time" value="${esc(m.time)}" title="Time"></div>
        ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
        ${sched}
        <button class="btn sm m-sched">${ev ? 'Update on schedule' : 'Put on schedule'}</button>
      </div>`;
    }
  }
  el.innerHTML = html;
}
function scheduleMeal(date, meal) {
  const m = plan.meals[date][meal];
  const id = mealEventId(date, meal);
  const existing = plan.events.find((e) => e.id === id);
  let start;
  if (m.time) start = toMin(m.time);
  else if (existing) start = toMin(existing.start);
  else {
    const wins = mealWindow(date, meal);
    if (!wins.length) { toast(`No open ${meal} window on ${dayName(date)}. Set a time manually.`); return; }
    start = Math.ceil(wins[0][0] / SNAP) * SNAP;
    if (start >= wins[0][1]) start = wins[0][0];
  }
  const dur = existing ? toMin(existing.end) - toMin(existing.start) : MEAL_DEFAULT_MIN[meal];
  const title = `${meal[0].toUpperCase() + meal.slice(1)}${m.plan ? ': ' + m.plan : ''}`;
  mutate(() => {
    if (existing) Object.assign(existing, { title, start: fromMin(start), end: fromMin(start + dur), location: m.where || existing.location });
    else plan.events.push({ id, date, allDay: false, start: fromMin(start), end: fromMin(start + dur), title, location: m.where || '', who: plan.meta.people.map((p) => p.id), category: 'meal', status: 'tentative', travelMin: 0, notes: '' });
    m.time = fromMin(start);
  });
  toast(`${title} on ${dayName(date)} at ${fmt12(fromMin(start))}`);
}

/* ============================ render: open items ============================ */
function renderOpen() {
  const ql = $('#questionList');
  const evQs = plan.events.filter((e) => e.status === 'needs-confirm').map((e) =>
    `<li class="ev-q"><input type="checkbox" disabled title="Set the event's status to Confirmed to clear this"><div><div class="q">Confirm: ${esc(e.title)} <span class="badge">${dayName(e.date)}${e.allDay ? '' : ' ' + fmt12(e.start)}</span></div>${e.notes ? `<div class="hint" style="margin:0">${esc(e.notes)}</div>` : ''}<div class="link" data-id="${e.id}">Open event ✎</div></div><button class="btn sm confirm-ev" data-id="${e.id}">Mark confirmed</button></li>`);
  const qs = plan.questions.map((q) =>
    `<li class="${q.resolved ? 'resolved' : ''}" data-qid="${q.id}"><input type="checkbox" class="q-done" ${q.resolved ? 'checked' : ''}><div><div class="q">${esc(q.text)}</div><div class="answer"><input type="text" class="q-answer" placeholder="Answer / outcome" value="${esc(q.answer)}"></div>${q.linkedEvent && plan.events.find((e) => e.id === q.linkedEvent) ? `<div class="link" data-id="${q.linkedEvent}">Open related event ✎</div>` : ''}</div><button class="icon-btn q-del" title="Delete">✕</button></li>`);
  ql.innerHTML = qs.concat(evQs).join('') || '<li class="hint">Nothing to confirm.</li>';

  const groups = {};
  for (const c of plan.checklist) (groups[c.group || 'General'] ||= []).push(c);
  $('#checklist').innerHTML = Object.entries(groups).map(([g, items]) =>
    `<div class="check-group"><h4>${esc(g)} <small>${items.filter((i) => i.done).length}/${items.length}</small></h4>${items.map((c) =>
      `<div class="check-item ${c.done ? 'done' : ''}" data-cid="${c.id}"><input type="checkbox" class="c-done" ${c.done ? 'checked' : ''}><span>${esc(c.text)}</span><button class="icon-btn c-del" title="Delete">✕</button></div>`).join('')}</div>`).join('');
  $('#groupList').innerHTML = Object.keys(groups).map((g) => `<option value="${esc(g)}">`).join('');
}

/* ============================ render: ideas & notes ============================ */
function renderIdeas() {
  $('#ideaList').innerHTML = plan.ideas.map((i) =>
    `<div class="idea" data-iid="${i.id}" style="--cat:${catColor(i.category)}"><div class="t">${esc(i.title)}</div><div class="m">${fmtDur(i.duration || 60)}${i.location ? ' · 📍 ' + esc(i.location) : ''}</div>${i.notes ? `<div class="m">${esc(i.notes)}</div>` : ''}<div class="acts"><button class="btn sm primary i-sched">Schedule</button><div class="spacer"></div><button class="icon-btn i-del" title="Remove idea">✕</button></div></div>`
  ).join('') || '<div class="hint">No ideas yet.</div>';
}
function renderNotes() { $('#notesArea').value = plan.notes || ''; }

function renderAll() {
  renderHeader(); renderLegend(); renderNextUp(); renderConflicts();
  if (view === 'grid') renderGrid(); else renderList();
  $('#scheduleGrid').hidden = view !== 'grid';
  $('#scheduleList').hidden = view !== 'list';
  renderMeals(); renderOpen(); renderIdeas(); renderNotes();
}

/* ============================ event dialog ============================ */
const dlg = $('#eventDialog');
let editingNew = false;

function fillDialogStatic() {
  $('#evDate').innerHTML = days().map((d) => `<option value="${d}">${dayName(d, true)} ${dayLabel(d)}</option>`).join('');
  $('#evCategory').innerHTML = Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
  $('#evWho').innerHTML = plan.meta.people.map((p) => `<label><input type="checkbox" value="${p.id}"> <span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color}"></span> ${esc(p.name)}</label>`).join('');
  const locs = [...new Set(plan.events.map((e) => e.location).concat(plan.ideas.map((i) => i.location)).filter(Boolean))];
  $('#locationList').innerHTML = locs.map((l) => `<option value="${esc(l)}">`).join('');
}
function openEventDialog(ev, isNew = false) {
  fillDialogStatic();
  editingNew = isNew;
  $('#eventDialogTitle').textContent = isNew ? 'New event' : 'Edit event';
  $('#evId').value = ev.id;
  $('#evTitle').value = ev.title || '';
  $('#evDate').value = ev.date;
  $('#evAllDay').checked = !!ev.allDay;
  $('#evStart').value = ev.start || '09:00';
  $('#evEnd').value = ev.end || '10:00';
  $('#evLocation').value = ev.location || '';
  $('#evTravel').value = ev.travelMin || 0;
  $('#evCategory').value = CATEGORIES[ev.category] ? ev.category : 'other';
  $('#evStatus').value = ev.status || 'confirmed';
  $('#evNotes').value = ev.notes || '';
  $$('#evWho input').forEach((cb) => { cb.checked = (ev.who || []).includes(cb.value); });
  $('#btnDeleteEvent').style.visibility = isNew ? 'hidden' : 'visible';
  $('#btnDuplicateEvent').style.visibility = isNew ? 'hidden' : 'visible';
  syncDialogDerived();
  dlg.showModal();
  $('#evTitle').focus();
}
function readDialog() {
  const allDay = $('#evAllDay').checked;
  return {
    id: $('#evId').value,
    title: $('#evTitle').value.trim(),
    date: $('#evDate').value,
    allDay,
    start: allDay ? '00:00' : $('#evStart').value,
    end: allDay ? '23:59' : $('#evEnd').value,
    location: $('#evLocation').value.trim(),
    travelMin: Number($('#evTravel').value) || 0,
    category: $('#evCategory').value,
    status: $('#evStatus').value,
    notes: $('#evNotes').value,
    who: $$('#evWho input:checked').map((cb) => cb.value),
  };
}
function syncDialogDerived() {
  const d = readDialog();
  $('#evTimesRow').style.display = d.allDay ? 'none' : '';
  $('#evLeaveBy').textContent = (!d.allDay && d.travelMin > 0) ? `Leave by ${fmt12(fromMin(toMin(d.start) - d.travelMin))}` : '';
  const warn = [];
  if (!d.allDay && toMin(d.end) <= toMin(d.start)) warn.push('End time must be after start time.');
  if (!d.allDay && d.category !== 'info') {
    for (const other of timedEvents(d.date)) {
      if (other.id === d.id || !isBusy(other)) continue;
      const shared = (other.who || []).some((w) => d.who.includes(w));
      if (shared && toMin(other.start) < toMin(d.end) && toMin(other.end) > toMin(d.start)) warn.push(`Overlaps “${other.title}” (${fmtRange(other.start, other.end)}).`);
    }
  }
  $('#evWarn').textContent = warn.join(' ');
}
function saveDialog() {
  const d = readDialog();
  if (!d.title) { $('#evTitle').focus(); return; }
  if (!d.allDay && toMin(d.end) <= toMin(d.start)) { toast('End must be after start'); return; }
  mutate(() => {
    const existing = plan.events.find((e) => e.id === d.id);
    if (existing) Object.assign(existing, d); else plan.events.push(d);
  });
  dlg.close();
  toast(editingNew ? 'Event added' : 'Saved');
}
function newEventAt(date, startMin, endMin, extra = {}) {
  const s = startMin ?? 9 * 60;
  const e = endMin ?? Math.min(s + 60, plan.meta.dayEndHour * 60);
  openEventDialog(Object.assign({
    id: uid(), date, allDay: false, start: fromMin(s), end: fromMin(e), title: '', location: '',
    who: plan.meta.people.map((p) => p.id), category: 'activity', status: 'tentative', travelMin: 0, notes: '',
  }, extra), true);
}

/* ============================ day picker (ideas) ============================ */
function pickDay() {
  return new Promise((resolve) => {
    dayDialogResolve = resolve;
    $('#dayChoices').innerHTML = days().map((d) => {
      const w = freeWindows(d);
      const total = w.reduce((s, [a, b]) => s + (b - a), 0);
      return `<button class="btn" data-date="${d}">${dayName(d, true)} ${dayLabel(d)}<small>${total ? fmtDur(total) + ' open' : 'no open windows'}</small></button>`;
    }).join('');
    $('#dayDialog').showModal();
  });
}
function scheduleIdea(idea) {
  pickDay().then((date) => {
    if (!date) return;
    const dur = idea.duration || 60;
    const wins = freeWindows(date);
    let win = wins.find(([s, e]) => e - s >= dur) || wins.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    let s, e;
    if (win) { s = Math.ceil(win[0] / SNAP) * SNAP; if (s >= win[1]) s = win[0]; e = Math.min(s + dur, win[1]); }
    else { s = 9 * 60; e = s + dur; toast('No open window found; pick a time.'); }
    newEventAt(date, s, e, { title: idea.title, location: idea.location || '', category: idea.category === 'meal' ? 'meal' : idea.category === 'errand' ? 'errand' : 'activity', notes: idea.notes || '' });
  });
}

/* ============================ drag & resize ============================ */
function installDrag() {
  const grid = $('#scheduleGrid');
  let drag = null;
  grid.addEventListener('pointerdown', (e) => {
    const evEl = e.target.closest('.ev');
    if (!evEl || e.button !== 0) return;
    const ev = plan.events.find((x) => x.id === evEl.dataset.id);
    if (!ev) return;
    const hourH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour-h')) || 56;
    drag = {
      ev, el: evEl, mode: e.target.classList.contains('rs') ? 'resize' : 'move',
      startY: e.clientY, startX: e.clientX, pxPerMin: hourH / 60,
      origStart: toMin(ev.start), origEnd: toMin(ev.end), origDate: ev.date, moved: false,
      cols: $$('.day-col', grid).map((c) => ({ date: c.dataset.date, rect: c.getBoundingClientRect() })),
    };
    evEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4 && Math.abs(e.clientX - drag.startX) < 4) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    const dMin = snap(dy / drag.pxPerMin);
    const lo = plan.meta.dayStartHour * 60, hi = plan.meta.dayEndHour * 60;
    const dur = drag.origEnd - drag.origStart;
    if (drag.mode === 'move') {
      let s = clamp(drag.origStart + dMin, lo, hi - dur);
      drag.newStart = s; drag.newEnd = s + dur;
      const col = drag.cols.find((c) => e.clientX >= c.rect.left && e.clientX < c.rect.right);
      drag.newDate = col ? col.date : drag.origDate;
      if (drag.newDate !== drag.el.parentElement.dataset.date) {
        const target = $(`.day-col[data-date="${drag.newDate}"]`, grid);
        if (target) target.appendChild(drag.el);
      }
      drag.el.style.top = `${(s - lo) * drag.pxPerMin}px`;
    } else {
      const en = clamp(snap(drag.origEnd + dMin), drag.origStart + SNAP, hi);
      drag.newEnd = en;
      drag.el.style.height = `${(en - drag.origStart) * drag.pxPerMin}px`;
    }
    const m = $('.m', drag.el);
    if (m) m.firstChild.textContent = fmtRange(fromMin(drag.newStart ?? drag.origStart), fromMin(drag.newEnd)) + ' ';
  });
  const finish = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.classList.remove('dragging');
    if (!d.moved) { openEventDialog(d.ev); return; }
    const changed = (d.newStart !== undefined && d.newStart !== d.origStart) || (d.newEnd !== undefined && d.newEnd !== d.origEnd) || (d.newDate && d.newDate !== d.origDate);
    if (!changed) { renderAll(); return; }
    mutate(() => {
      if (d.newStart !== undefined) d.ev.start = fromMin(d.newStart);
      if (d.newEnd !== undefined) d.ev.end = fromMin(d.newEnd);
      if (d.newDate) d.ev.date = d.newDate;
      // keep a scheduled meal's time in sync with the meal grid
      const mm = /^meal-(\d{4}-\d{2}-\d{2})-(\w+)$/.exec(d.ev.id);
      if (mm && plan.meals[mm[1]]?.[mm[2]]) plan.meals[mm[1]][mm[2]].time = d.ev.start;
    });
    toast(`${d.ev.title}: ${dayName(d.ev.date)} ${fmtRange(d.ev.start, d.ev.end)}`);
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);
}

/* ============================ misc UI ============================ */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}

/* ============================ wiring ============================ */
function wire() {
  // tabs
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'schedule') renderAll();
  });
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]'); if (!b) return;
    view = b.dataset.view;
    $$('#viewSeg button').forEach((x) => x.classList.toggle('active', x === b));
    renderAll();
  });
  $('#showFree').addEventListener('change', renderAll);
  $('#showWork').addEventListener('change', renderAll);

  // schedule clicks (grid chips, free windows, list items)
  const onScheduleClick = (e) => {
    const free = e.target.closest('.free, .list-free');
    if (free) { newEventAt(free.dataset.date, Number(free.dataset.start), Math.min(Number(free.dataset.start) + 60, Number(free.dataset.end))); return; }
    const chip = e.target.closest('.allday-chip, .list-ev');
    if (chip) { const ev = plan.events.find((x) => x.id === chip.dataset.id); if (ev) openEventDialog(ev); }
  };
  $('#scheduleGrid').addEventListener('click', onScheduleClick);
  $('#scheduleList').addEventListener('click', onScheduleClick);
  installDrag();

  // header buttons
  $('#btnAddEvent').addEventListener('click', () => {
    const today = todayIso();
    const d = days().includes(today) ? today : days()[0];
    const w = freeWindows(d)[0];
    newEventAt(d, w ? w[0] : 9 * 60, w ? Math.min(w[0] + 60, w[1]) : 10 * 60);
  });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnMore').addEventListener('click', (e) => { e.stopPropagation(); $('#moreMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('#moreMenu').classList.remove('open'));
  $('#btnExport').addEventListener('click', () => download(`weekend-plan-${plan.meta.startDate}.json`, JSON.stringify(plan, null, 2)));
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!p || !Array.isArray(p.events) || !p.meta) throw new Error('not a plan');
      mutate(() => { plan = p; });
      toast('Plan imported');
    } catch (err) { toast('Import failed: ' + err.message); }
    e.target.value = '';
  });
  $('#btnPrint').addEventListener('click', () => { const v = view; view = 'list'; renderAll(); setTimeout(() => { window.print(); view = v; renderAll(); }, 50); });
  $('#btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  });
  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('Reset the whole plan back to the original handoff? Your edits will be lost (Undo can restore them this session).')) return;
    const seed = await tryFetchJson('data/plan.default.json');
    if (!seed) { toast('Could not load the default plan'); return; }
    mutate(() => { plan = seed; });
    toast('Plan reset');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !dlg.open && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    if (e.key === 'n' && !dlg.open && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { $('#btnAddEvent').click(); }
  });

  // event dialog
  $('#eventForm').addEventListener('submit', (e) => { e.preventDefault(); saveDialog(); });
  $('#btnCancelEvent').addEventListener('click', () => dlg.close());
  $('#btnCloseDialog').addEventListener('click', () => dlg.close());
  $('#btnDeleteEvent').addEventListener('click', () => {
    const id = $('#evId').value;
    const ev = plan.events.find((e) => e.id === id);
    if (!ev || !confirm(`Delete “${ev.title}”?`)) return;
    mutate(() => { plan.events = plan.events.filter((e) => e.id !== id); });
    dlg.close(); toast('Deleted');
  });
  $('#btnDuplicateEvent').addEventListener('click', () => {
    const d = readDialog();
    d.id = uid(); d.title = d.title + ' (copy)';
    mutate(() => { plan.events.push(d); });
    dlg.close(); openEventDialog(d);
  });
  ['#evAllDay', '#evStart', '#evEnd', '#evTravel', '#evDate', '#evCategory'].forEach((s) => $(s).addEventListener('input', syncDialogDerived));
  $('#evWho').addEventListener('change', syncDialogDerived);
  $$('#eventForm [data-nudge]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.nudge);
    const s = toMin($('#evStart').value) + n, e = toMin($('#evEnd').value) + n;
    if (s < 0 || e > 24 * 60 - 1) return;
    $('#evStart').value = fromMin(s); $('#evEnd').value = fromMin(e);
    syncDialogDerived();
  }));
  $('#evStart').addEventListener('change', () => {
    // keep duration when start moves, if end is now before start
    const s = toMin($('#evStart').value), e = toMin($('#evEnd').value);
    if (e <= s) { $('#evEnd').value = fromMin(Math.min(s + 60, 23 * 60 + 59)); syncDialogDerived(); }
  });

  // day dialog
  $('#dayChoices').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-date]'); if (!b) return;
    $('#dayDialog').close(); dayDialogResolve?.(b.dataset.date); dayDialogResolve = null;
  });
  $('#btnCancelDay').addEventListener('click', () => { $('#dayDialog').close(); dayDialogResolve?.(null); dayDialogResolve = null; });

  // meals
  $('#mealsGrid').addEventListener('input', (e) => {
    const cell = e.target.closest('.meal'); if (!cell) return;
    const m = (plan.meals[cell.dataset.date] ||= {})[cell.dataset.meal] ||= { plan: '', where: '', time: '', note: '' };
    if (e.target.classList.contains('m-plan')) m.plan = e.target.value;
    if (e.target.classList.contains('m-where')) m.where = e.target.value;
    if (e.target.classList.contains('m-time')) m.time = e.target.value;
    save();
  });
  $('#mealsGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.meal'); if (!cell) return;
    if (e.target.classList.contains('m-sched')) scheduleMeal(cell.dataset.date, cell.dataset.meal);
    const s = e.target.closest('.scheduled');
    if (s) { const ev = plan.events.find((x) => x.id === s.dataset.id); if (ev) openEventDialog(ev); }
  });

  // questions
  $('#questionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#questionInput').value.trim(); if (!text) return;
    mutate(() => plan.questions.push({ id: uid('q'), text, resolved: false, answer: '' }));
    $('#questionInput').value = '';
  });
  $('#questionList').addEventListener('change', (e) => {
    const li = e.target.closest('li[data-qid]'); if (!li) return;
    const q = plan.questions.find((x) => x.id === li.dataset.qid); if (!q) return;
    if (e.target.classList.contains('q-done')) mutate(() => { q.resolved = e.target.checked; });
  });
  $('#questionList').addEventListener('input', (e) => {
    const li = e.target.closest('li[data-qid]'); if (!li) return;
    const q = plan.questions.find((x) => x.id === li.dataset.qid); if (!q) return;
    if (e.target.classList.contains('q-answer')) { q.answer = e.target.value; save(); }
  });
  $('#questionList').addEventListener('click', (e) => {
    const link = e.target.closest('.link');
    if (link) { const ev = plan.events.find((x) => x.id === link.dataset.id); if (ev) openEventDialog(ev); return; }
    const conf = e.target.closest('.confirm-ev');
    if (conf) { const ev = plan.events.find((x) => x.id === conf.dataset.id); if (ev) mutate(() => { ev.status = 'confirmed'; }); return; }
    const del = e.target.closest('.q-del');
    if (del) { const li = del.closest('li[data-qid]'); mutate(() => { plan.questions = plan.questions.filter((q) => q.id !== li.dataset.qid); }); }
  });

  // checklist
  $('#checkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#checkInput').value.trim(); if (!text) return;
    const group = $('#checkGroup').value.trim() || 'General';
    mutate(() => plan.checklist.push({ id: uid('c'), group, text, done: false }));
    $('#checkInput').value = '';
  });
  $('#checklist').addEventListener('change', (e) => {
    const item = e.target.closest('.check-item'); if (!item) return;
    const c = plan.checklist.find((x) => x.id === item.dataset.cid); if (!c) return;
    if (e.target.classList.contains('c-done')) mutate(() => { c.done = e.target.checked; });
  });
  $('#checklist').addEventListener('click', (e) => {
    const del = e.target.closest('.c-del'); if (!del) return;
    const item = del.closest('.check-item');
    mutate(() => { plan.checklist = plan.checklist.filter((c) => c.id !== item.dataset.cid); });
  });

  // ideas
  $('#ideaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#ideaTitle').value.trim(); if (!title) return;
    mutate(() => plan.ideas.push({ id: uid('i'), title, duration: Number($('#ideaDuration').value) || 60, category: 'activity', location: '', notes: '' }));
    $('#ideaTitle').value = '';
  });
  $('#ideaList').addEventListener('click', (e) => {
    const card = e.target.closest('.idea'); if (!card) return;
    const idea = plan.ideas.find((i) => i.id === card.dataset.iid); if (!idea) return;
    if (e.target.closest('.i-sched')) scheduleIdea(idea);
    if (e.target.closest('.i-del')) mutate(() => { plan.ideas = plan.ideas.filter((i) => i.id !== idea.id); });
  });

  // notes
  $('#notesArea').addEventListener('input', (e) => { plan.notes = e.target.value; save(); });

  // keep "now" line fresh
  setInterval(() => { if (view === 'grid' && $('#tab-schedule').classList.contains('active') && !dlg.open) { renderNextUp(); renderGrid(); } }, 60 * 1000);
  window.addEventListener('resize', () => { if (view === 'grid') renderGrid(); });
}

/* ============================ boot ============================ */
async function boot() {
  try { applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')); } catch (e) { /* ignore */ }
  try {
    plan = await loadPlan();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:system-ui"><h2>Could not load the plan</h2><p>${esc(err.message)}</p><p>Run <code>node server.js</code> in the weekend-planner folder and open <a href="http://localhost:4747">http://localhost:4747</a>, or serve this folder with any static web server.</p></div>`;
    return;
  }
  plan.meals ||= {}; plan.questions ||= []; plan.ideas ||= []; plan.checklist ||= []; plan.notes ||= '';
  for (const d of days()) { plan.meals[d] ||= {}; for (const m of ['breakfast', 'lunch', 'dinner']) plan.meals[d][m] ||= { plan: '', where: '', time: '', note: '' }; }
  setPill(storageMode);
  $('#btnUndo').disabled = true;
  wire();
  renderAll();
  if (storageMode === 'local') persistNow();
}
boot();

})();
