/* Trinium Flow dashboard: read-only UI over /api/* (see src/index.js). Plain JavaScript, no build step.
   Every value from the database or the logs goes through esc() before it reaches the DOM. */
(() => {
'use strict';

// ---------- helpers ----------
const main = document.getElementById('main');
const esc = v => (v === null || v === undefined) ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => (n ?? 0).toLocaleString();
const dateTime = t => t ? new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const timeOnly = t => t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const rel = t => {
  if (!t) return '—';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (Number.isNaN(s)) return '—';
  if (s < 0) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const TONE = {
  SENT: 'good', CREATED: 'good', UPDATED: 'good', WRITTEN: 'good', SENT_214: 'good', REACTIVATED: 'good', OK: 'good', ACTIVE: 'good', SENT_OK: 'good',
  CANCELLED: 'neutral', NOOP: 'neutral', SKIPPED: 'neutral', 'N/A': 'neutral', QUEUED: 'neutral', INFO: 'neutral', CHECKED: 'neutral',
  PENDING: 'warn', HELD: 'warn', STALE: 'warn', WARN: 'warn', WARNING: 'warn',
  FAILED: 'bad', ERROR: 'bad', REJECTED: 'bad', ABORTED: 'bad'
};
const tone = s => TONE[String(s ?? '').toUpperCase()] || 'neutral';
const badge = s => (s === null || s === undefined || s === '') ? '<span class="muted">—</span>' : `<span class="badge ${tone(s)}">${esc(s)}</span>`;
const flowTag = f => `<span class="flowtag ${f === 'B' ? 'B' : ''}" title="${f === 'B' ? 'Flow B: app to Trinium' : 'Flow A: Trinium to app'}">${esc(f)}</span>`;
const worst = issues => {
  const list = Array.isArray(issues) ? issues : [];
  if (list.some(i => i.level === 'error')) return 'error';
  if (list.some(i => i.level === 'warn')) return 'warn';
  return 'ok';
};
const isErr = r => worst(r.issues) === 'error' || ['ERROR', 'FAILED', 'REJECTED'].includes(String(r.outcome || '').toUpperCase());
const json = v => JSON.stringify(v ?? null, null, 2);

function kvs(obj, skip = []) {
  if (!obj || typeof obj !== 'object') return '<p class="muted">No data.</p>';
  const rows = Object.entries(obj).filter(([k]) => !skip.includes(k));
  if (!rows.length) return '<p class="muted">No data.</p>';
  return `<dl class="kvs">${rows.map(([k, v]) => {
    const shown = v === null || v === undefined || v === '' ? '<span class="muted">—</span>'
      : typeof v === 'object' ? `<span class="mono">${esc(JSON.stringify(v).slice(0, 240))}</span>` : esc(v);
    return `<dt>${esc(k)}</dt><dd>${shown}</dd>`;
  }).join('')}</dl>`;
}

function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return `<div class="empty">${esc(opts.empty || 'Nothing to show for this window.')}</div>`;
  const head = cols.map(c => `<th class="${c.num ? 'num' : ''} ${c.nowrap ? 'nowrap' : ''}">${esc(c.h)}</th>`).join('');
  const body = rows.map((r, i) => {
    const attrs = opts.rowAttr ? opts.rowAttr(r, i) : '';
    const cls = [opts.rowClass ? opts.rowClass(r) : '', attrs ? 'click' : ''].join(' ').trim();
    return `<tr class="${cls}" ${attrs}>${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.nowrap ? 'nowrap' : ''} ${c.wrap ? 'wrap' : ''}">${c.f(r)}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function kpi(label, value, sub, go, tn = 'neutral') {
  return `<a class="card kpi ${tn}" href="#/${go}" aria-label="${esc(label)}: ${esc(num(value))}">
    <div class="lbl">${esc(label)}</div><div class="val">${esc(num(value))}</div><div class="sub">${esc(sub)}</div></a>`;
}

function chipsOf(map, order) {
  const keys = order || Object.keys(map || {});
  const parts = keys.filter(k => map && map[k]).map(k => `<span class="chip ${tone(k)}">${esc(k)} ${esc(num(map[k]))}</span>`);
  return parts.length ? `<div class="chips">${parts.join('')}</div>` : '';
}


// ---------- state ----------
const S = {
  hours: Number(localStorage.getItem('hours') || 24),
  auto: localStorage.getItem('auto') !== 'off',
  theme: localStorage.getItem('theme') || 'light',
  ordersSearch: '', ordersLimit: 100, ordersHours: 0,
  eventsOutcome: '', eventsSearch: '',
  logKind: '', logLevel: '', logRef: '', logSearch: '', logFull: false,
  issuesLevel: '', detailTab: 'timeline', detailOpen: null,
  summary: null, renderSeq: 0, lastStamp: null
};

// ---------- data access ----------
async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false));
  const q = qs.toString();
  const r = await fetch(`/api/${path}${q ? '?' + q : ''}`, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch { body = { error: `HTTP ${r.status}` }; }
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// ---------- routing ----------
function route() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [path, query = ''] = raw.split('?');
  const [head, ...rest] = path.split('/');
  const id = rest.length ? rest.join('/') : null;
  const name = head === 'orders' && id ? 'order' : (head || 'overview');
  return { name, id, query: new URLSearchParams(query) };
}
const NAV = { overview: 'Overview', orders: 'Orders', order: 'Orders', events: 'App events → 214', logs: 'Logs', issues: 'Issues', files: 'Files & SFTP', about: 'About & health' };

function setChrome(r) {
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === (r.name === 'order' ? 'orders' : r.name)));
  const crumbs = document.getElementById('crumbs');
  if (r.name === 'order') {
    crumbs.innerHTML = `<a href="#/orders">Orders</a><span class="sep">/</span>${esc(r.id)}`;
  } else {
    crumbs.textContent = NAV[r.name] || 'Overview';
  }
  document.title = `${NAV[r.name] || 'Overview'} · Trinium Flow`;
  // The time window only applies to views that query by time.
  const windowed = ['overview', 'orders', 'order', 'events', 'issues'].includes(r.name);
  document.getElementById('hours').closest('label').hidden = !windowed;
}

// ---------- rendering ----------
async function render(opts = {}) {
  const seq = ++S.renderSeq;
  const r = route();
  setChrome(r);
  const scroll = window.scrollY;
  // Remember which filter field has the caret, so typing survives re-renders.
  const active = document.activeElement;
  const focusKey = active && active.id && main.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT') ? active.id : null;
  const caret = focusKey && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const view = VIEWS[r.name === 'order' ? 'order' : r.name] || VIEWS.overview;
  let html;
  try {
    html = await view(r);
  } catch (err) {
    html = `<div class="err-box"><b>This view could not load.</b><div class="small" style="margin-top:6px">${esc(err.message)}</div>
      <div class="small" style="margin-top:6px">Check that the dashboard can reach the database (<a href="#/about">About &amp; health</a>).</div></div>`;
  }
  if (seq !== S.renderSeq) return; // a newer render has started
  main.innerHTML = html;
  if (focusKey) {
    const el = document.getElementById(focusKey);
    if (el) {
      el.focus();
      if (caret !== null && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret);
    }
  }
  if (!opts.keepScroll) window.scrollTo(0, scroll);
  S.lastStamp = new Date();
  document.getElementById('stamp').textContent = `Updated ${timeOnly(S.lastStamp)}`;
}

// ---------- views ----------
const VIEWS = {};

VIEWS.overview = async () => {
  const [sum, logs, sftp] = await Promise.all([
    api('summary', { hours: S.hours }),
    api('logs', { limit: 1000 }).catch(() => []),
    api('sftp').catch(e => ({ ok: false, error: e.message }))
  ]);
  S.summary = sum;
  const A = sum.flowA, B = sum.flowB, st = sum.stuck, tr = sum.trace, last = sum.last || {};
  const kafkaTone = st.kafkaFailed ? 'bad' : st.kafkaPending ? 'warn' : 'good';
  const sftpTone = st.sftp_failing ? 'bad' : st.sftp_pending ? 'warn' : 'good';
  const kpis = [
    kpi('204 messages', A.received, `${num(A.distinctOrders)} distinct orders`, 'orders', 'neutral'),
    kpi('Converted to order', A.converted, 'created, updated, cancelled, reactivated', 'orders', 'good'),
    kpi('Published to Kafka', A.kafka?.SENT || 0, `${num(st.kafkaPending)} pending · ${num(st.kafkaFailed)} failed`, 'issues', kafkaTone),
    kpi('App events', B.received, `${num(B.outcomes?.SENT_214 || 0)} produced a 214`, 'events', 'neutral'),
    kpi('214 files generated', B.edi214, `${num(B.fileWritten)} written to the outbound folder`, 'events', 'neutral'),
    kpi('Delivered to SFTP', B.sftp?.SENT || 0, `${num(st.sftp_pending)} waiting · ${num(st.sftp_failing)} failing`, 'issues', sftpTone),
    kpi('Trace errors', tr.errors, `${num(tr.warns)} warnings · ${num(tr.total)} records`, 'issues', tr.errors ? 'bad' : (tr.warns ? 'warn' : 'good'))
  ].join('');

  const flowA = [
    { l: '204 received', n: A.received, chips: chipsOf(A.outcomes, ['CREATED', 'UPDATED', 'CANCELLED', 'REACTIVATED', 'NOOP', 'STALE']), go: 'orders' },
    { l: 'Converted to order', n: A.converted, chips: '', go: 'orders' },
    { l: 'Queued for Kafka', n: A.queued, chips: chipsOf(A.kafka, ['SENT', 'PENDING', 'FAILED']), go: 'issues' },
    { l: 'Published', n: A.kafka?.SENT || 0, chips: '', go: 'orders' }
  ];
  const flowB = [
    { l: 'App events received', n: B.received, chips: chipsOf(B.outcomes, ['SENT_214', 'HELD', 'SKIPPED', 'ERROR']), go: 'events' },
    { l: 'Processed to 214', n: B.outcomes?.SENT_214 || 0, chips: '', go: 'events' },
    { l: '214 files generated', n: B.edi214, chips: chipsOf({ WRITTEN: B.fileWritten }, ['WRITTEN']), go: 'events' },
    { l: 'Delivered to SFTP', n: B.sftp?.SENT || 0, chips: chipsOf(B.sftp, ['SENT', 'PENDING', 'N/A']), go: 'issues' }
  ];
  const pipe = list => `<div class="pipe">${list.map(s => `
      <a class="stage" href="#/${s.go}"><div class="lbl">${esc(s.l)}</div><div class="val">${esc(num(s.n))}</div>${s.chips}</a>`).join('')}</div>`;

  const stuck = [
    ['Kafka publish pending', st.kafkaPending, st.kafkaOldest ? `oldest ${rel(st.kafkaOldest)}` : 'none waiting'],
    ['Kafka publish failed', st.kafkaFailed, 'retried until sent or moved aside'],
    ['214 waiting for SFTP', st.sftp_pending, 'written locally, not yet uploaded'],
    ['SFTP upload failing', st.sftp_failing, 'see the error on the Issues page'],
    ['214 not yet written', st.file_pending, 'event accepted, file not produced yet']
  ];
  const stuckHtml = `<ul class="list">${stuck.map(([l, n, s]) => `<li>
      <div class="l"><b>${esc(l)}</b><div class="small muted">${esc(s)}</div></div>
      ${n ? `<span class="badge ${/failing|failed/.test(l) ? 'bad' : 'warn'}">${esc(num(n))}</span>` : '<span class="badge good">0</span>'}</li>`).join('')}</ul>`;

  const lastHtml = `<ul class="list">${[
    ['Last 204 converted', last.last_204], ['Last Kafka publish', last.last_kafka_out],
    ['Last app event', last.last_event], ['Last 214 written', last.last_214], ['Last SFTP upload', last.last_sftp]
  ].map(([l, t]) => `<li><div class="l"><b>${esc(l)}</b></div><span class="small" title="${esc(dateTime(t))}">${esc(rel(t))}</span></li>`).join('')}</ul>`;

  const records = Array.isArray(logs) ? logs : [];
  const recent = records.slice(0, 12);
  const sftpHtml = sftpSummary(sftp);

  return `
  <div class="page-h"><div><h1>Overview</h1><p>Last ${esc(S.hours)} h · database headline counts, stuck items and recent service activity</p></div></div>
  <div class="grid g-kpi">${kpis}</div>

  <div class="section"><h2>Trinium 204 → app (Flow A)</h2><span class="rule"></span></div>
  ${pipe(flowA)}
  <div class="section"><h2>App → Trinium 214 (Flow B)</h2><span class="rule"></span></div>
  ${pipe(flowB)}

  <div class="section"><h2>Health and activity</h2><span class="rule"></span></div>
  <div class="grid g-2">
    <div class="card"><div class="card-h"><h3>Activity by hour</h3><span class="small muted">from the service logs, last ${esc(records.length)} records</span></div>
      <div class="card-b">${activityChart(records)}</div></div>
    <div class="grid" style="align-content:start">
      <div class="card"><div class="card-h"><h3>Stuck right now</h3><span class="small muted">all time</span></div><div class="card-b">${stuckHtml}</div></div>
      <div class="card"><div class="card-h"><h3>Freshness</h3></div><div class="card-b">${lastHtml}</div></div>
      <div class="card"><div class="card-h"><h3>SFTP</h3></div><div class="card-b">${sftpHtml}</div></div>
    </div>
  </div>

  <div class="section"><h2>Recent service activity</h2><span class="rule"></span></div>
  <div class="card">${recentLogsTable(recent)}</div>
  <p class="small muted" style="margin-top:10px">Full log, filters and expanded payloads are on the <a href="#/logs">Logs</a> page.</p>`;
};

function sftpSummary(s) {
  if (!s) return '<p class="muted">No SFTP data.</p>';
  if (s.disabled) return `<p class="muted">Live SFTP view is off. Set <span class="mono">DASH_SFTP=true</span> to list the Trinium folders.</p>`;
  if (!s.ok) return `<div class="err-box" style="margin:0">Could not reach SFTP: ${esc(s.error || 'unknown error')}</div>`;
  const rows = Object.entries(s.folders || {}).map(([dir, v]) => `<li><div class="l"><b class="mono">${esc(dir)}</b><div class="small muted">${esc((s.roles || {})[dir] || '')}</div></div>
      <span class="badge neutral">${esc(num(v.count))} files</span></li>`).join('');
  return `<ul class="list">${rows}</ul><p class="small muted" style="margin:8px 0 0">Checked ${esc(rel(s.checkedAt))} · ${esc(s.host || '')}</p>`;
}

function activityChart(records) {
  const buckets = new Map();
  for (const r of records) {
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 13);
    const b = buckets.get(key) || { ok: 0, warn: 0, error: 0 };
    const w = isErr(r) ? 'error' : worst(r.issues) === 'warn' ? 'warn' : 'ok';
    b[w] += 1;
    buckets.set(key, b);
  }
  const keys = [...buckets.keys()].sort().slice(-24);
  if (!keys.length) return '<div class="empty">No log records in the current files yet.</div>';
  const W = 760, H = 220, pad = { l: 36, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...keys.map(k => buckets.get(k).ok + buckets.get(k).warn + buckets.get(k).error));
  const bw = (W - pad.l - pad.r) / keys.length;
  const y = v => H - pad.b - (v / max) * (H - pad.t - pad.b);
  let bars = '';
  keys.forEach((k, i) => {
    const b = buckets.get(k);
    let base = 0;
    for (const [w, col] of [['ok', 'var(--sky)'], ['warn', 'var(--warn)'], ['error', 'var(--bad)']]) {
      const h = (b[w] / max) * (H - pad.t - pad.b);
      if (h > 0) bars += `<rect x="${(pad.l + i * bw + 3).toFixed(1)}" y="${(y(base + b[w])).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" rx="2"><title>${esc(timeOnly(k + ':00:00Z'))}: ${b[w]} ${w}</title></rect>`;
      base += b[w];
    }
  });
  const ticks = [0, Math.round(max / 2), max];
  const grid = ticks.map(t => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  const every = Math.ceil(keys.length / 8);
  const labels = keys.map((k, i) => i % every === 0 ? `<text x="${(pad.l + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(new Date(k + ':00:00Z').getHours().toString().padStart(2, '0'))}:00</text>` : '').join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Log records per hour by outcome">${grid}${bars}${labels}</svg>
    <div class="legend" style="margin-top:6px"><span><i style="background:var(--sky)"></i>ok</span><span><i style="background:var(--warn)"></i>warning</span><span><i style="background:var(--bad)"></i>error</span></div>`;
}

function recentLogsTable(records) {
  return table([
    { h: 'Time', nowrap: true, f: r => `<span class="mono">${esc(timeOnly(r.ts))}</span>` },
    { h: 'Service', f: r => esc(r.service === 'trinium-order-transformer' ? 'Order transformer' : r.service === 'trinium-event-to-214' ? 'Event → 214' : r.service) },
    { h: 'Kind', f: r => `<span class="mono">${esc(r.kind)}</span>` },
    { h: 'Ref', f: r => r.ref ? `<a class="mono" href="#/orders/${encodeURIComponent(r.ref)}">${esc(r.ref)}</a>` : '<span class="muted">—</span>' },
    { h: 'Outcome', f: r => badge(r.outcome) },
    { h: 'Issues', f: r => (r.issues || []).length ? `${badge(worst(r.issues) === 'error' ? 'ERROR' : 'WARN')} <span class="small muted">${esc((r.issues[0] || {}).code || '')}</span>` : '<span class="muted">none</span>' }
  ], records, { empty: 'No service log records yet.', rowAttr: r => `data-go="#/logs?ref=${encodeURIComponent(r.ref || '')}"`, rowClass: r => isErr(r) ? 'lvl-err' : (worst(r.issues) === 'warn' ? 'lvl-warn' : '') });
}

// Orders -------------------------------------------------------------
VIEWS.orders = async () => {
  const rows = await api('orders', { limit: S.ordersLimit, search: S.ordersSearch, hours: S.ordersHours || undefined });
  return `
  <div class="page-h"><div><h1>Orders</h1><p>One row per Trinium leg, with every stage: 204 received, converted, Kafka, app events and 214 delivery</p></div></div>
  <div class="toolbar">
    <input id="f-orders" type="search" placeholder="Dispatch seq, BOL, container, order no, work order" value="${esc(S.ordersSearch)}" aria-label="Search orders" data-filter="ordersSearch">
    <label class="ctl"><span>Changed in</span>
      <select data-filter="ordersHours" aria-label="Changed in">
        ${[[0, 'any time'], [1, 'last hour'], [24, 'last 24 h'], [168, 'last 7 days']].map(([v, l]) => `<option value="${v}" ${S.ordersHours === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label class="ctl"><span>Rows</span>
      <select data-filter="ordersLimit" aria-label="Rows">${[100, 300, 500].map(v => `<option ${S.ordersLimit === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <span class="grow"></span><span class="count-pill">${esc(num(rows.length))} legs</span>
  </div>
  ${table([
    { h: 'Dispatch seq', nowrap: true, f: r => `<span class="mono">${esc(r.dispatch_seq)}</span>` },
    { h: 'Order no', nowrap: true, f: r => esc(r.trinium_order_no) },
    { h: 'BOL', nowrap: true, f: r => `<span class="mono">${esc(r.bol)}</span>` },
    { h: 'Container', nowrap: true, f: r => `<span class="mono">${esc(r.container_number || '—')}</span>` },
    { h: 'Leg', f: r => esc(r.leg_type || '—') },
    { h: 'Leg status', f: r => badge(r.leg_status) },
    { h: 'Last 204', f: r => badge(r.last_outcome) },
    { h: 'Kafka', f: r => badge(r.kafka_status) + (r.kafka_open ? ` <span class="small muted">${esc(r.kafka_open)} open</span>` : '') },
    { h: 'Events', num: true, f: r => esc(num(r.events)) },
    { h: '214 (SFTP)', f: r => `${esc(num(r.edi214_sftp))}/${esc(num(r.edi214))}${r.edi214_sftp_pending ? ` <span class="badge warn">${esc(r.edi214_sftp_pending)} pending</span>` : ''}` },
    { h: 'Issues', f: r => (r.errors ? `<span class="badge bad">${esc(r.errors)} err</span> ` : '') + (r.warns ? `<span class="badge warn">${esc(r.warns)} warn</span>` : (r.errors ? '' : '<span class="muted">—</span>')) },
    { h: 'Updated', nowrap: true, f: r => `<span title="${esc(dateTime(r.updated_at))}">${esc(rel(r.updated_at))}</span>` }
  ], rows, {
    empty: S.ordersSearch ? 'No legs match this search.' : 'No legs in this window.',
    rowAttr: r => `data-go="#/orders/${encodeURIComponent(r.dispatch_seq)}" tabindex="0"`,
    rowClass: r => (r.errors ? 'lvl-err' : (r.warns ? 'lvl-warn' : ''))
  })}`;
};

// Order detail -------------------------------------------------------
VIEWS.order = async r => {
  const d = await api(`orders/${encodeURIComponent(r.id)}`);
  if (d.error) return `<div class="err-box">No leg with dispatch sequence <span class="mono">${esc(r.id)}</span>.</div>`;
  const L = d.leg || {};
  const tabs = [
    ['timeline', 'Timeline', d.timeline?.length],
    ['messages', '204 messages', d.messages?.length],
    ['kafka', 'Kafka', d.outbound?.length],
    ['events', 'App events', d.events?.length],
    ['edi', '214 files', d.edi214?.length],
    ['traces', 'Checks & traces', d.traces?.length],
    ['equipment', 'Equipment', d.equipment ? 1 : 0]
  ];
  const tabBar = `<div class="tabs" role="tablist" aria-label="Order detail">${tabs.map(([k, l, n]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${S.detailTab === k}" id="tab-${k}">${esc(l)}${n !== undefined ? `<span class="n">${esc(n || 0)}</span>` : ''}</button>`).join('')}</div>`;
  const body = {
    timeline: () => timelineTab(d),
    messages: () => messagesTab(d),
    kafka: () => kafkaTab(d),
    events: () => eventsTab(d),
    edi: () => ediTab(d),
    traces: () => tracesTab(d),
    equipment: () => `<div class="card"><div class="card-b">${kvs(d.equipment)}</div></div>`
  }[S.detailTab]();
  const stops = (d.stops || []).map(s => `<div class="card stop">
      <div class="t">Stop ${esc(s.seq)} · ${esc(s.reason || s.activity || '')}</div>
      <div class="name">${esc(s.location_name || s.name || '—')}</div>
      <div class="small muted">${esc([s.city, s.state].filter(Boolean).join(', '))}</div>
      <div class="chips" style="margin-top:8px">${s.geo_matched === true ? '<span class="chip good">geo matched</span>' : s.geo_matched === false ? '<span class="chip warn">geo not matched</span>' : ''}
        ${(s.appointments || []).length ? `<span class="chip neutral">appt ${esc(s.appointments.join(' '))}</span>` : ''}</div></div>`).join('');
  return `
  <div class="page-h"><div><h1 class="mono" style="font-size:20px">${esc(r.id)}</h1><p>${esc(L.trinium_order_no || '')} · BOL <span class="mono">${esc(L.bol || '—')}</span> · ${esc(L.leg_type || '')} leg</p></div>
    <span class="grow"></span>${badge(L.status)} <button class="btn ghost" data-go="#/orders" type="button">← All orders</button></div>
  <div class="card hdr">
    <div class="kv"><div class="k">Container</div><div class="v mono">${esc(L.container_number || '—')}</div></div>
    <div class="kv"><div class="k">Work order</div><div class="v mono">${esc(L.work_order || '—')}</div></div>
    <div class="kv"><div class="k">Driver code</div><div class="v">${esc(L.driver_code || '—')}</div></div>
    <div class="kv"><div class="k">Publishes</div><div class="v">${esc(num(L.publish_count || 0))}</div></div>
    <div class="kv"><div class="k">Created</div><div class="v small">${esc(dateTime(L.created_at))}</div></div>
    <div class="kv"><div class="k">Updated</div><div class="v small">${esc(dateTime(L.updated_at))}</div></div>
    <div class="kv"><div class="k">Raw 204 chars</div><div class="v">${esc(num(d.rawChars || 0))}</div></div>
  </div>
  <div class="grid g-3" style="margin-top:14px">${stops || '<div class="card"><div class="empty">No stops recorded.</div></div>'}</div>
  ${tabBar}
  <div id="tabpanel" role="tabpanel" aria-labelledby="tab-${esc(S.detailTab)}">${body}</div>`;
};

function timelineTab(d) {
  const t = d.timeline || [];
  if (!t.length) return '<div class="card"><div class="empty">No events on this leg yet.</div></div>';
  return `<div class="card">${t.map(x => `<div class="tline">
      <span class="t">${esc(dateTime(x.at))}</span>
      ${flowTag(x.flow)}
      <span>${esc(x.stage)}</span>
      <span>${badge(x.status)}</span>
      <span class="x">${esc(x.text || '')}</span></div>`).join('')}</div>`;
}

function messagesTab(d) {
  return table([
    { h: 'Received', nowrap: true, f: m => esc(dateTime(m.created_at)) },
    { h: 'File', f: m => `<span class="mono">${esc(m.file_name || '—')}</span>` },
    { h: 'Txn', f: m => esc(m.txn_type || '—') },
    { h: 'ISA control', f: m => `<span class="mono">${esc(m.isa_control || '—')}</span>` },
    { h: 'Outcome', f: m => badge(m.outcome) },
    { h: 'Changed fields', wrap: true, f: m => esc((m.changed_fields || []).join(', ') || '—') },
    { h: 'Warnings', f: m => esc((m.warnings || []).length || 0) }
  ], d.messages || [], { empty: 'No 204 messages for this leg.' });
}

function kafkaTab(d) {
  const rows = d.outbound || [];
  if (!rows.length) return '<div class="card"><div class="empty">Nothing queued for Kafka.</div></div>';
  return table([
    { h: 'Queued', nowrap: true, f: o => esc(dateTime(o.created_at)) },
    { h: 'Topic', f: o => `<span class="mono">${esc(o.topic)}</span>` },
    { h: 'Status', f: o => badge(o.status) },
    { h: 'Attempts', num: true, f: o => esc(o.attempts ?? 0) },
    { h: 'Partition / offset', f: o => o.sent_at ? `<span class="mono">${esc(o.kafka_partition)} / ${esc(o.kafka_offset)}</span>` : '<span class="muted">—</span>' },
    { h: 'Sent', nowrap: true, f: o => esc(dateTime(o.sent_at)) },
    { h: 'Last error', wrap: true, f: o => esc(o.last_error || '') },
    { h: 'Payload', f: o => `<button class="expand" data-toggle="kafka-${esc(o.id)}" type="button">view</button>` }
  ], rows) + rows.map(o => S.detailOpen === `kafka-${o.id}` ? `<div class="card" style="margin-top:8px"><div class="card-b"><div class="small muted">Payload for outbound ${esc(o.id)}</div><pre class="json">${esc(json(o.payload))}</pre></div></div>` : '').join('');
}

function eventsTab(d) {
  return table([
    { h: 'Received', nowrap: true, f: e => esc(dateTime(e.received_at)) },
    { h: 'Event', f: e => `<span class="mono">${esc(e.event_status || e.event_type || '—')}</span>` },
    { h: 'Source', f: e => esc(e.source || '—') },
    { h: 'Outcome', f: e => badge(e.outcome) },
    { h: 'Detail', wrap: true, f: e => esc(e.detail || '') },
    { h: 'Payload', f: e => `<button class="expand" data-toggle="evt-${esc(e.event_id)}" type="button">view</button>` }
  ], d.events || [], { empty: 'No app events for this leg.' }) + (d.events || []).map(e => S.detailOpen === `evt-${e.event_id}` ? `<div class="card" style="margin-top:8px"><div class="card-b"><div class="small muted">Event ${esc(e.event_id)}</div><pre class="json">${esc(json(e.payload))}</pre></div></div>` : '').join('');
}

function ediTab(d) {
  const rows = d.edi214 || [];
  if (!rows.length) return '<div class="card"><div class="empty">No 214 files generated for this leg.</div></div>';
  return table([
    { h: 'Generated', nowrap: true, f: x => esc(dateTime(x.created_at)) },
    { h: 'AT7', f: x => `<span class="mono">${esc(x.at7_code)}</span>` },
    { h: 'Event time (LT)', nowrap: true, f: x => `<span class="mono">${esc(x.event_time_local || '—')}</span>` },
    { h: 'File', f: x => `<span class="mono">${esc(x.file_name || '—')}</span>` },
    { h: 'File status', f: x => badge(x.status) },
    { h: 'SFTP', f: x => badge(x.sftp_status || 'N/A') + (x.sftp_error ? ` <span class="small muted">${esc(x.sftp_error)}</span>` : '') },
    { h: 'Delivered', nowrap: true, f: x => esc(dateTime(x.sftp_sent_at)) },
    { h: 'Content', f: x => `<button class="expand" data-toggle="edi-${esc(x.id)}" type="button">view</button>` }
  ], rows) + rows.map(x => S.detailOpen === `edi-${x.id}` ? `<div class="card" style="margin-top:8px"><div class="card-b"><div class="small muted">${esc(x.file_name || '')}</div><pre class="code">${esc(x.content || '')}</pre></div></div>` : '').join('');
}

function tracesTab(d) {
  const rows = d.traces || [];
  if (!rows.length) return '<div class="card"><div class="empty">No trace records for this leg.</div></div>';
  return rows.map(t => {
    const key = `trace-${t.id}`;
    const issues = (t.issues || []).map(i => `<div class="issue">${badge(i.level === 'error' ? 'ERROR' : i.level === 'warn' ? 'WARN' : 'INFO')}
        <div><b class="mono">${esc(i.code)}</b><div class="msg">${esc(i.message)}</div></div></div>`).join('');
    return `<div class="card" style="margin-bottom:12px">
      <div class="card-h"><span class="badge neutral">${esc(t.service)}</span><span class="mono small">${esc(t.kind)}</span>
        <span class="small muted">${esc(t.source || '')}</span><span class="grow"></span>${badge(t.outcome)}<span class="small muted">${esc(dateTime(t.created_at))}</span></div>
      <div class="card-b">${issues || '<span class="muted small">No checks raised.</span>'}
        <div class="tools"><button class="expand" data-toggle="${key}-in" type="button">incoming</button>
          <button class="expand" data-toggle="${key}-out" type="button">outgoing</button></div>
        ${S.detailOpen === `${key}-in` ? `<pre class="json">${esc(json(t.incoming))}</pre>` : ''}
        ${S.detailOpen === `${key}-out` ? `<pre class="json">${esc(json(t.outgoing))}</pre>` : ''}
      </div></div>`;
  }).join('');
}

// Events -------------------------------------------------------------
VIEWS.events = async () => {
  const rows = await api('events', { limit: 200, outcome: S.eventsOutcome, search: S.eventsSearch, hours: S.hours });
  const outcomes = ['', 'SENT_214', 'HELD', 'SKIPPED', 'ERROR'];
  return `
  <div class="page-h"><div><h1>App events → 214</h1><p>Flow B: every event the driver app sends, what it became, and whether the 214 reached Trinium</p></div></div>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="Outcome">${outcomes.map(o => `<button type="button" data-set="eventsOutcome" data-val="${o}" aria-pressed="${S.eventsOutcome === o}">${o || 'All'}</button>`).join('')}</div>
    <input id="f-events" type="search" placeholder="Dispatch seq, event id, status, file" value="${esc(S.eventsSearch)}" aria-label="Search events" data-filter="eventsSearch">
    <span class="grow"></span><span class="count-pill">${esc(num(rows.length))} events in ${esc(S.hours)} h</span>
  </div>
  ${table([
    { h: 'Received', nowrap: true, f: e => esc(dateTime(e.received_at)) },
    { h: 'Dispatch seq', nowrap: true, f: e => `<a class="mono" href="#/orders/${encodeURIComponent(e.dispatch_seq)}">${esc(e.dispatch_seq)}</a>` },
    { h: 'Event', f: e => `<span class="mono">${esc(e.event_status || e.event_type || '—')}</span>` },
    { h: 'Outcome', f: e => badge(e.outcome) },
    { h: '214', f: e => e.at7_code ? `<span class="mono">${esc(e.at7_code)}</span> <span class="small muted">${esc(e.event_time_local || '')}</span>` : '<span class="muted">none</span>' },
    { h: 'File', f: e => `<span class="mono small">${esc(e.file_name || '—')}</span>` },
    { h: 'File status', f: e => badge(e.file_status) },
    { h: 'SFTP', f: e => e.sftp_status ? badge(e.sftp_status) + (e.sftp_error ? ` <span class="small muted">${esc(e.sftp_error)}</span>` : '') : '<span class="muted">—</span>' },
    { h: 'Checks', f: e => (e.errors ? `<span class="badge bad">${esc(e.errors)}</span> ` : '') + (e.warns ? `<span class="badge warn">${esc(e.warns)}</span>` : (e.errors ? '' : '<span class="muted">—</span>')) },
    { h: 'Detail', wrap: true, f: e => esc(e.detail || '') }
  ], rows, { empty: 'No app events in this window.', rowClass: e => (e.errors ? 'lvl-err' : (e.outcome === 'HELD' ? 'lvl-warn' : '')) })}`;
};

// Logs ---------------------------------------------------------------
VIEWS.logs = async r => {
  if (r.query.get('ref') !== null) S.logRef = r.query.get('ref');
  const recs = await api('logs', { limit: 300, kind: S.logKind, level: S.logLevel, ref: S.logRef, full: S.logFull ? 1 : undefined });
  const q = S.logSearch.trim().toLowerCase();
  const shown = q ? recs.filter(x => JSON.stringify(x).toLowerCase().includes(q)) : recs;
  const kinds = ['', 'order_204', 'driver_event'];
  return `
  <div class="page-h"><div><h1>Logs</h1><p>Newest first. Read from the services' trace files: 204 in, the app events in, and 214 out, with every check raised</p></div></div>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="Log kind">${kinds.map(k => `<button type="button" data-set="logKind" data-val="${k}" aria-pressed="${S.logKind === k}">${k === '' ? 'All kinds' : k === 'order_204' ? '204 in' : 'App event'}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Level">${[['', 'Any'], ['warn', 'Warnings'], ['error', 'Errors']].map(([v, l]) => `<button type="button" data-set="logLevel" data-val="${v}" aria-pressed="${S.logLevel === v}">${l}</button>`).join('')}</div>
    <input id="f-logs" type="search" placeholder="Filter text in these records" value="${esc(S.logSearch)}" aria-label="Filter log text" data-filter="logSearch">
    <input type="text" placeholder="Ref (dispatch seq)" value="${esc(S.logRef)}" aria-label="Ref" data-filter="logRef" style="min-width:160px">
    <label class="ctl"><input type="checkbox" id="logfull" data-check="logFull" ${S.logFull ? 'checked' : ''}> Include full bodies</label>
    <span class="grow"></span><span class="count-pill">${esc(shown.length)} of ${esc(recs.length)}</span>
  </div>
  ${logTable(shown)}`;
};

function logTable(recs) {
  if (!recs.length) return '<div class="card"><div class="empty">No log records match.</div></div>';
  return `<div class="tbl-wrap"><table class="log"><thead><tr><th>Time</th><th>Service</th><th>Kind</th><th>Ref</th><th>Source</th><th>Outcome</th><th>Checks</th></tr></thead><tbody>
    ${recs.map((r, i) => {
      const key = `log-${i}-${r.ts}-${r.ref || ''}`;
      const open = S.detailOpen === key;
      const checks = (r.issues || []).map(x => `<div class="issue">${badge(x.level === 'error' ? 'ERROR' : x.level === 'warn' ? 'WARN' : 'INFO')}<div class="msg"><b>${esc(x.code)}</b> ${esc(x.message)}</div></div>`).join('');
      return `<tr class="click ${isErr(r) ? 'lvl-err' : worst(r.issues) === 'warn' ? 'lvl-warn' : ''}" data-toggle="${esc(key)}" tabindex="0">
        <td class="nowrap" title="${esc(r.ts)}">${esc(dateTime(r.ts))}</td>
        <td class="nowrap">${esc(r.service === 'trinium-order-transformer' ? 'Order transformer' : r.service === 'trinium-event-to-214' ? 'Event → 214' : r.service)}</td>
        <td class="nowrap">${esc(r.kind)}</td>
        <td class="nowrap">${r.ref ? `<a href="#/orders/${encodeURIComponent(r.ref)}" data-stop>${esc(r.ref)}</a>` : ''}</td>
        <td class="wrap">${esc(r.source || '')}</td>
        <td class="nowrap">${badge(r.outcome)}</td>
        <td>${(r.issues || []).length ? `<span class="badge ${worst(r.issues) === 'error' ? 'bad' : 'warn'}">${esc(r.issues.length)}</span>` : '<span class="muted">—</span>'}</td>
      </tr>
      ${open ? `<tr><td colspan="7" style="background:var(--surface-2)">
          ${checks ? `<div style="margin-bottom:10px">${checks}</div>` : ''}
          <div class="grid g-2" style="gap:10px">
            <div><div class="small muted" style="margin-bottom:4px">Incoming</div><pre class="json">${esc(json(r.incoming ?? r.full?.incoming ?? null))}</pre></div>
            <div><div class="small muted" style="margin-bottom:4px">Outgoing</div><pre class="json">${esc(json(r.outgoing ?? r.full?.outgoing ?? null))}</pre></div>
          </div>
          <div class="small muted" style="margin-top:8px">${esc(r._file || '')}</div></td></tr>` : ''}`;
    }).join('')}
  </tbody></table></div>`;
}

// Issues -------------------------------------------------------------
VIEWS.issues = async () => {
  const d = await api('issues', { limit: 200, level: S.issuesLevel, hours: Math.max(S.hours, 168) });
  const stuck = d.stuck || [], trace = d.trace || [];
  const levels = ['', 'error', 'warn'];
  const traceRows = trace.flatMap(t => (t.issues || []).filter(i => !S.issuesLevel || i.level === S.issuesLevel).map(i => ({ t, i })));
  return `
  <div class="page-h"><div><h1>Issues</h1><p>Checks raised by the services, and items stuck in an outbox. Newest first; the last 7 days are included</p></div></div>
  <div class="toolbar"><div class="seg" role="group" aria-label="Level">${levels.map(l => `<button type="button" data-set="issuesLevel" data-val="${l}" aria-pressed="${S.issuesLevel === l}">${l === '' ? 'All' : l === 'error' ? 'Errors' : 'Warnings'}</button>`).join('')}</div>
    <span class="grow"></span><span class="count-pill">${esc(stuck.length)} stuck · ${esc(traceRows.length)} checks</span></div>
  <div class="section"><h2>Stuck items</h2><span class="rule"></span></div>
  ${table([
    { h: 'Channel', f: s => `<span class="mono">${esc(s.channel)}</span>` },
    { h: 'Dispatch seq', nowrap: true, f: s => s.ref ? `<a class="mono" href="#/orders/${encodeURIComponent(s.ref)}">${esc(s.ref)}</a>` : '—' },
    { h: 'Status', f: s => badge(s.status) },
    { h: 'Attempts', num: true, f: s => esc(s.attempts ?? '—') },
    { h: 'Detail', wrap: true, f: s => esc(s.detail || '') },
    { h: 'Since', nowrap: true, f: s => esc(rel(s.created_at)) }
  ], stuck, { empty: 'Nothing is stuck. Every outbox item has been sent or moved aside.' })}
  <div class="section"><h2>Checks raised</h2><span class="rule"></span></div>
  ${table([
    { h: 'When', nowrap: true, f: x => esc(dateTime(x.t.created_at)) },
    { h: 'Level', f: x => badge(x.i.level === 'error' ? 'ERROR' : 'WARN') },
    { h: 'Code', f: x => `<span class="mono">${esc(x.i.code)}</span>` },
    { h: 'Message', wrap: true, f: x => esc(x.i.message) },
    { h: 'Service / ref', nowrap: true, f: x => `${esc(x.t.service)} · ${x.t.ref ? `<a href="#/orders/${encodeURIComponent(x.t.ref)}">${esc(x.t.ref)}</a>` : '—'}` }
  ], traceRows.slice(0, 300), { empty: 'No checks in this period.' })}`;
};

// Files & SFTP ------------------------------------------------------
VIEWS.files = async () => {
  const [files, sftp] = await Promise.all([api('files'), api('sftp').catch(e => ({ ok: false, error: e.message }))]);
  const counts = Object.entries(files.counts || {});
  const countRows = counts.map(([k, v]) => ({ k, v }));
  const sftpRows = sftp.ok ? Object.entries(sftp.folders || {}).map(([dir, f]) => ({ dir, ...f, role: (sftp.roles || {})[dir] || '' })) : [];
  return `
  <div class="page-h"><div><h1>Files &amp; SFTP</h1><p>Local working folders of both services, rejected files with reasons, and the live Trinium folders</p></div></div>
  <div class="grid g-2">
    <div class="card"><div class="card-h"><h3>Local folders</h3></div>${table([
      { h: 'Folder', f: r => esc(r.k) },
      { h: 'Files', num: true, f: r => r.v === null ? '<span class="muted">not present</span>' : esc(num(r.v)) }
    ], countRows, { empty: 'No folders configured.' })}</div>
    <div class="card"><div class="card-h"><h3>Rejected files</h3><span class="small muted">most recent 30</span></div>${table([
      { h: 'When', nowrap: true, f: r => esc(dateTime(r.at)) },
      { h: 'Kind', f: r => esc(r.kind) },
      { h: 'File', f: r => `<span class="mono small">${esc(r.file)}</span>` },
      { h: 'Reason', wrap: true, f: r => esc(r.reason) }
    ], files.rejected || [], { empty: 'No rejected files.' })}</div>
  </div>
  <div class="section"><h2>Trinium SFTP (read-only listing)</h2><span class="rule"></span></div>
  ${sftp.disabled ? `<div class="note">The live SFTP view is off (<span class="mono">DASH_SFTP=false</span>).</div>`
    : !sftp.ok ? `<div class="err-box">Could not list SFTP: ${esc(sftp.error || 'unknown error')}<div class="small" style="margin-top:6px">Checked ${esc(dateTime(sftp.checkedAt))}</div></div>`
    : `<p class="small muted">Host ${esc(sftp.host || '')} · checked ${esc(dateTime(sftp.checkedAt))} (cached 30 s)</p>
       <div class="grid g-2">${sftpRows.map(f => `<div class="card"><div class="card-h"><h3 class="mono">${esc(f.dir)}</h3><span class="badge neutral">${esc(num(f.count))} files</span><span class="small muted">${esc(f.role)}</span></div>
         ${table([
           { h: 'File', f: x => `<span class="mono small">${esc(x.name)}</span>` },
           { h: 'Size', num: true, f: x => esc(num(x.size)) },
           { h: 'Modified', nowrap: true, f: x => esc(dateTime(x.modified)) }
         ], f.files, { empty: 'Folder is empty.' })}</div>`).join('')}</div>`}`;
};

// About & health ----------------------------------------------------
VIEWS.about = async () => {
  let health;
  try { health = await api('health'); } catch (e) { health = { ok: false, error: e.message }; }
  const endpoints = [
    ['/api/summary', 'Headline counts for both flows and what is stuck'],
    ['/api/orders', 'One row per Trinium leg, all stages'],
    ['/api/orders/:id', 'One leg in full, with the merged timeline'],
    ['/api/events', 'App events and their 214 outcome'],
    ['/api/logs', 'Service trace records (newest first)'],
    ['/api/issues', 'Checks raised and stuck items'],
    ['/api/files', 'Local folder counts and rejected files'],
    ['/api/sftp', 'Live listing of the Trinium folders (cached 30 s)'],
    ['/api/health', 'Database connection check']
  ];
  return `
  <div class="page-h"><div><h1>About &amp; health</h1><p>What this dashboard reads, and whether it can reach the database</p></div></div>
  <div class="grid g-2">
    <div class="card"><div class="card-h"><h3>Database</h3></div><div class="card-b">
      ${health.ok ? `<div class="ok-box">Connected to <span class="mono">${esc(health.db?.db)}</span>, schema <span class="mono">${esc(health.db?.schema)}</span></div>`
        : `<div class="err-box">Not connected: ${esc(health.error || 'unknown error')}</div>`}
      <p class="small muted" style="margin-top:12px">All sessions are read-only (<span class="mono">default_transaction_read_only=on</span>), with a 15 s statement timeout.</p>
    </div></div>
    <div class="card"><div class="card-h"><h3>What is shown</h3></div><div class="card-b">
      <ul class="list">
        <li><div class="l"><b>Flow A · Trinium 204 → app</b><div class="small muted">204 received, converted, queued and published to Kafka</div></div></li>
        <li><div class="l"><b>Flow B · app → Trinium 214</b><div class="small muted">Event received, processed, 214 generated, delivered to SFTP</div></div></li>
        <li><div class="l"><b>Logs</b><div class="small muted">Trace files of both services, with every check and full bodies on request</div></div></li>
      </ul>
    </div></div>
  </div>
  <div class="section"><h2>API</h2><span class="rule"></span></div>
  ${table([
    { h: 'Endpoint', f: e => `<span class="mono">${esc(e[0])}</span>` },
    { h: 'Used for', f: e => esc(e[1]) }
  ], endpoints.map(e => e), { empty: '' })}
  <div class="note" style="margin-top:16px">There is no sign-in on this page. It binds to <span class="mono">127.0.0.1</span> by default because it shows order data. Do not expose it without your own access control.</div>`;
};

// ---------- events ----------
main.addEventListener('click', e => {
  const set = e.target.closest('[data-set]');
  if (set) { S[set.dataset.set] = set.dataset.val; render(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { S.detailTab = tab.dataset.tab; render(); return; }
  const stop = e.target.closest('[data-stop]');
  if (stop) { e.stopPropagation(); return; }
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a')) { location.hash = go.dataset.go; return; }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const k = tg.dataset.toggle;
    S.detailOpen = S.detailOpen === k ? null : k;
    render({ keepScroll: true });
  }
});
main.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('tr[data-go]')) location.hash = e.target.dataset.go;
  if (e.key === 'Enter' && e.target.matches('tr[data-toggle]')) { S.detailOpen = S.detailOpen === e.target.dataset.toggle ? null : e.target.dataset.toggle; render({ keepScroll: true }); }
});

let filterTimer = null;
main.addEventListener('input', e => {
  const f = e.target.dataset.filter;
  if (!f) return;
  S[f] = e.target.value;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => render({ keepScroll: true }), 250);
});
main.addEventListener('change', e => {
  const f = e.target.dataset.filter;
  // Text fields re-render from the 'input' handler; a change event fired by the browser when the
  // focused field is replaced must not trigger another render.
  if (f && e.target.tagName !== 'INPUT') {
    S[f] = f === 'ordersLimit' || f === 'ordersHours' ? Number(e.target.value) : e.target.value;
    render({ keepScroll: true });
  }
  if (e.target.dataset.check) { S[e.target.dataset.check] = e.target.checked; render({ keepScroll: true }); }
});

// ---------- header controls ----------
const hoursEl = document.getElementById('hours');
hoursEl.value = String(S.hours);
hoursEl.addEventListener('change', () => { S.hours = Number(hoursEl.value); localStorage.setItem('hours', S.hours); render({ keepScroll: true }); });
document.getElementById('refresh').addEventListener('click', () => render({ keepScroll: true }));

function paintAuto() {
  const btn = document.getElementById('auto');
  btn.setAttribute('aria-pressed', String(S.auto));
  document.getElementById('auto-dot').classList.toggle('live', S.auto);
  document.getElementById('auto-dot').style.background = S.auto ? '' : 'var(--muted)';
  document.getElementById('auto-label').textContent = S.auto ? 'Live' : 'Paused';
}
document.getElementById('auto').addEventListener('click', () => {
  S.auto = !S.auto; localStorage.setItem('auto', S.auto ? 'on' : 'off'); paintAuto();
  if (S.auto) render({ keepScroll: true });
});

function paintTheme() {
  document.documentElement.setAttribute('data-theme', S.theme);
}
document.getElementById('theme').addEventListener('click', () => {
  S.theme = S.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', S.theme); paintTheme();
});
paintTheme(); paintAuto();

function updateBadge() {
  const b = document.getElementById('badge-issues');
  const s = S.summary?.stuck;
  const n = s ? (s.kafkaFailed || 0) + (s.kafkaPending || 0) + (s.sftp_failing || 0) + (s.sftp_pending || 0) + (s.file_pending || 0) : 0;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', `${n} stuck items`);
}

let lastOrder = null;
window.addEventListener('hashchange', () => {
  const r = route();
  S.detailOpen = null;
  if (r.name === 'order' && r.id !== lastOrder) S.detailTab = 'timeline';
  lastOrder = r.name === 'order' ? r.id : null;
  render();
});

// Keep the page fresh without losing the reader's place.
setInterval(() => {
  if (!S.auto || document.hidden) return;
  if (route().name === 'order' && document.activeElement?.closest?.('.tabs')) return;
  render({ keepScroll: true }).then(() => updateBadge()).catch(() => {});
}, 10000);

// Badge needs the summary; fetch it quietly on load and after each overview render.
async function refreshBadge() {
  try { S.summary = await api('summary', { hours: S.hours }); updateBadge(); } catch { /* badge stays as it was */ }
}
setInterval(refreshBadge, 30000);

render().then(refreshBadge);
})();
