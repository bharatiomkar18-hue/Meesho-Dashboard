"use strict";
/* =========================================================================
   APP v3 — hosted, shared dashboard: one upload updates a Netlify Blobs
   store via serverless Functions, and every viewer of this URL fetches the
   same stored dataset. No "download this dashboard" here — the URL itself
   is the shareable artifact. Everything else (tables, conditional
   formatting, drill-down, "Copy for email") is unchanged from the
   client-only build.
   ========================================================================= */
(function(){

  /* ---------- formatting ---------- */
  const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
  const fmtPct = (n, d) => { d = d==null?1:d; return (n==null || isNaN(n) ? '—' : n.toFixed(d) + '%'); };
  const fmtDays = (n) => (n==null || isNaN(n) ? '—' : n.toFixed(2) + 'd');
  const fmtHours = (n) => (n==null || isNaN(n) ? '—' : n.toFixed(1) + 'h');
  const fmtDateTimeLabel = (d) => {
    if (!d) return '—';
    return d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'UTC' }) + ' UTC';
  };
  const fmtDateLabel = (iso) => {
    if (!iso || iso === 'Unknown date') return iso || '—';
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', timeZone:'UTC' });
  };
  function relativeTime(iso){
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (secs < 45) return 'just now';
    if (secs < 3600) return `${Math.round(secs/60)} min ago`;
    if (secs < 86400) return `${Math.round(secs/3600)} hr ago`;
    return fmtDateTimeLabel(d);
  }
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function el(tag, attrs, children){
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs){
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children||[]).forEach(c => e.appendChild(c));
    return e;
  }

  /* Simple 6-tier heat class for pivot tables — relative to the table's own
     max value, so it always spans the visible range instead of a fixed
     absolute scale. 0 stays unstyled. */
  function heatClass(value, max){
    if (!value || !max) return null;
    const r = value / max;
    if (r <= 0.05) return 'cf-heat-1';
    if (r <= 0.2) return 'cf-heat-2';
    if (r <= 0.4) return 'cf-heat-3';
    if (r <= 0.7) return 'cf-heat-4';
    return 'cf-heat-5';
  }

  /* =======================================================================
     DRILL-DOWN — double-click a defect cell/row to reveal its AWB TIDs
     ======================================================================= */
  let drillDownEl = null;
  function onDrillDownKey(ev){ if (ev.key === 'Escape') closeDrillDown(); }
  function closeDrillDown(){
    if (drillDownEl){ drillDownEl.remove(); drillDownEl = null; document.removeEventListener('keydown', onDrillDownKey); }
  }
  function openDrillDown(title, subtitle, awbs){
    closeDrillDown();
    if (!awbs || !awbs.length) return;
    const clean = awbs.map(a => a == null || a === '' ? null : String(a)).filter(Boolean);
    if (!clean.length) return;

    const backdrop = el('div', {class:'drilldown-backdrop'});
    backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) closeDrillDown(); });

    const panel = el('div', {class:'drilldown-panel', role:'dialog', 'aria-modal':'true', 'aria-label':title});
    const head = el('div', {class:'drilldown-head'});
    const headText = el('div', {class:'drilldown-headtext'});
    headText.appendChild(el('h4', {text:title}));
    headText.appendChild(el('div', {class:'drilldown-sub', text:subtitle}));
    head.appendChild(headText);
    const closeBtn = el('button', {class:'drilldown-close', type:'button', 'aria-label':'Close', text:'✕'});
    closeBtn.addEventListener('click', closeDrillDown);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const actions = el('div', {class:'drilldown-actions'});
    actions.appendChild(el('div', {class:'drilldown-count', text:`${clean.length} AWB${clean.length===1?'':'s'}`}));
    const copyBtn = el('button', {class:'btn-copy', type:'button', text:'Copy all TIDs'});
    copyBtn.addEventListener('click', () => {
      const text = clean.join('\n');
      const restore = () => { copyBtn.textContent = 'Copy all TIDs'; };
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(() => { copyBtn.textContent = 'Copied ✓'; setTimeout(restore, 1500); })
          .catch(() => { copyBtn.textContent = 'Copy failed'; setTimeout(restore, 1500); });
      } else { copyBtn.textContent = 'Copy unsupported'; setTimeout(restore, 1500); }
    });
    actions.appendChild(copyBtn);
    panel.appendChild(actions);

    const listWrap = el('div', {class:'drilldown-list-wrap'});
    const list = el('div', {class:'drilldown-list'});
    clean.forEach(awb => list.appendChild(el('div', {class:'drilldown-item', text:awb})));
    listWrap.appendChild(list);
    panel.appendChild(listWrap);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    drillDownEl = backdrop;
    document.addEventListener('keydown', onDrillDownKey);
  }

  /* =======================================================================
     Generic flat table renderer — columns + rows, with conditional
     formatting and per-row / per-cell drill-down.
     ======================================================================= */
  function renderTable(container, columns, rows, opts){
    opts = opts || {};
    container.textContent = '';
    if (!rows.length){ container.appendChild(el('div',{class:'metric-desc',text:'No data in this range.'})); return; }
    const wrap = el('div', {class:'table-scroll'});
    const table = el('table', {class:'datatable'});
    if (opts.caption) table.appendChild(el('caption', {text:opts.caption}));
    const thead = el('thead');
    const trh = el('tr');
    columns.forEach(c => trh.appendChild(el('th', {class:c.num?'num':'', text:c.label})));
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach(r => {
      const tr = el('tr', {class: [
        (opts.flagKey && r[opts.flagKey]) ? 'flagged' : '',
        r.__isTotal ? 'totalrow' : '',
      ].filter(Boolean).join(' ')});
      columns.forEach((c, ci) => {
        const raw = c.get ? c.get(r) : r[c.key];
        const td = el('td', {class:c.num?'num':''});
        td.textContent = raw == null ? '—' : raw;
        if (ci===0 && opts.flagKey && r[opts.flagKey]){
          const b = el('span', {class:'badge badge-flag', text:'▲ flagged'});
          td.appendChild(document.createTextNode(' ')); td.appendChild(b);
        }
        if (c.cf){ const cls = c.cf(r); if (cls) td.classList.add(cls); }
        tr.appendChild(td);
      });
      if (opts.getDrill){
        const d = opts.getDrill(r);
        if (d && d.awbs && d.awbs.length){
          tr.classList.add('rowdrillable');
          tr.addEventListener('dblclick', (ev) => { ev.preventDefault(); openDrillDown(d.title, d.subtitle, d.awbs); });
        }
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  /* =======================================================================
     Pivot table renderer — rows = group label, columns = ordered buckets,
     values = counts, with a heatmap + a bottom Total row + per-cell
     drill-down (via row.defectAwbsByBucket[bucketKey]).
     ======================================================================= */
  function renderPivotTable(container, rows, buckets, totalRow, opts){
    opts = opts || {};
    container.textContent = '';
    if (!rows.length){ container.appendChild(el('div',{class:'metric-desc',text:'No backlog in this range — nothing to show.'})); return; }
    const allValues = [];
    rows.forEach(r => buckets.forEach(b => allValues.push(r[b.key])));
    const max = Math.max(1, ...allValues);
    const wrap = el('div', {class:'table-scroll'});
    const table = el('table', {class:'datatable'});
    const thead = el('thead'); const trh = el('tr');
    trh.appendChild(el('th', {text: opts.groupLabel || 'Station'}));
    buckets.forEach(b => trh.appendChild(el('th', {class:'num', text:b.label})));
    trh.appendChild(el('th', {class:'num', text:'Total'}));
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = el('tbody');
    const buildRow = (rec, isTotal) => {
      const tr = el('tr', {class: isTotal ? 'totalrow' : ''});
      tr.appendChild(el('td', {text: rec.station}));
      buckets.forEach(b => {
        const v = rec[b.key] || 0;
        const td = el('td', {class:'num', text: fmtInt(v)});
        if (!isTotal){
          const cls = heatClass(v, max);
          if (cls) td.classList.add(cls);
          const awbs = rec.defectAwbsByBucket && rec.defectAwbsByBucket[b.key];
          if (awbs && awbs.length){
            td.classList.add('cf-drillable');
            td.addEventListener('dblclick', (ev) => {
              ev.preventDefault();
              openDrillDown(`${rec.station} — ${b.label}`, `${fmtInt(awbs.length)} shipment(s) in this bucket`, awbs);
            });
          }
        }
        tr.appendChild(td);
      });
      tr.appendChild(el('td', {class:'num', text: fmtInt(rec.total)}));
      tbody.appendChild(tr);
    };
    rows.forEach(r => buildRow(r, false));
    if (totalRow) buildRow(totalRow, true);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  /* =======================================================================
     "Copy for email" — unchanged from the client-only build: every table
     here is already plain HTML with inline-able styles.
     ======================================================================= */
  const EMAIL = {
    bg:'#ffffff', surface:'#ffffff', surface2:'#f4f6f9',
    ink:'#1c2430', inkSoft:'#47536a', inkMuted:'#838fa0',
    border:'#e1e6ed', accent:'#2458d6', bad:'#b0221c', badBg:'#fdeaea',
    warn:'#8a6a10', warnBg:'#fff6dd', good:'#1c7a37', goodBg:'#e6f6ea',
    heat:['#ffffff','#fff3d6','#ffdca0','#ffb877','#f2825a','#d95f4a'],
    font:"Arial, Helvetica, sans-serif", mono:"'Courier New', Courier, monospace",
  };

  function cellEmailStyle(td){
    const base = `padding:7px 10px;border-bottom:1px solid ${EMAIL.border};color:${EMAIL.inkSoft};font-family:${td.classList.contains('num')?EMAIL.mono:EMAIL.font};${td.classList.contains('num')?'text-align:right;':''}`;
    if (td.classList.contains('cf-good')) return base + `background:${EMAIL.goodBg};color:${EMAIL.good};font-weight:600;`;
    if (td.classList.contains('cf-warn')) return base + `background:${EMAIL.warnBg};color:${EMAIL.warn};font-weight:600;`;
    if (td.classList.contains('cf-bad') || td.classList.contains('cf-bad-strong')) return base + `background:${EMAIL.badBg};color:${EMAIL.bad};font-weight:700;`;
    for (let i=5;i>=1;i--){
      if (td.classList.contains('cf-heat-'+i)) return base + `background:${EMAIL.heat[i]};${i>=4?'color:#ffffff;font-weight:600;':''}`;
    }
    return base;
  }

  function tableToEmailHtml(table){
    const theadRow = table.querySelector('thead tr');
    const headCells = theadRow ? Array.from(theadRow.children) : [];
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const thStyle = `text-align:left;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:${EMAIL.inkMuted};background:${EMAIL.surface2};padding:8px 10px;border-bottom:1px solid ${EMAIL.border};font-family:${EMAIL.font};`;
    const thStyleNum = thStyle + 'text-align:right;';
    let html = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12.5px;font-family:${EMAIL.font};background:${EMAIL.surface};">`;
    if (headCells.length){
      html += '<thead><tr>' + headCells.map(th => `<th style="${th.classList.contains('num')?thStyleNum:thStyle}">${esc(th.textContent.trim())}</th>`).join('') + '</tr></thead>';
    }
    html += '<tbody>';
    bodyRows.forEach(tr => {
      const flagged = tr.classList.contains('flagged');
      const isTotal = tr.classList.contains('totalrow');
      const rowStyle = flagged ? `border-left:3px solid ${EMAIL.bad};` : (isTotal ? `background:${EMAIL.surface2};font-weight:700;` : '');
      html += `<tr style="${rowStyle}">`;
      Array.from(tr.children).forEach(td => {
        const badge = td.querySelector('.badge-flag');
        let text = '';
        Array.from(td.childNodes).forEach(n => {
          if (n.nodeType === 3) text += n.textContent;
          else if (n.nodeType === 1 && !n.classList.contains('badge-flag')) text += n.textContent;
        });
        html += `<td style="${cellEmailStyle(td)}">${esc(text.trim())}`;
        if (badge) html += ` <span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px;background:${EMAIL.badBg};color:${EMAIL.bad};margin-left:4px;">▲ flagged</span>`;
        html += '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function kpiTableToEmailHtml(table){
    const rows = Array.from(table.querySelectorAll('tr'));
    let html = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;font-family:${EMAIL.font};">`;
    rows.forEach(tr => {
      html += '<tr>';
      Array.from(tr.children).forEach(td => {
        const isName = td.classList.contains('metricname');
        const isVal = td.classList.contains('metricval');
        const pill = td.querySelector('.status-pill');
        let style = `padding:9px 10px;border-bottom:1px solid ${EMAIL.border};font-family:${EMAIL.font};`;
        if (isName) style += `font-weight:600;color:${EMAIL.ink};`;
        if (isVal) style += `font-family:${EMAIL.mono};font-weight:700;text-align:right;color:${EMAIL.ink};`;
        if (!isName && !isVal) style += `color:${EMAIL.inkMuted};font-size:11.5px;`;
        let text = '';
        Array.from(td.childNodes).forEach(n => { if (n.nodeType===3) text += n.textContent; else if (n.nodeType===1 && !n.classList.contains('status-pill')) text += n.textContent; });
        html += `<td style="${style}">${esc(text.trim())}`;
        if (pill){
          let pc = EMAIL.goodBg, ptxt = EMAIL.good;
          if (pill.classList.contains('warn')){ pc = EMAIL.warnBg; ptxt = EMAIL.warn; }
          if (pill.classList.contains('bad')){ pc = EMAIL.badBg; ptxt = EMAIL.bad; }
          html += ` <span style="display:inline-block;font-size:10.5px;font-weight:600;padding:3px 9px;border-radius:99px;background:${pc};color:${ptxt};">${esc(pill.textContent.trim())}</span>`;
        }
        html += '</td>';
      });
      html += '</tr>';
    });
    html += '</table>';
    return html;
  }

  async function sectionToEmailFragment(sectionEl){
    const idxEl = sectionEl.querySelector('.metric-head .idx');
    const titleEl = sectionEl.querySelector('.metric-head h3');
    const title = (idxEl ? idxEl.textContent + ' — ' : '') + (titleEl ? titleEl.textContent : 'Dashboard section');
    const bodyParts = [];
    const children = Array.from(sectionEl.children).flatMap(c => c.id === 'summaryBody' ? Array.from(c.children) : [c]);
    for (const child of children){
      if (child.classList.contains('metric-head')) continue;
      if (child.classList.contains('drill-hint')) continue;
      if (child.id === 'warnArea' && !child.textContent.trim()) continue;
      if (child.classList.contains('metric-desc')){
        bodyParts.push(`<p style="font-size:13px;line-height:1.6;color:${EMAIL.inkSoft};margin:8px 0;font-family:${EMAIL.font};">${esc(child.textContent.trim())}</p>`);
      } else if (child.tagName === 'DETAILS' && child.classList.contains('formula')){
        const box = child.querySelector('.box');
        if (box) bodyParts.push(`<div style="margin:10px 0;background:${EMAIL.surface2};border:1px solid ${EMAIL.border};border-radius:9px;padding:11px 14px;font-size:12px;color:${EMAIL.inkSoft};line-height:1.6;font-family:${EMAIL.font};"><strong style="color:${EMAIL.inkMuted};font-size:11px;text-transform:uppercase;letter-spacing:.04em;">How this is calculated</strong><div style="margin-top:6px;">${box.innerHTML}</div></div>`);
      } else if (child.tagName === 'H4'){
        bodyParts.push(`<div style="font-size:12px;color:${EMAIL.inkMuted};text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px;font-family:${EMAIL.font};">${esc(child.textContent.trim())}</div>`);
      } else if (child.id === 'kpiTable' || (child.querySelector && child.querySelector('table.kpitable'))){
        const kpiT = child.id === 'kpiTable' ? child : child.querySelector('table.kpitable');
        bodyParts.push(kpiTableToEmailHtml(kpiT));
      } else if (child.classList.contains('cf-legend')){
        const items = Array.from(child.querySelectorAll('.item')).map(it => {
          const sw = it.querySelector('.swatch');
          const color = sw ? getComputedStyle(sw).backgroundColor : EMAIL.inkMuted;
          return `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:11px;color:${EMAIL.inkSoft};font-family:${EMAIL.font};"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};border:1px solid rgba(0,0,0,0.08);"></span>${esc(it.textContent.trim())}</span>`;
        });
        bodyParts.push(`<div style="margin:8px 0;">${items.join('')}</div>`);
      } else if (child.classList.contains('subgrid')){
        for (const sub of Array.from(child.children)){
          for (const inner of Array.from(sub.children)){
            if (inner.tagName === 'H4') bodyParts.push(`<div style="font-size:12px;color:${EMAIL.inkMuted};text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px;font-family:${EMAIL.font};">${esc(inner.textContent.trim())}</div>`);
            else { const t = inner.querySelector('table.datatable'); if (t) bodyParts.push(tableToEmailHtml(t)); }
          }
        }
      } else {
        const table = child.querySelector && child.querySelector('table.datatable');
        if (table) bodyParts.push(tableToEmailHtml(table));
      }
    }
    const stamp = new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    return `<div style="background:${EMAIL.bg};padding:20px;border:1px solid ${EMAIL.border};border-radius:12px;max-width:760px;font-family:${EMAIL.font};">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${EMAIL.accent};margin-bottom:4px;">Meesho × ElasticRun — E2E Shipment Ops Dashboard</div>
      <h2 style="font-size:18px;font-weight:700;color:${EMAIL.ink};margin:0 0 10px;font-family:${EMAIL.font};">${esc(title)}</h2>
      ${bodyParts.join('\n')}
      <div style="font-size:10.5px;color:${EMAIL.inkMuted};margin-top:16px;border-top:1px solid ${EMAIL.border};padding-top:10px;">Exported ${esc(stamp)} · from the shared dashboard's current dataset</div>
    </div>`;
  }

  async function copyRichHtmlToClipboard(html, plainText){
    const plain = plainText || html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if (navigator.clipboard && window.ClipboardItem){
      try{
        const item = new ClipboardItem({ 'text/html': new Blob([html], {type:'text/html'}), 'text/plain': new Blob([plain], {type:'text/plain'}) });
        await navigator.clipboard.write([item]);
        return 'rich';
      } catch (e){ console.warn('[copy-for-email] clipboard.write(html) failed:', e && e.name, e && e.message); }
    }
    try{
      const container = document.createElement('div');
      container.setAttribute('contenteditable', 'true');
      container.style.position = 'fixed'; container.style.left = '-99999px'; container.style.top = '0';
      container.innerHTML = html;
      document.body.appendChild(container);
      const range = document.createRange(); range.selectNodeContents(container);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges(); document.body.removeChild(container);
      if (ok) return 'rich';
    } catch (e){ console.warn('[copy-for-email] execCommand(html) failed:', e && e.name, e && e.message); }
    if (navigator.clipboard && navigator.clipboard.writeText){
      try{ await navigator.clipboard.writeText(plain); return 'text'; }
      catch (e){ console.warn('[copy-for-email] clipboard.writeText failed:', e && e.name, e && e.message); }
    }
    try{
      const ta = document.createElement('textarea');
      ta.value = plain; ta.style.position = 'fixed'; ta.style.left = '-99999px'; ta.style.top = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return 'text';
    } catch (e){ console.warn('[copy-for-email] execCommand(text) failed:', e && e.name, e && e.message); }
    return null;
  }

  async function handleCopyForEmail(btn){
    const sectionEl = btn.closest('section.metric');
    if (!sectionEl) return;
    const original = btn.textContent;
    btn.textContent = 'Copying…'; btn.disabled = true;
    let result = null;
    try{ const html = await sectionToEmailFragment(sectionEl); result = await copyRichHtmlToClipboard(html); }
    catch (e){ console.error('[copy-for-email]', e); }
    const labels = { rich: 'Copied ✓ — paste into your email', text: 'Copied as plain text ✓' };
    btn.textContent = result ? labels[result] : 'Copy failed — see console';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, result ? 2600 : 3400);
  }

  /* =======================================================================
     Section shell
     ======================================================================= */
  function sectionShell(id, idx, title, desc, formula){
    const s = el('section', {class:'metric', id});
    const head = el('div', {class:'metric-head'});
    const titleWrap = el('div', {class:'metric-title'});
    titleWrap.appendChild(el('span', {class:'idx', text: idx}));
    titleWrap.appendChild(el('h3', {text:title}));
    head.appendChild(titleWrap);
    head.appendChild(el('button', {class:'btn-emailcopy', type:'button', 'data-copy-section':id, text:'Copy for email'}));
    s.appendChild(head);
    s.appendChild(el('div', {class:'metric-desc', text:desc}));
    const details = el('details', {class:'formula'});
    details.appendChild(el('summary', {text:'How this is calculated'}));
    const box = el('div', {class:'box'});
    box.innerHTML = formula; // static, author-authored copy only — not user data
    details.appendChild(box);
    s.appendChild(details);
    return s;
  }
  function cfLegend(items){
    const wrap = el('div', {class:'cf-legend'});
    items.forEach(it => {
      const item = el('div', {class:'item'});
      item.appendChild(el('span', {class:'swatch', style:`background:${it.color}`}));
      item.appendChild(document.createTextNode(it.label));
      wrap.appendChild(item);
    });
    return wrap;
  }

  /* =======================================================================
     Shared-dataset transport — GET/POST to the Netlify Functions backend.
     Dates don't survive JSON as-is, so rows are serialized to ISO strings
     on the way out and parsed back to Date objects on the way in.
     ======================================================================= */
  const DATE_FIELDS = ['manifested','pickedUp','networkArrival','rad','outForDelivery','delivered',
    'firstAttempt','secondAttempt','thirdAttempt','rtoInitiate','rtoDelivered','deliverySlotEnd',
    'lastCheckpoint','reportModified'];

  function serializeRowsForUpload(rows){
    return rows.map(r => {
      const out = {};
      for (const k in r){
        const v = r[k];
        out[k] = DATE_FIELDS.indexOf(k) !== -1 ? (v instanceof Date ? v.toISOString() : null) : v;
      }
      return out;
    });
  }
  function deserializeSharedRows(rows){
    return rows.map(r => {
      const out = {};
      for (const k in r){
        const v = r[k];
        out[k] = DATE_FIELDS.indexOf(k) !== -1 ? (v ? new Date(v) : null) : v;
      }
      return out;
    });
  }

/* -----------------------------------------------------------------------
     Gzip helpers -- large reports (tens of thousands of rows) can produce a
          JSON payload bigger than Netlify Functions' ~6 MB request/response
               limit. Rather than fight binary-body proxy quirks, both directions use
                    a plain-text envelope: { gzipBase64: "<base64 of gzip bytes>" }. That's
                         valid JSON either way, so it's always safe to send/receive as text.
                              Uses the browser's native CompressionStream/DecompressionStream (no
                                   external library, no build step) -- supported in all current Chrome,
                                        Edge, Firefox and Safari. Falls back to plain JSON if unsupported,
                                             which still works for smaller reports.
                                                  ----------------------------------------------------------------------- */
     const CAN_COMPRESS = typeof CompressionStream !== 'undefined';
     const CAN_DECOMPRESS = typeof DecompressionStream !== 'undefined';

     function bytesToBase64(bytes){
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk){
                     binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return btoa(binary);
     }
     function base64ToBytes(b64){
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
     }
     async function gzipBase64JSON(obj){
            const json = JSON.stringify(obj);
            if (!CAN_COMPRESS) return { body: json, gzipped: false };
            const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            return { body: JSON.stringify({ gzipBase64: bytesToBase64(bytes) }), gzipped: true };
     }
     async function gunzipBase64JSON(b64){
            if (!CAN_DECOMPRESS){
                     throw new Error('This browser can\'t decompress the shared dataset -- please use a current version of Chrome, Edge, Firefox, or Safari.');
            }
            const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
            const text = await new Response(stream).text();
            return JSON.parse(text);
     }

     async function apiGetSharedData(){
            const res = await fetch('/api/data', { headers: { 'Accept': 'application/json' } });
            let body;
            try{ body = await res.json(); } catch(e){ throw new Error('The server sent back something that wasn\'t valid JSON.'); }
            if (!res.ok) throw new Error(body && body.error ? body.error : `Server returned ${res.status}`);
            if (body && typeof body.gzipBase64 === 'string') body = await gunzipBase64JSON(body.gzipBase64);
            return body;
     }
     async function apiUpload(password, fileName, missingColumns, rows){
            const { body: reqBody } = await gzipBase64JSON({ password, fileName, missingColumns, rows: serializeRowsForUpload(rows) });
            const res = await fetch('/api/upload', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: reqBody,
            });
            let body;
            try{ body = await res.json(); } catch(e){ body = null; }
            if (!res.ok){
                     const msg = body && body.error ? body.error : `Server returned ${res.status}`;
                     const err = new Error(msg); err.status = res.status; throw err;
            }
            return body;
     }

  /* =======================================================================
     Sync status chip — transient feedback for load/refresh/upload.
     ======================================================================= */
  let syncChipTimer = null;
  function setSyncChip(text, kind, autoHideMs){
    const chip = document.getElementById('syncChip');
    if (syncChipTimer){ clearTimeout(syncChipTimer); syncChipTimer = null; }
    if (!text){ chip.hidden = true; return; }
    chip.hidden = false;
    chip.className = 'sync-chip ' + (kind || 'busy');
    chip.textContent = text;
    if (autoHideMs){ syncChipTimer = setTimeout(() => { chip.hidden = true; }, autoHideMs); }
  }

  /* =======================================================================
     Main app state
     ======================================================================= */
  const state = { header:null, allRows:[], missingColumns:[], dataMax:null, dataMin:null, referenceTime:null, fmList:[], lmList:[], sharedFileName:null, sharedUploadedAt:null };
  let pendingUpload = null; // { fileName, header, rows, missingColumns } awaiting password confirmation
  function uniqueSorted(arr){ return Array.from(new Set(arr.filter(Boolean))).sort(); }
  function ymd(d){ return d.toISOString().slice(0,10); }

  function readWorkbook(file){
    const isCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        let wb;
        if (isCsv){ wb = XLSX.read(e.target.result, {type:'binary'}); }
        else { wb = XLSX.read(e.target.result, {type:'array'}); }
        let sheetName = wb.SheetNames.find(n => /query result/i.test(n)) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false});
        if (!aoa.length) throw new Error('empty sheet');
        const header = aoa[0].map(h => h == null ? '' : String(h).trim());
        const rawRows = aoa.slice(1);
        const { rows, missingColumns } = Engine.normalizeRows(header, rawRows);
        pendingUpload = { fileName: file.name, header, rows, missingColumns };
        openPasswordModal();
      } catch (err){
        console.error(err);
        alert('Could not read this file — make sure it is the "Query result" sheet from the 4500 report (xlsx or csv).');
      }
    };
    if (isCsv) reader.readAsBinaryString(file); else reader.readAsArrayBuffer(file);
  }

  /* applyDataset renders a dataset (whether just fetched from the shared
     store, or freshly confirmed-and-uploaded by this viewer) into the UI. */
  function applyDataset(fileName, header, rows, missingColumns, uploadedAt){
    state.header = header; state.allRows = rows; state.missingColumns = missingColumns || [];
    state.sharedFileName = fileName; state.sharedUploadedAt = uploadedAt || null;
    const manifestDates = rows.map(r=>r.manifested).filter(Boolean);
    state.dataMin = manifestDates.length ? new Date(Math.min(...manifestDates.map(d=>d.getTime()))) : null;
    state.dataMax = manifestDates.length ? new Date(Math.max(...manifestDates.map(d=>d.getTime()))) : null;
    const modifiedDates = rows.map(r=>r.reportModified).filter(Boolean);
    state.referenceTime = modifiedDates.length ? new Date(Math.max(...modifiedDates.map(d=>d.getTime()))) : null;
    state.fmList = uniqueSorted(rows.map(r=>r.fmStation));
    state.lmList = uniqueSorted(rows.map(r=>r.lmStation));

    document.getElementById('loadingState').hidden = true;
    document.getElementById('emptyState').hidden = true;
    document.getElementById('topbar').hidden = false;
    document.getElementById('dashboardBody').hidden = false;
    document.getElementById('fileNameLbl').textContent = fileName || 'Shared report';
    document.getElementById('fileMetaLbl').textContent = uploadedAt
      ? `${fmtInt(rows.length)} rows · shared ${relativeTime(uploadedAt)}`
      : `${fmtInt(rows.length)} rows`;
    document.getElementById('fileChip').hidden = false;

    const fmSel = document.getElementById('fmFilter'), lmSel = document.getElementById('lmFilter');
    fmSel.textContent = ''; fmSel.appendChild(el('option',{value:'',text:'All FM stations'}));
    state.fmList.forEach(s => fmSel.appendChild(el('option',{value:s,text:s})));
    lmSel.textContent = ''; lmSel.appendChild(el('option',{value:'',text:'All LM stations'}));
    state.lmList.forEach(s => lmSel.appendChild(el('option',{value:s,text:s})));

    document.getElementById('dateFrom').value = state.dataMin ? ymd(state.dataMin) : '';
    document.getElementById('dateTo').value = state.dataMax ? ymd(state.dataMax) : '';
    document.querySelectorAll('.pill').forEach(p=>p.classList.toggle('active', p.dataset.range==='all'));

    renderWarnings();
    buildSections();
    recompute();
  }

  async function loadSharedData(isRefresh){
    if (isRefresh) setSyncChip('↻ Refreshing…', 'busy');
    else {
      document.getElementById('loadingState').hidden = false;
      document.getElementById('emptyState').hidden = true;
      document.getElementById('dashboardBody').hidden = true;
    }
    try{
      const data = await apiGetSharedData();
      document.getElementById('loadingState').hidden = true;
      if (!data || data.empty){
        document.getElementById('emptyState').hidden = false;
        document.getElementById('topbar').hidden = false;
        if (isRefresh) setSyncChip('No shared data yet', 'warn', 3000);
        return;
      }
      const rows = deserializeSharedRows(data.rows || []);
      applyDataset(data.fileName, data.header || null, rows, data.missingColumns || [], data.uploadedAt);
      if (isRefresh) setSyncChip('✓ Up to date', 'ok', 2200);
    } catch (err){
      console.error('[shared-data] load failed:', err);
      document.getElementById('loadingState').hidden = true;
      if (!isRefresh){
        document.getElementById('emptyState').hidden = false;
        document.getElementById('topbar').hidden = false;
        const box = el('div', {style:'margin-top:14px;background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-text);border-radius:10px;padding:11px 14px;font-size:12.5px;line-height:1.6;'});
        box.appendChild(el('strong', {text:'Couldn\'t reach the shared dashboard service: '}));
        box.appendChild(document.createTextNode(String(err.message || err) + '. You can still upload a file to preview it in this tab — it just won\'t be saved for others until the service is reachable.'));
        const empty = document.getElementById('emptyState');
        const existing = empty.querySelector('.req'); // insert before the column-requirements box
        empty.insertBefore(box, existing);
      } else {
        setSyncChip('Couldn\'t refresh — ' + (err.message || err), 'bad', 4000);
      }
    }
  }

  function renderWarnings(){
    const area = document.getElementById('warnArea');
    area.textContent = '';
    if (!state.missingColumns.length) return;
    const nice = {
      manifested:'Manifested Date', networkArrival:'Network Arrival Date', status:'Status',
      pickedUp:'Picked-up Date and Time', rad:'RAD Date and Time', outForDelivery:'First Out On Road Date',
      fwdAttemptCount:'Forward Attempted Count', delivered:'Delivered Date', firstAttemptDate:'First Attempt Date',
      secondAttemptDate:'Second Attempt Date', thirdAttemptDate:'Third Attempt Date', rtoInitiate:'RTO Intitate Date',
      rtoDelivered:'RTO Delivered Date', fmStation:'First Mile Station', fmStationName:'FM Station Name',
      lmStation:'Last Mile Station', lmStationName:'LM Station Name', deliverySlotEnd:'Delivery Slot End Timestamp',
      awb:'AWB No', paymentMethod:'Payment Method', currentStation:'Current Station',
      currentStationName:'Current Station Facility Name', inTransitTime:'In Transit Time', reportModified:'modified',
    };
    const box = el('div', {style:'background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-text);border-radius:10px;padding:11px 14px;font-size:12.5px;line-height:1.6;'});
    box.appendChild(el('strong', {text:'Some expected columns were not found: '}));
    box.appendChild(document.createTextNode(state.missingColumns.map(k=>nice[k]||k).join(', ') + '. Metrics using them may be incomplete.'));
    area.appendChild(box);
  }

  /* =======================================================================
     Section content builders
     ======================================================================= */
  function buildSections(){
    const wrap = document.getElementById('metricSections');
    wrap.textContent = '';

    const s1 = sectionShell('m1','01','Pickup Efficiency','How long shipments sit between manifest and physical pickup, split into four speed bands, shown day by day. Defect = the > 36h band.',
      'Bucket = <code>Picked-up Date and Time − Manifested Date</code>, in hours, per shipment. Buckets: <code>&lt;12h</code>, <code>12–24h</code>, <code>24–36h</code>, <code>&gt;36h</code> (defect). Shipments manifested but not yet picked up sit in <strong>Not picked up yet</strong> (also shown, not counted as a &gt;36h defect). Grouped by Manifested Date.');
    s1.appendChild(cfLegend([{color:'var(--warn-bg)',label:'>36h present, low share'},{color:'var(--bad-bg)',label:'>36h moderate share'},{color:'var(--bad-strong-bg)',label:'>36h high share'}]));
    s1.appendChild(el('div', {class:'drill-hint', text:'Double-click a date row to see the >36h shipment TIDs.'}));
    s1.appendChild(el('div', {id:'m1-table'}));
    wrap.appendChild(s1);

    const s2 = sectionShell('m2','02','Connections from FM %','Of shipments already picked up, what share have moved beyond the pickup step — to Vehicle In Transit, Arrival, Depart Facility, Delivered, etc. Defect = the complement: still sitting at the FM hub, not connected ahead.',
      'Denominator = shipments with a <code>Picked-up Date and Time</code>. Numerator = the subset whose <code>Status</code> is no longer a pickup-stage status (<code>Created</code>, <code>Facility Assigned</code>, <code>Manage Schedule</code>, <code>Pickup Initiated/Attempted/Done</code>) — i.e. it has moved to <code>In Vehicle Transit</code>, <code>Arrival</code>, <code>Depart Facility</code>, <code>Delivered</code>, <code>COD*</code>, etc. A station/date is <strong>flagged</strong> when its still-at-FM count exceeds <code id="m2-threshold">0.5%</code> of total picked-up volume — same population as Picked Up Pendency (03), viewed from the other side.');
    s2.appendChild(el('div', {id:'m2-table'}));
    s2.appendChild(el('h4', {class:'subhead', text:'By Manifested Date'}));
    s2.appendChild(el('div', {id:'m2-date-table'}));
    wrap.appendChild(s2);

    const s3 = sectionShell('m3','03','Picked Up Pendency','Shipments already picked up that have not moved to the next status — the mirror image of Connections from FM.',
      'Same pickup-stage <code>Status</code> test as Connections from FM, inverted. A station/date is <strong>flagged</strong> when its pending count exceeds <code id="m3-threshold">0.5%</code> of the total picked-up volume in the current filter — not 0.5% of that group\'s own volume.');
    s3.appendChild(el('div', {id:'m3-summary', class:'metric-desc', style:'margin-top:6px;'}));
    s3.appendChild(el('div', {class:'drill-hint', text:'Double-click a flagged row to see the pending shipment TIDs.'}));
    s3.appendChild(el('div', {id:'m3-table'}));
    s3.appendChild(el('h4', {class:'subhead', text:'By Manifested Date'}));
    s3.appendChild(el('div', {id:'m3-date-table'}));
    wrap.appendChild(s3);

    const s4 = sectionShell('m4','04','FDDS — First Day Delivery Success','Of shipments sent out for delivery, what share were delivered that same calendar day — split Prepaid vs COD, tracked Last Mile Station wise and Delivery End Slot wise.',
      'Denominator = shipments with a <code>First Out On Road Date</code>. Numerator = the subset with a <code>Delivered Date</code> on the same calendar day. Split by <code>Payment Method</code> since COD needs cash collection at the door and converts differently. Rows sorted worst-first by overall FDDS%.');
    s4.appendChild(cfLegend([{color:'var(--bad-bg)',label:'FDDS < 60%'},{color:'var(--warn-bg)',label:'60–80%'},{color:'var(--good-bg)',label:'≥ 80%'}]));
    s4.appendChild(el('h4', {class:'subhead', text:'By Last Mile Station'}));
    s4.appendChild(el('div', {id:'m4-table'}));
    s4.appendChild(el('h4', {class:'subhead', text:'By Delivery End Slot'}));
    s4.appendChild(el('div', {id:'m4-slot-table'}));
    wrap.appendChild(s4);

    const s5 = sectionShell('m5','05','Pickup → RAD Speed','Days from pickup to reaching the destination (Last Mile) station — a measure of mid-mile transit health. Defect = crossing 24 hours.',
      'Days = <code>RAD Date and Time − Picked-up Date and Time</code>. A shipment is a defect if that gap exceeds <code id="m5-threshold">24 hours</code>. Grouped by Last Mile Station, worst (highest defect %) first.');
    s5.appendChild(cfLegend([{color:'var(--warn-bg)',label:'Some over 24h'},{color:'var(--bad-bg)',label:'Moderate share over 24h'},{color:'var(--bad-strong-bg)',label:'High share over 24h'}]));
    s5.appendChild(el('div', {class:'drill-hint', text:'Double-click a flagged row to see the shipment TIDs.'}));
    s5.appendChild(el('div', {id:'m5-table'}));
    wrap.appendChild(s5);

    const s6 = sectionShell('m6','06','Pickup → Customer Speed','Days from pickup to actual delivery, Last Mile Station wise. Defect = delivered later than 7 days, OR still undelivered and already past 7 days since pickup.',
      'Avg days = <code>Delivered Date − Picked-up Date and Time</code> for delivered shipments. "Late delivered" = delivered but took more than <code id="m6-threshold">7 days</code>. "Still pending &gt;7d" = not yet delivered (and not a terminal/closed status) with more than 7 days already elapsed since pickup, measured against this file\'s own freshness timestamp so the number is reproducible.');
    s6.appendChild(cfLegend([{color:'var(--warn-bg)',label:'Some defects'},{color:'var(--bad-bg)',label:'Moderate defect share'},{color:'var(--bad-strong-bg)',label:'High defect share'}]));
    s6.appendChild(el('div', {class:'drill-hint', text:'Double-click a flagged row to see the shipment TIDs.'}));
    s6.appendChild(el('div', {id:'m6-table'}));
    wrap.appendChild(s6);

    const s7 = sectionShell('m7','07','ZRTO %','Shipments returned to origin without a single delivery attempt ever made, by Last Mile Station. Defect = a station\'s ZRTO count exceeding 0.2% of total shipments.',
      'Numerator = shipments with an <code>RTO Intitate/Delivered Date</code> AND zero delivery attempts (<code>First/Second/Third Attempt Date</code> all blank and <code>Forward Attempted Count</code> = 0). "% of total shipments" is compared against the <code id="m7-threshold">0.2%</code> flag threshold — deliberately the grand total, not that station\'s own volume, so a small station can\'t hide a real problem.');
    s7.appendChild(el('div', {class:'drill-hint', text:'Double-click a flagged row to see the ZRTO shipment TIDs.'}));
    s7.appendChild(el('div', {id:'m7-table'}));
    wrap.appendChild(s7);

    const s8 = sectionShell('m8','08','RTO %','Shipments that failed delivery and were returned to origin, by Last Mile Station. Defect = a station\'s own RTO% exceeding 15%.',
      'Numerator = shipments with an <code>RTO Intitate/Delivered Date</code> (regardless of attempts made). Denominator = total shipments at that Last Mile Station. Flag threshold: <code id="m8-threshold">15%</code> of the station\'s own volume. ZRTO (07) is the zero-attempt subset of this.');
    s8.appendChild(cfLegend([{color:'var(--warn-bg)',label:'10–15% (approaching)'},{color:'var(--bad-strong-bg)',label:'> 15% (flagged)'}]));
    s8.appendChild(el('div', {class:'drill-hint', text:'Double-click a flagged row to see the RTO shipment TIDs.'}));
    s8.appendChild(el('div', {id:'m8-table'}));
    wrap.appendChild(s8);

    const s9 = sectionShell('m9','09','Shipment Life Cycle','Shipments that have not yet reached a terminal status (Delivered, Lost, RTO Delivered, COD Reconciled/Collected, Cash Collected, COD Deposited, Pending COD Clearance, Cash Handover — plus Cancelled), and have actually started their journey — how long they\'ve been aging since Network Arrival, split Forward vs Reverse (RTO) flow, by Current Station.',
      'Eligible = any shipment whose <code>Status</code> is not one of the terminal statuses listed above, and also not <code>Pickup Initiated</code>, <code>Pickup Attempted</code>, or <code>Facility Assigned</code> (excluded — these haven\'t started their journey yet, so they aren\'t "stuck"). Shipments with no resolvable Current Station (shown elsewhere as "Unknown station") are excluded from this table entirely, since there\'s no station to act on. Age = <code id="m9-asof">reference time</code> − <code>Network Arrival Date</code> (falls back to <code>Manifested Date</code> if that\'s blank). <strong>Reverse</strong> = shipment has an <code>RTO Intitate/Delivered Date</code> or status <code>Ready For Return</code>; everything else eligible is <strong>Forward</strong>. Bucketed: &lt;3d, 3–5d, 5–10d, 10–15d, 15–30d, &gt;30d. Cell shading is relative to this table\'s own busiest cell — darker = more shipments stuck that long at that station.');
    s9.appendChild(cfLegend([{color:'var(--heat-1)',label:'few'},{color:'var(--heat-3)',label:'moderate'},{color:'var(--heat-5)',label:'most backlogged'}]));
    s9.appendChild(el('div', {class:'drill-hint', text:'Double-click a cell to see the shipment TIDs in that bucket.'}));
    s9.appendChild(el('div', {id:'m9-summary', class:'metric-desc', style:'margin-top:6px;'}));
    s9.appendChild(el('h4', {class:'subhead', text:'Forward'}));
    s9.appendChild(el('div', {id:'m9-forward-table'}));
    s9.appendChild(el('h4', {class:'subhead', text:'Reverse (RTO flow)'}));
    s9.appendChild(el('div', {id:'m9-reverse-table'}));
    wrap.appendChild(s9);

    const s10 = sectionShell('m10','10','DWELL','Non-terminal shipments sitting at their current station without any recorded action, excluding shipments still at their First Mile station or with no resolvable current station, bucketed by how many hours/days it has been since their last tracking scan.',
      'Eligible = any non-terminal shipment (same terminal-status list as Shipment Life Cycle) whose Current Station is <em>not</em> its First Mile station — i.e. it has already left FM — and whose Current Station is known (shipments that would otherwise show as "Unknown station" are excluded entirely, since there\'s no station to act on). Hours = <code id="m10-asof">reference time</code> − <code>In Transit Time</code> (falls back to <code>modified</code>). A shipment dwelling at its Last Mile station, or anywhere mid-network, still counts. Bucketed: &lt;24h, 1–2d, 2–3d, 3–5d, 5–10d, &gt;10d. Grouped by Current Station.');
    s10.appendChild(cfLegend([{color:'var(--heat-1)',label:'few'},{color:'var(--heat-3)',label:'moderate'},{color:'var(--heat-5)',label:'most dwelling'}]));
    s10.appendChild(el('div', {class:'drill-hint', text:'Double-click a cell to see the shipment TIDs in that bucket.'}));
    s10.appendChild(el('div', {id:'m10-summary', class:'metric-desc', style:'margin-top:6px;'}));
    s10.appendChild(el('div', {id:'m10-table'}));
    wrap.appendChild(s10);
  }

  /* =======================================================================
     KPI overview table
     ======================================================================= */
  function statusPill(status){
    const label = status==='ok' ? 'OK' : status==='warn' ? 'Watch' : 'Flagged';
    return el('span', {class:'status-pill '+status, text:label});
  }
  function kpiRow(name, value, sub, status){
    const tr = el('tr');
    tr.appendChild(el('td', {class:'metricname', text:name}));
    tr.appendChild(el('td', {class:'metricval', text:value}));
    const subTd = el('td', {class:'metricsub'});
    subTd.appendChild(statusPill(status));
    if (sub){ subTd.appendChild(document.createTextNode('  ')); subTd.appendChild(document.createTextNode(sub)); }
    tr.appendChild(subTd);
    return tr;
  }
  function bandStatus(value, warnAt, badAt, higherIsWorse){
    if (value == null || isNaN(value)) return 'ok';
    if (higherIsWorse === false){
      if (value >= warnAt) return 'ok';
      if (value >= badAt) return 'warn';
      return 'bad';
    }
    if (value <= warnAt) return 'ok';
    if (value <= badAt) return 'warn';
    return 'bad';
  }

  function renderOverview(rows, c){
    const table = document.getElementById('kpiTable');
    table.textContent = '';
    const eff = c.pickupEfficiency;
    table.appendChild(kpiRow('01 · Pickup Efficiency (>36h)', fmtPct(eff.totalDefectPct,2), `${fmtInt(eff.totalDefect)} of ${fmtInt(eff.totalManifested)} manifested`, bandStatus(eff.totalDefectPct, 5, 15)));
    const pp = c.pickupProgress;
    table.appendChild(kpiRow('02 · Connections from FM', fmtPct(pp.totalConnectedPct), `${fmtInt(pp.totalConnected)} of ${fmtInt(pp.totalPickedUp)} picked up`, bandStatus(pp.totalConnectedPct, 99, 95, false)));
    table.appendChild(kpiRow('03 · Picked Up Pendency', fmtPct(pp.totalPendingPct,2), `flag > ${pp.thresholdPct}% of total picked up`, pp.totalPendingPct > pp.thresholdPct ? 'bad' : 'ok'));
    const fddsAgg = c.fdds.byStation.reduce((a,r)=>{a.sent+=r.sentOut;a.del+=r.deliveredSameDay;return a;},{sent:0,del:0});
    const fddsPct = fddsAgg.sent ? (fddsAgg.del/fddsAgg.sent)*100 : 0;
    table.appendChild(kpiRow('04 · FDDS (same-day)', fmtPct(fddsPct), `${fmtInt(fddsAgg.del)} of ${fmtInt(fddsAgg.sent)} sent out`, bandStatus(fddsPct, 80, 60, false)));
    const radAgg = c.pickupToRad.rows.reduce((a,r)=>{a.count+=r.count;a.over+=r.over;return a;},{count:0,over:0});
    const radOverPct = radAgg.count?(radAgg.over/radAgg.count)*100:0;
    table.appendChild(kpiRow('05 · Pickup → RAD (>24h)', fmtPct(radOverPct,2), `${fmtInt(radAgg.over)} of ${fmtInt(radAgg.count)} shipments`, bandStatus(radOverPct, 5, 15)));
    const custAgg = c.pickupToCustomer.rows.reduce((a,r)=>{a.defects+=r.totalDefects;a.pop+=r.delivered;return a;},{defects:0,pop:0});
    const custDefectPct = custAgg.pop?(custAgg.defects/custAgg.pop)*100:0;
    table.appendChild(kpiRow('06 · Pickup → Customer (>7d)', fmtInt(custAgg.defects), 'late delivered + still-pending shipments', bandStatus(custDefectPct, 5, 15)));
    const rtoAgg = c.rto.rows.reduce((a,r)=>{a.total+=r.total;a.rto+=r.rto;a.zrto+=r.zrto;return a;},{total:0,rto:0,zrto:0});
    const zrtoPctOfTotal = rtoAgg.total?(rtoAgg.zrto/rtoAgg.total)*100:0;
    table.appendChild(kpiRow('07 · ZRTO %', fmtPct(zrtoPctOfTotal,2), `flag > ${c.rto.zrtoThresholdPctOfTotal}% of total shipments`, bandStatus(zrtoPctOfTotal, c.rto.zrtoThresholdPctOfTotal*0.6, c.rto.zrtoThresholdPctOfTotal)));
    const rtoPct = rtoAgg.total?(rtoAgg.rto/rtoAgg.total)*100:0;
    table.appendChild(kpiRow('08 · RTO %', fmtPct(rtoPct,2), `flag per-station > ${c.rto.rtoThresholdPct}%`, bandStatus(rtoPct, 10, c.rto.rtoThresholdPct)));
    const lc = c.lifecycle;
    const over30 = lc.forward.concat(lc.reverse).reduce((s,r)=>s+r['>30d'],0);
    const over30Pct = lc.grandTotal ? (over30/lc.grandTotal)*100 : 0;
    table.appendChild(kpiRow('09 · Shipment Life Cycle backlog', fmtInt(lc.grandTotal), `${fmtPct(over30Pct,1)} aged over 30 days`, bandStatus(over30Pct, 5, 15)));
    const dw = c.dwell;
    const dwOver10 = dw.total['>10d'] || 0;
    const dwOver10Pct = dw.total.total ? (dwOver10/dw.total.total)*100 : 0;
    table.appendChild(kpiRow('10 · DWELL backlog', fmtInt(dw.total.total), `${fmtPct(dwOver10Pct,1)} dwelling over 10 days`, bandStatus(dwOver10Pct, 5, 15)));
  }

  /* =======================================================================
     Per-metric renderers
     ======================================================================= */
  function renderMetrics(rows, c){
    renderOverview(rows, c);

    renderTable(document.getElementById('m1-table'),
      [ {label:'Date', get:r=>fmtDateLabel(r.date)}, {label:'Manifested', num:true, get:r=>fmtInt(r.total)},
        {label:'<12h', num:true, get:r=>`${fmtInt(r['<12h'])} (${fmtPct(r.pct['<12h'])})`},
        {label:'12–24h', num:true, get:r=>`${fmtInt(r['12-24h'])} (${fmtPct(r.pct['12-24h'])})`},
        {label:'24–36h', num:true, get:r=>`${fmtInt(r['24-36h'])} (${fmtPct(r.pct['24-36h'])})`},
        {label:'>36h (defect)', num:true, get:r=>`${fmtInt(r['>36h'])} (${fmtPct(r.pct['>36h'])})`,
          cf:r=>{ const p=r.pct['>36h']; if(!r['>36h']) return null; if(p<=10) return 'cf-warn'; if(p<=25) return 'cf-bad'; return 'cf-bad-strong'; } },
        {label:'Not picked up', num:true, get:r=>`${fmtInt(r['Not picked up'])} (${fmtPct(r.pct['Not picked up'])})`},
      ], c.pickupEfficiency.rows, {caption:'One row per manifested date.',
        getDrill:r=> (r.defectAwbs && r.defectAwbs.length) ? { title:`Pickup Efficiency >36h — ${fmtDateLabel(r.date)}`, subtitle:`${fmtInt(r.defectAwbs.length)} shipment(s) took longer than 36h to be picked up`, awbs:r.defectAwbs } : null });

    document.querySelectorAll('#m2-threshold').forEach(n=>n.textContent = c.pickupProgress.thresholdPct+'%');
    const m2Cols = [ {label:'First Mile Station', get:r=>r.fmStation}, {label:'Picked up', num:true, get:r=>fmtInt(r.pickedUp)},
      {label:'Connected', num:true, get:r=>fmtInt(r.connected)},
      {label:'Connected %', num:true, get:r=>fmtPct(r.connectedPct), cf:r=>r.pickedUp?(r.connectedPct>=99?'cf-good':r.connectedPct>=95?'cf-warn':'cf-bad'):null},
      {label:'Still at FM', num:true, get:r=>`${fmtInt(r.pending)} (${fmtPct(r.pendingPctOfTotalPickedUp,2)})`} ];
    renderTable(document.getElementById('m2-table'), m2Cols, c.pickupProgress.byStation, {flagKey:'flagged',
      getDrill:r=> (r.defectAwbs && r.defectAwbs.length) ? { title:`Still at FM — ${r.fmStation}`, subtitle:`${fmtInt(r.defectAwbs.length)} shipment(s) picked up but not moved past pickup`, awbs:r.defectAwbs } : null });
    renderTable(document.getElementById('m2-date-table'),
      [ {label:'Date', get:r=>fmtDateLabel(r.date)}, {label:'Picked up', num:true, get:r=>fmtInt(r.pickedUp)},
        {label:'Connected %', num:true, get:r=>fmtPct(r.connectedPct), cf:r=>r.pickedUp?(r.connectedPct>=99?'cf-good':r.connectedPct>=95?'cf-warn':'cf-bad'):null} ],
      c.pickupProgress.byDate, {flagKey:'flagged'});

    document.querySelectorAll('#m3-threshold').forEach(n=>n.textContent = c.pickupProgress.thresholdPct+'%');
    document.getElementById('m3-summary').textContent = `${fmtInt(c.pickupProgress.totalPending)} of ${fmtInt(c.pickupProgress.totalPickedUp)} picked-up shipments (${fmtPct(c.pickupProgress.totalPendingPct,2)}) have not moved past pickup.`;
    const m3Cols = [ {label:'First Mile Station', get:r=>r.fmStation}, {label:'Picked up', num:true, get:r=>fmtInt(r.pickedUp)},
      {label:'Pending', num:true, get:r=>fmtInt(r.pending)}, {label:'% of station', num:true, get:r=>fmtPct(r.pendingPctOfGroup,2)},
      {label:'% of total picked up', num:true, get:r=>fmtPct(r.pendingPctOfTotalPickedUp,2), cf:r=>r.flagged?'cf-bad':(r.pending===0?'cf-good':null)} ];
    renderTable(document.getElementById('m3-table'), m3Cols, c.pickupProgress.byStation, {flagKey:'flagged',
      getDrill:r=> (r.defectAwbs && r.defectAwbs.length) ? { title:`Picked Up Pendency — ${r.fmStation}`, subtitle:`${fmtInt(r.defectAwbs.length)} shipment(s) picked up but not moved past pickup`, awbs:r.defectAwbs } : null });
    renderTable(document.getElementById('m3-date-table'),
      [ {label:'Date', get:r=>fmtDateLabel(r.date)}, {label:'Picked up', num:true, get:r=>fmtInt(r.pickedUp)},
        {label:'Pending', num:true, get:r=>fmtInt(r.pending)},
        {label:'% of total picked up', num:true, get:r=>fmtPct(r.pendingPctOfTotalPickedUp,2), cf:r=>r.flagged?'cf-bad':null} ],
      c.pickupProgress.byDate, {flagKey:'flagged',
        getDrill:r=> (r.defectAwbs && r.defectAwbs.length) ? { title:`Picked Up Pendency — ${fmtDateLabel(r.date)}`, subtitle:`${fmtInt(r.defectAwbs.length)} shipment(s) picked up but not moved past pickup`, awbs:r.defectAwbs } : null });

    const paymentTypes = c.fdds.typesPresent && c.fdds.typesPresent.length ? c.fdds.typesPresent : ['Prepaid','COD'];
    const fddsCf = r => r.fddsPct < 60 ? 'cf-bad' : r.fddsPct < 80 ? 'cf-warn' : 'cf-good';
    const m4Columns = [ {label:'Last Mile Station', get:r=>r.lmStation}, {label:'Sent out', num:true, get:r=>fmtInt(r.sentOut)},
        {label:'Delivered same day', num:true, get:r=>fmtInt(r.deliveredSameDay)}, {label:'Overall FDDS %', num:true, get:r=>fmtPct(r.fddsPct), cf:fddsCf} ];
    paymentTypes.forEach(t => {
      m4Columns.push({label:`${t} sent out`, num:true, get:r=>fmtInt(r[t].sentOut)});
      m4Columns.push({label:`${t} FDDS %`, num:true, get:r=>fmtPct(r[t].fddsPct), cf:r=>{ const v=r[t].fddsPct; return v<60?'cf-bad':v<80?'cf-warn':'cf-good'; }});
    });
    renderTable(document.getElementById('m4-table'), m4Columns, c.fdds.byStation, {});
    const m4SlotColumns = [ {label:'Slot (end time)', get:r=>r.slot}, {label:'Sent out', num:true, get:r=>fmtInt(r.sentOut)}, {label:'Overall FDDS %', num:true, get:r=>fmtPct(r.fddsPct), cf:fddsCf} ];
    paymentTypes.forEach(t => { m4SlotColumns.push({label:`${t} FDDS %`, num:true, get:r=>fmtPct(r[t].fddsPct), cf:r=>{ const v=r[t].fddsPct; return v<60?'cf-bad':v<80?'cf-warn':'cf-good'; }}); });
    renderTable(document.getElementById('m4-slot-table'), m4SlotColumns, c.fdds.bySlot, {});

    document.querySelectorAll('#m5-threshold').forEach(n=>n.textContent = c.pickupToRad.thresholdHours+'h');
    const radCf = r => { if(!r.over) return null; if(r.overPct<=10) return 'cf-warn'; if(r.overPct<=25) return 'cf-bad'; return 'cf-bad-strong'; };
    renderTable(document.getElementById('m5-table'),
      [ {label:'Last Mile Station', get:r=>r.lmStation}, {label:'Shipments', num:true, get:r=>fmtInt(r.count)},
        {label:'Avg days pickup→RAD', num:true, get:r=>fmtDays(r.avgDays)},
        {label:`Over ${c.pickupToRad.thresholdHours}h`, num:true, get:r=>`${fmtInt(r.over)} (${fmtPct(r.overPct)})`, cf:radCf} ],
      c.pickupToRad.rows, {flagKey:'__never',
        getDrill:r=> (r.defectAwbs && r.defectAwbs.length) ? { title:`Pickup → RAD over ${c.pickupToRad.thresholdHours}h — ${r.lmStation}`, subtitle:`${fmtInt(r.defectAwbs.length)} shipment(s) took longer than ${c.pickupToRad.thresholdHours}h to reach destination`, awbs:r.defectAwbs } : null });

    document.querySelectorAll('#m6-threshold').forEach(n=>n.textContent = c.pickupToCustomer.thresholdDays+' days');
    const custCf = r => { const p = r.delivered ? (r.totalDefects/(r.delivered+r.stillPendingOver))*100 : (r.totalDefects?100:0); if(!r.totalDefects) return null; if(p<=10) return 'cf-warn'; if(p<=25) return 'cf-bad'; return 'cf-bad-strong'; };
    renderTable(document.getElementById('m6-table'),
      [ {label:'Last Mile Station', get:r=>r.lmStation}, {label:'Delivered', num:true, get:r=>fmtInt(r.delivered)},
        {label:'Avg days pickup→customer', num:true, get:r=>fmtDays(r.avgDays)},
        {label:`Late delivered (>${c.pickupToCustomer.thresholdDays}d)`, num:true, get:r=>`${fmtInt(r.lateDelivered)} (${fmtPct(r.lateDeliveredPct)})`, cf:custCf},
        {label:`Still pending (>${c.pickupToCustomer.thresholdDays}d)`, num:true, get:r=>fmtInt(r.stillPendingOver), cf:r=>r.stillPendingOver?'cf-bad':null} ],
      c.pickupToCustomer.rows, {
        getDrill:r=>{
          const awbs = (r.lateDeliveredAwbs||[]).concat(r.stillPendingAwbs||[]);
          return awbs.length ? { title:`Pickup → Customer defects — ${r.lmStation}`, subtitle:`${fmtInt(r.lateDelivered)} delivered late + ${fmtInt(r.stillPendingOver)} still pending, both past ${c.pickupToCustomer.thresholdDays}d`, awbs } : null;
        } });

    document.querySelectorAll('#m7-threshold').forEach(n=>n.textContent = c.rto.zrtoThresholdPctOfTotal+'%');
    renderTable(document.getElementById('m7-table'),
      [ {label:'Last Mile Station', get:r=>r.lmStation}, {label:'Total shipments', num:true, get:r=>fmtInt(r.total)},
        {label:'ZRTO shipments', num:true, get:r=>fmtInt(r.zrto)}, {label:'ZRTO % (station)', num:true, get:r=>fmtPct(r.zrtoPct,2)},
        {label:'% of total shipments', num:true, get:r=>fmtPct(r.zrtoPctOfTotal,3), cf:r=>r.zrtoFlagged?'cf-bad':(r.zrto===0?'cf-good':null)} ],
      c.rto.rows, {flagKey:'zrtoFlagged',
        getDrill:r=> (r.zrtoAwbs && r.zrtoAwbs.length) ? { title:`ZRTO — ${r.lmStation}`, subtitle:`${fmtInt(r.zrtoAwbs.length)} shipment(s) returned to origin without a delivery attempt`, awbs:r.zrtoAwbs } : null });

    document.querySelectorAll('#m8-threshold').forEach(n=>n.textContent = c.rto.rtoThresholdPct+'%');
    renderTable(document.getElementById('m8-table'),
      [ {label:'Last Mile Station', get:r=>r.lmStation}, {label:'Total shipments', num:true, get:r=>fmtInt(r.total)},
        {label:'RTO shipments', num:true, get:r=>fmtInt(r.rto)},
        {label:'RTO %', num:true, get:r=>fmtPct(r.rtoPct,2), cf:r=>r.rtoFlagged?'cf-bad-strong':(r.rtoPct>=10?'cf-warn':(r.rto===0?'cf-good':null))} ],
      c.rto.rows, {flagKey:'rtoFlagged',
        getDrill:r=> (r.rtoAwbs && r.rtoAwbs.length) ? { title:`RTO — ${r.lmStation}`, subtitle:`${fmtInt(r.rtoAwbs.length)} shipment(s) returned to origin after a failed delivery`, awbs:r.rtoAwbs } : null });

    document.querySelectorAll('#m9-asof').forEach(n => { n.textContent = c.lifecycle.referenceTime ? fmtDateTimeLabel(c.lifecycle.referenceTime) : 'reference time'; });
    document.getElementById('m9-summary').textContent = c.lifecycle.referenceTime
      ? `${fmtInt(c.lifecycle.grandTotal)} shipments have not reached a terminal status yet — ${fmtInt(c.lifecycle.forwardTotal.total)} Forward, ${fmtInt(c.lifecycle.reverseTotal.total)} Reverse (RTO flow) — as of ${fmtDateTimeLabel(c.lifecycle.referenceTime)}.`
      : 'No `modified` timestamps found in this file, so aging can\'t be anchored to a reference time.';
    renderPivotTable(document.getElementById('m9-forward-table'), c.lifecycle.forward, c.lifecycle.buckets, c.lifecycle.forwardTotal, {groupLabel:'Current Station'});
    renderPivotTable(document.getElementById('m9-reverse-table'), c.lifecycle.reverse, c.lifecycle.buckets, c.lifecycle.reverseTotal, {groupLabel:'Current Station'});

    document.querySelectorAll('#m10-asof').forEach(n => { n.textContent = c.dwell.referenceTime ? fmtDateTimeLabel(c.dwell.referenceTime) : 'reference time'; });
    document.getElementById('m10-summary').textContent = c.dwell.referenceTime
      ? `${fmtInt(c.dwell.total.total)} non-terminal shipments dwelling at their current station, as of ${fmtDateTimeLabel(c.dwell.referenceTime)}.`
      : 'No reference time available, so DWELL can\'t be computed.';
    renderPivotTable(document.getElementById('m10-table'), c.dwell.rows, c.dwell.buckets, c.dwell.total, {groupLabel:'Current Station'});
  }

  /* ---------- filtering + recompute ---------- */
  function currentFilters(){
    return {
      from: document.getElementById('dateFrom').value || null,
      to: document.getElementById('dateTo').value || null,
      fm: document.getElementById('fmFilter').value || null,
      lm: document.getElementById('lmFilter').value || null,
    };
  }
  function applyFilters(rows, f){
    return rows.filter(r => {
      if (f.from || f.to){
        if (!r.manifested) return false;
        const k = Engine.dateKey(r.manifested);
        if (f.from && k < f.from) return false;
        if (f.to && k > f.to) return false;
      }
      if (f.fm && r.fmStation !== f.fm) return false;
      if (f.lm && r.lmStation !== f.lm) return false;
      return true;
    });
  }
  function recompute(){
    const f = currentFilters();
    const rows = applyFilters(state.allRows, f);
    const c = Engine.computeAll(rows, {
      pendencyThresholdPct: 0.5,
      radThresholdHours: 24,
      customerThresholdDays: 7,
      zrtoThresholdPctOfTotal: 0.2,
      rtoThresholdPct: 15,
      referenceTime: state.referenceTime,
    });
    renderMetrics(rows, c);
  }

  /* Summary section can be minimized so it stops pushing the metric tables
     down the page — a per-viewer UI preference, remembered across reloads
     where localStorage is available, degrading silently otherwise. */
  function initSummaryToggle(){
    const btn = document.getElementById('summaryToggleBtn');
    const body = document.getElementById('summaryBody');
    if (!btn || !body) return;
    let collapsed = false;
    try{ collapsed = localStorage.getItem('m3s-summary-collapsed') === '1'; } catch(e){}
    const apply = () => {
      body.hidden = collapsed;
      btn.textContent = collapsed ? '▾ Show summary' : '▴ Minimize';
      btn.setAttribute('aria-expanded', String(!collapsed));
    };
    apply();
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      apply();
      try{ localStorage.setItem('m3s-summary-collapsed', collapsed ? '1' : '0'); } catch(e){}
    });
  }

  /* Left index/nav sidebar can be hidden entirely to give the tables the
     full width — another per-viewer preference, remembered where possible. */
  function initSidebarToggle(){
    const btn = document.getElementById('sidebarToggleBtn');
    const appRoot = document.getElementById('appRoot');
    if (!btn || !appRoot) return;
    let hidden = false;
    try{ hidden = localStorage.getItem('m3s-sidebar-hidden') === '1'; } catch(e){}
    const apply = () => {
      appRoot.classList.toggle('sidebar-hidden', hidden);
      btn.textContent = hidden ? '▸ Show index' : '◂ Hide index';
      btn.setAttribute('aria-expanded', String(!hidden));
    };
    apply();
    btn.addEventListener('click', () => {
      hidden = !hidden;
      apply();
      try{ localStorage.setItem('m3s-sidebar-hidden', hidden ? '1' : '0'); } catch(e){}
    });
  }

  function initNavScroll(){
    const links = Array.from(document.querySelectorAll('.nav a'));
    const sections = () => links.map(l => document.getElementById(l.dataset.nav)).filter(Boolean);
    window.addEventListener('scroll', () => {
      let current = null;
      for (const sec of sections()){
        const rect = sec.getBoundingClientRect();
        if (rect.top <= 120) current = sec.id;
      }
      links.forEach(l => l.classList.toggle('active', l.dataset.nav === current));
    }, {passive:true});
  }

  /* =======================================================================
     Password modal — gates the shared upload. Built as an in-page modal
     (not window.prompt) so it matches the rest of the UI and can show a
     proper inline error on a wrong password without blocking the page.
     ======================================================================= */
  function onPwKey(ev){
    if (ev.key === 'Escape') closePasswordModal();
    if (ev.key === 'Enter') confirmUpload();
  }
  function openPasswordModal(){
    const backdrop = document.getElementById('pwBackdrop');
    const input = document.getElementById('pwInput');
    const err = document.getElementById('pwError');
    err.textContent = '';
    input.value = '';
    backdrop.hidden = false;
    document.getElementById('pwConfirmBtn').disabled = false;
    document.getElementById('pwConfirmBtn').textContent = 'Upload & share';
    input.focus();
    document.addEventListener('keydown', onPwKey);
  }
  function closePasswordModal(){
    document.getElementById('pwBackdrop').hidden = true;
    document.removeEventListener('keydown', onPwKey);
    pendingUpload = null;
  }
  async function confirmUpload(){
    if (!pendingUpload) return;
    const input = document.getElementById('pwInput');
    const err = document.getElementById('pwError');
    const confirmBtn = document.getElementById('pwConfirmBtn');
    const password = input.value;
    if (!password){ err.textContent = 'Enter the shared upload password.'; return; }
    err.textContent = '';
    confirmBtn.disabled = true; confirmBtn.textContent = 'Uploading…';
    setSyncChip('Uploading…', 'busy');
    try{
      const { fileName, rows, missingColumns } = pendingUpload;
      const resp = await apiUpload(password, fileName, missingColumns, rows);
      document.removeEventListener('keydown', onPwKey);
      document.getElementById('pwBackdrop').hidden = true;
      applyDataset(fileName, pendingUpload.header, rows, missingColumns, resp && resp.uploadedAt ? resp.uploadedAt : new Date().toISOString());
      setSyncChip('✓ Shared — everyone sees this now', 'ok', 3200);
      pendingUpload = null;
    } catch (err2){
      console.error('[upload]', err2);
      confirmBtn.disabled = false; confirmBtn.textContent = 'Upload & share';
      setSyncChip(null);
      const box = document.getElementById('pwError');
      if (err2 && err2.status === 401) box.textContent = 'Wrong password — try again.';
      else box.textContent = (err2 && err2.message) ? err2.message : 'Upload failed — try again.';
      input.focus(); input.select();
    }
  }

  function init(){
    const fileInput = document.getElementById('fileInput');
    document.getElementById('uploadBtnTop').addEventListener('click', () => fileInput.click());
    document.getElementById('uploadBtnEmpty').addEventListener('click', () => fileInput.click());
    document.getElementById('refreshBtnTop').addEventListener('click', () => loadSharedData(true));
    document.addEventListener('click', (e) => { const btn = e.target.closest('.btn-emailcopy'); if (btn) handleCopyForEmail(btn); });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) readWorkbook(e.target.files[0]); e.target.value=''; });

    const empty = document.getElementById('emptyState');
    ['dragenter','dragover'].forEach(ev => empty.addEventListener(ev, (e)=>{ e.preventDefault(); empty.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => empty.addEventListener(ev, (e)=>{ e.preventDefault(); empty.classList.remove('dragover'); }));
    empty.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readWorkbook(f); });

    document.getElementById('pwCancelBtn').addEventListener('click', closePasswordModal);
    document.getElementById('pwConfirmBtn').addEventListener('click', confirmUpload);
    document.getElementById('pwBackdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'pwBackdrop') closePasswordModal(); });

    document.getElementById('datePresets').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill'); if (!btn) return;
      document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const range = btn.dataset.range;
      if (range === 'all'){
        document.getElementById('dateFrom').value = state.dataMin ? ymd(state.dataMin) : '';
        document.getElementById('dateTo').value = state.dataMax ? ymd(state.dataMax) : '';
      } else if (state.dataMax) {
        const days = parseInt(range,10);
        const from = new Date(state.dataMax.getTime() - (days-1)*86400000);
        document.getElementById('dateFrom').value = ymd(from);
        document.getElementById('dateTo').value = ymd(state.dataMax);
      }
      recompute();
    });
    ['dateFrom','dateTo','fmFilter','lmFilter'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        if (id==='dateFrom' || id==='dateTo') document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
        recompute();
      });
    });

    initNavScroll();
    initSummaryToggle();
    initSidebarToggle();
    loadSharedData(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
