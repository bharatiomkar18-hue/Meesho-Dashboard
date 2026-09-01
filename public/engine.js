"use strict";
/* =========================================================================
   ENGINE v2 — parsing + metric computation for the tabular/conditional-
   formatting dashboard. Adapted from the v1 (chart) dashboard's engine:
   same column mapping and date parsing, revised defect thresholds, two new
   metrics (Shipment Life Cycle aging, DWELL buckets).
   ========================================================================= */
const Engine = (function(){
  const COLS = {
    manifested: ['manifested date'],
    networkArrival: ['network arrival date'],
    status: ['status'],
    pickedUp: ['picked-up date and time', 'picked up date and time', 'pickedup date and time'],
    rad: ['rad date and time'],
    outForDelivery: ['first out on road date'],
    fwdAttemptCount: ['forward attempted count'],
    delivered: ['delivered date'],
    firstAttemptDate: ['first attempt date'],
    secondAttemptDate: ['second attempt date'],
    thirdAttemptDate: ['third attempt date'],
    rtoInitiate: ['rto intitate date', 'rto initiate date'],
    rtoDelivered: ['rto delivered date'],
    fmStation: ['first mile station'],
    fmStationName: ['fm station name'],
    lmStation: ['last mile station'],
    lmStationName: ['lm station name'],
    deliverySlotEnd: ['delivery slot end timestamp'],
    awb: ['awb no'],
    paymentMethod: ['payment method'],
    currentStation: ['current station'],
    currentStationName: ['current station facility name'],
    inTransitTime: ['in transit time'],
    reportModified: ['modified'],
  };

  function norm(s){ return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

  const PAYMENT_TYPES = ['Prepaid', 'COD'];
  function classifyPaymentType(raw){
    const n = norm(raw);
    if (!n) return 'Other';
    if (n.indexOf('cod') !== -1) return 'COD';
    if (n.indexOf('prepay') !== -1 || n.indexOf('prepaid') !== -1) return 'Prepaid';
    return 'Other';
  }

  function buildColumnMap(header){
    const normalized = header.map(norm);
    const map = {};
    for (const key of Object.keys(COLS)){
      let idx = -1;
      for (const c of COLS[key]){ idx = normalized.indexOf(c); if (idx !== -1) break; }
      map[key] = idx;
    }
    return map;
  }

  function parseDate(v){
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number'){
      const ms = Math.round((v - 25569) * 86400 * 1000);
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
    if (m){
      const day=+m[1], mon=+m[2], yr=+m[3], hh=m[4]?+m[4]:0, mm=m[5]?+m[5]:0, ss=m[6]?+m[6]:0;
      const d = new Date(Date.UTC(yr, mon-1, day, hh, mm, ss));
      return isNaN(d.getTime()) ? null : d;
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
    if (m){
      const day=+m[1], mon=+m[2], yr=+m[3], hh=m[4]?+m[4]:0, mm=m[5]?+m[5]:0, ss=m[6]?+m[6]:0;
      const d = new Date(Date.UTC(yr, mon-1, day, hh, mm, ss));
      return isNaN(d.getTime()) ? null : d;
    }
    const generic = new Date(s);
    return isNaN(generic.getTime()) ? null : generic;
  }

  const DAY_MS = 86400000, HOUR_MS = 3600000;
  function dateKey(d){ return d ? d.toISOString().slice(0,10) : null; }
  function timeOfDayKey(d){ if(!d) return null; return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0'); }
  function hoursBetween(a,b){ return (!a||!b) ? null : (b.getTime()-a.getTime())/HOUR_MS; }
  function daysBetween(a,b){ return (!a||!b) ? null : (b.getTime()-a.getTime())/DAY_MS; }

  // Statuses meaning "the shipment hasn't left the pickup step yet". Anything
  // else (In Vehicle Transit, Arrival, Depart Facility, Delivered, COD*, ...)
  // counts as "connected ahead" for Connections-from-FM% / Picked Up Pendency.
  const PICKUP_STAGE_STATUSES = new Set(['created','facility assigned','manage schedule','pickup initiated','pickup attempted','pickup done']);
  function isConnectedAhead(r){ return !PICKUP_STAGE_STATUSES.has(norm(r.status)); }

  // "Terminal" = nothing more is expected to happen to this shipment.
  // Explicit list per spec, plus Cancelled (an order that will never move
  // again is not a live backlog item either) — flagged as an assumption in
  // the UI's own documentation, not silently baked in.
  const TERMINAL_STATUSES = new Set([
    'delivered','lost','rto delivered','cod reconciled','cod collected',
    'cash collected','cod deposited','pending cod clearance','cash handover',
    'cancelled',
  ]);
  function isTerminal(r){ return TERMINAL_STATUSES.has(norm(r.status)); }
  function isReverseFlow(r){ return !!(r.rtoInitiate || r.rtoDelivered || norm(r.status) === 'ready for return'); }

  // Shipment Life Cycle (09) additionally drops these early-pickup-stage
  // statuses from its non-terminal backlog — per explicit ask, they're not
  // "stuck" shipments, just ones that haven't started their journey yet.
  // (Cancelled is already excluded above, as a terminal status.)
  const LIFECYCLE_EXCLUDED_STATUSES = new Set(['pickup initiated', 'pickup attempted', 'facility assigned']);
  function isLifecycleExcluded(r){ return isTerminal(r) || LIFECYCLE_EXCLUDED_STATUSES.has(norm(r.status)); }

  // DWELL (10) excludes shipments still sitting at their First Mile station —
  // only mid-network / Last Mile dwelling counts as a defect. Station codes in
  // this report can differ only by case between the "current station" and
  // "first/last mile station" columns (e.g. QCOMMER5C5H vs qcommer5c5h), so
  // both the facility-name and the raw-code comparison are case-insensitive.
  function isAtFirstMile(r){
    const curName = norm(r.currentStation), fmName = norm(r.fmStation);
    if (curName && fmName && curName === fmName) return true;
    const curCode = norm(r.currentStationCode), fmCode = norm(r.fmStationCode);
    return !!(curCode && fmCode && curCode === fmCode);
  }

  function normalizeRows(header, rawRows){
    const map = buildColumnMap(header);
    const get = (r,key) => (map[key] >= 0 ? r[map[key]] : undefined);
    const rows = rawRows.map((r) => ({
      awb: get(r,'awb'),
      status: get(r,'status') == null ? '' : String(get(r,'status')),
      manifested: parseDate(get(r,'manifested')),
      pickedUp: parseDate(get(r,'pickedUp')),
      networkArrival: parseDate(get(r,'networkArrival')),
      rad: parseDate(get(r,'rad')),
      outForDelivery: parseDate(get(r,'outForDelivery')),
      delivered: parseDate(get(r,'delivered')),
      firstAttempt: parseDate(get(r,'firstAttemptDate')),
      secondAttempt: parseDate(get(r,'secondAttemptDate')),
      thirdAttempt: parseDate(get(r,'thirdAttemptDate')),
      rtoInitiate: parseDate(get(r,'rtoInitiate')),
      rtoDelivered: parseDate(get(r,'rtoDelivered')),
      deliverySlotEnd: parseDate(get(r,'deliverySlotEnd')),
      fmStation: get(r,'fmStationName') || get(r,'fmStation') || 'Unknown FM',
      lmStation: get(r,'lmStationName') || get(r,'lmStation') || 'Unknown LM',
      fmStationCode: get(r,'fmStation'),
      lmStationCode: get(r,'lmStation'),
      currentStationCode: get(r,'currentStation'),
      currentStation: get(r,'currentStationName') || get(r,'currentStation') || 'Unknown station',
      lastCheckpoint: parseDate(get(r,'inTransitTime')) || parseDate(get(r,'reportModified')),
      reportModified: parseDate(get(r,'reportModified')),
      fwdAttemptCount: Number(get(r,'fwdAttemptCount')) || 0,
      paymentType: classifyPaymentType(get(r,'paymentMethod')),
    }));
    return { rows, map, missingColumns: Object.keys(map).filter(k => map[k] === -1) };
  }

  /* ---------- 1. Pickup Efficiency — defect = the >36h bucket ---------- */
  function pickupEfficiency(rows){
    const buckets = ['<12h','12-24h','24-36h','>36h','Not picked up'];
    const byDate = new Map();
    for (const r of rows){
      if (!r.manifested) continue;
      const key = dateKey(r.manifested);
      if (!byDate.has(key)) byDate.set(key, {date:key,'<12h':0,'12-24h':0,'24-36h':0,'>36h':0,'Not picked up':0,total:0,defectAwbs:[]});
      const rec = byDate.get(key);
      rec.total += 1;
      if (!r.pickedUp){ rec['Not picked up'] += 1; continue; }
      const h = hoursBetween(r.manifested, r.pickedUp);
      if (h == null || h < 0){ rec['Not picked up'] += 1; continue; }
      if (h < 12) rec['<12h'] += 1;
      else if (h < 24) rec['12-24h'] += 1;
      else if (h < 36) rec['24-36h'] += 1;
      else { rec['>36h'] += 1; rec.defectAwbs.push(r.awb); }
    }
    const out = Array.from(byDate.values()).sort((a,b)=>a.date.localeCompare(b.date));
    let totalManifested = 0, totalDefect = 0;
    for (const rec of out){
      rec.pct = {}; for (const b of buckets) rec.pct[b] = rec.total ? (rec[b]/rec.total)*100 : 0;
      totalManifested += rec.total; totalDefect += rec['>36h'];
    }
    return { buckets, rows: out, totalManifested, totalDefect, totalDefectPct: totalManifested ? (totalDefect/totalManifested)*100 : 0 };
  }

  /* ---------- 2 & 3. Connections from FM% / Picked Up Pendency ----------
     Two views of the same underlying split (picked-up shipments that have
     vs haven't moved past the pickup step), so computed together. */
  function pickupProgress(rows, thresholdPct){
    thresholdPct = thresholdPct == null ? 0.5 : thresholdPct;
    const totalPickedUp = rows.filter(r=>r.pickedUp).length;
    const byDate = new Map(), byStation = new Map();
    for (const r of rows){
      if (!r.pickedUp) continue;
      const pending = !isConnectedAhead(r);
      const dKey = dateKey(r.manifested) || 'Unknown date';
      if (!byDate.has(dKey)) byDate.set(dKey, {date:dKey,pickedUp:0,connected:0,pending:0,defectAwbs:[]});
      const dRec = byDate.get(dKey); dRec.pickedUp+=1; if (pending){ dRec.pending+=1; dRec.defectAwbs.push(r.awb); } else dRec.connected+=1;
      const sKey = r.fmStation;
      if (!byStation.has(sKey)) byStation.set(sKey, {fmStation:sKey,pickedUp:0,connected:0,pending:0,defectAwbs:[]});
      const sRec = byStation.get(sKey); sRec.pickedUp+=1; if (pending){ sRec.pending+=1; sRec.defectAwbs.push(r.awb); } else sRec.connected+=1;
    }
    const finish = (rec) => ({...rec,
      connectedPct: rec.pickedUp?(rec.connected/rec.pickedUp)*100:0,
      pendingPctOfGroup: rec.pickedUp?(rec.pending/rec.pickedUp)*100:0,
      pendingPctOfTotalPickedUp: totalPickedUp?(rec.pending/totalPickedUp)*100:0,
      flagged: totalPickedUp ? (rec.pending/totalPickedUp)*100 > thresholdPct : false,
    });
    const byDateOut = Array.from(byDate.values()).map(finish).sort((a,b)=>a.date.localeCompare(b.date));
    const byStationOut = Array.from(byStation.values()).map(finish).sort((a,b)=>b.pendingPctOfTotalPickedUp-a.pendingPctOfTotalPickedUp);
    const totalPending = byStationOut.reduce((s,r)=>s+r.pending,0);
    const totalConnected = totalPickedUp - totalPending;
    return {
      byDate: byDateOut, byStation: byStationOut, totalPickedUp, totalPending, totalConnected,
      totalPendingPct: totalPickedUp?(totalPending/totalPickedUp)*100:0,
      totalConnectedPct: totalPickedUp?(totalConnected/totalPickedUp)*100:0,
      thresholdPct,
    };
  }

  /* ---------- 4. FDDS, split Prepaid / COD ---------- */
  function blankTypeTotals(){
    const o = { sentOut:0, deliveredSameDay:0 };
    PAYMENT_TYPES.concat(['Other']).forEach(t => { o[t] = { sentOut:0, deliveredSameDay:0 }; });
    return o;
  }
  function finishTypeTotals(rec){
    const withPct = (t) => ({ ...t, fddsPct: t.sentOut ? (t.deliveredSameDay/t.sentOut)*100 : 0 });
    const out = { ...rec, fddsPct: rec.sentOut ? (rec.deliveredSameDay/rec.sentOut)*100 : 0 };
    PAYMENT_TYPES.concat(['Other']).forEach(t => { out[t] = withPct(rec[t]); });
    return out;
  }
  function fdds(rows){
    const byStation = new Map();
    const bySlot = new Map();
    const presentTypes = new Set();
    for (const r of rows){
      if (!r.outForDelivery) continue;
      const sameDay = !!(r.delivered && dateKey(r.delivered) === dateKey(r.outForDelivery));
      const pt = r.paymentType;
      presentTypes.add(pt);
      const sKey = r.lmStation;
      if (!byStation.has(sKey)) byStation.set(sKey, { lmStation:sKey, sentOut:0, deliveredSameDay:0, ...blankTypeTotals() });
      const sRec = byStation.get(sKey);
      sRec.sentOut += 1; sRec[pt].sentOut += 1;
      if (sameDay){ sRec.deliveredSameDay += 1; sRec[pt].deliveredSameDay += 1; }
      if (r.deliverySlotEnd){
        const slotKey = timeOfDayKey(r.deliverySlotEnd);
        if (!bySlot.has(slotKey)) bySlot.set(slotKey, { slot:slotKey, sentOut:0, deliveredSameDay:0, ...blankTypeTotals() });
        const slRec = bySlot.get(slotKey);
        slRec.sentOut += 1; slRec[pt].sentOut += 1;
        if (sameDay){ slRec.deliveredSameDay += 1; slRec[pt].deliveredSameDay += 1; }
      }
    }
    const out = Array.from(byStation.values()).map(finishTypeTotals);
    out.sort((a,b)=>a.fddsPct-b.fddsPct);
    const slotOut = Array.from(bySlot.values()).map(finishTypeTotals);
    slotOut.sort((a,b)=>a.slot.localeCompare(b.slot));
    const typesPresent = PAYMENT_TYPES.filter(t => presentTypes.has(t)).concat(presentTypes.has('Other') ? ['Other'] : []);
    return { byStation: out, bySlot: slotOut, typesPresent: typesPresent.length ? typesPresent : PAYMENT_TYPES };
  }

  /* ---------- 5. Pickup → RAD — defect = crossing 24 hours ---------- */
  function pickupToRad(rows, thresholdHours){
    thresholdHours = thresholdHours == null ? 24 : thresholdHours;
    const thresholdDays = thresholdHours / 24;
    const byStation = new Map();
    for (const r of rows){
      if (!r.pickedUp || !r.rad) continue;
      const d = daysBetween(r.pickedUp, r.rad);
      if (d == null || d < 0) continue;
      const key = r.lmStation;
      if (!byStation.has(key)) byStation.set(key, {lmStation:key,count:0,sumDays:0,over:0,defectAwbs:[]});
      const rec = byStation.get(key); rec.count+=1; rec.sumDays+=d; if (d*24>thresholdHours){ rec.over+=1; rec.defectAwbs.push(r.awb); }
    }
    const out = Array.from(byStation.values()).map(rec=>({...rec, avgDays: rec.count?rec.sumDays/rec.count:0, overPct: rec.count?(rec.over/rec.count)*100:0}));
    out.sort((a,b)=>b.overPct-a.overPct);
    return { rows: out, thresholdHours, thresholdDays };
  }

  /* ---------- 6. Pickup → Customer — defect = >7d delivered late, or
     still undelivered and already past 7d since pickup ---------- */
  function pickupToCustomer(rows, thresholdDays, referenceTime){
    thresholdDays = thresholdDays == null ? 7 : thresholdDays;
    const byStation = new Map();
    for (const r of rows){
      if (!r.pickedUp) continue;
      const key = r.lmStation;
      if (!byStation.has(key)) byStation.set(key, {lmStation:key, delivered:0, sumDays:0, lateDelivered:0, lateDeliveredAwbs:[], stillPendingOver:0, stillPendingAwbs:[]});
      const rec = byStation.get(key);
      if (r.delivered){
        const d = daysBetween(r.pickedUp, r.delivered);
        if (d != null && d >= 0){
          rec.delivered += 1; rec.sumDays += d;
          if (d > thresholdDays){ rec.lateDelivered += 1; rec.lateDeliveredAwbs.push(r.awb); }
        }
      } else if (referenceTime && !isTerminal(r)){
        const d = daysBetween(r.pickedUp, referenceTime);
        if (d != null && d > thresholdDays){ rec.stillPendingOver += 1; rec.stillPendingAwbs.push(r.awb); }
      }
    }
    const out = Array.from(byStation.values()).map(rec => ({...rec,
      avgDays: rec.delivered ? rec.sumDays/rec.delivered : 0,
      lateDeliveredPct: rec.delivered ? (rec.lateDelivered/rec.delivered)*100 : 0,
      totalDefects: rec.lateDelivered + rec.stillPendingOver,
    }));
    out.sort((a,b)=>b.totalDefects-a.totalDefects);
    return { rows: out, thresholdDays };
  }

  /* ---------- 7 & 8. ZRTO% (defect > 0.2% of total shipments) / RTO%
     (defect > 15% of that station's own shipments) ---------- */
  function rtoMetrics(rows, zrtoThresholdPctOfTotal, rtoThresholdPct){
    zrtoThresholdPctOfTotal = zrtoThresholdPctOfTotal == null ? 0.2 : zrtoThresholdPctOfTotal;
    rtoThresholdPct = rtoThresholdPct == null ? 15 : rtoThresholdPct;
    const grandTotal = rows.length;
    const byStation = new Map();
    for (const r of rows){
      const key = r.lmStation;
      if (!byStation.has(key)) byStation.set(key, {lmStation:key,total:0,rto:0,zrto:0,rtoAwbs:[],zrtoAwbs:[]});
      const rec = byStation.get(key); rec.total+=1;
      const inRtoFlow = !!(r.rtoInitiate || r.rtoDelivered);
      if (inRtoFlow){ rec.rto+=1; rec.rtoAwbs.push(r.awb); }
      const noAttemptMade = !r.firstAttempt && !r.secondAttempt && !r.thirdAttempt && r.fwdAttemptCount===0;
      if (inRtoFlow && noAttemptMade){ rec.zrto+=1; rec.zrtoAwbs.push(r.awb); }
    }
    const out = Array.from(byStation.values()).map(rec=>({...rec,
      rtoPct: rec.total?(rec.rto/rec.total)*100:0,
      zrtoPct: rec.total?(rec.zrto/rec.total)*100:0,
      zrtoPctOfTotal: grandTotal?(rec.zrto/grandTotal)*100:0,
      rtoFlagged: rec.total ? (rec.rto/rec.total)*100 > rtoThresholdPct : false,
      zrtoFlagged: grandTotal ? (rec.zrto/grandTotal)*100 > zrtoThresholdPctOfTotal : false,
    }));
    out.sort((a,b)=>b.rtoPct-a.rtoPct);
    return { rows: out, grandTotal, zrtoThresholdPctOfTotal, rtoThresholdPct };
  }

  /* ---------- 9. Shipment Life Cycle — non-terminal shipments' age since
     Network Arrival (falls back to Manifested Date), split Forward vs
     Reverse (RTO flow), bucketed, grouped by Current Station. ---------- */
  const AGING_BUCKETS = [
    {key:'<3d', label:'< 3 days', max:3},
    {key:'3-5d', label:'3–5 days', max:5},
    {key:'5-10d', label:'5–10 days', max:10},
    {key:'10-15d', label:'10–15 days', max:15},
    {key:'15-30d', label:'15–30 days', max:30},
    {key:'>30d', label:'> 30 days', max:Infinity},
  ];
  function agingBucketFor(days){
    for (const b of AGING_BUCKETS){ if (days < b.max) return b.key; }
    return '>30d';
  }
  function blankBucketRow(label){
    const o = { station: label, total:0, defectAwbsByBucket:{} };
    AGING_BUCKETS.forEach(b => { o[b.key] = 0; o.defectAwbsByBucket[b.key] = []; });
    return o;
  }
  function shipmentLifecycle(rows, referenceTime){
    const dirs = { Forward: new Map(), Reverse: new Map() };
    const totals = { Forward: blankBucketRow('Total'), Reverse: blankBucketRow('Total') };
    let skippedNoDate = 0;
    for (const r of rows){
      if (isLifecycleExcluded(r)) continue;
      if (r.currentStation === 'Unknown station') continue;
      const agingStart = r.networkArrival || r.manifested;
      if (!agingStart || !referenceTime){ skippedNoDate++; continue; }
      const days = daysBetween(agingStart, referenceTime);
      if (days == null || days < 0) continue;
      const bucket = agingBucketFor(days);
      const dir = isReverseFlow(r) ? 'Reverse' : 'Forward';
      const map = dirs[dir];
      const key = r.currentStation || 'Unknown station';
      if (!map.has(key)) map.set(key, blankBucketRow(key));
      const rec = map.get(key);
      rec[bucket] += 1; rec.total += 1; rec.defectAwbsByBucket[bucket].push(r.awb);
      totals[dir][bucket] += 1; totals[dir].total += 1; totals[dir].defectAwbsByBucket[bucket].push(r.awb);
    }
    const finish = (map) => Array.from(map.values()).sort((a,b)=>b.total-a.total);
    return {
      forward: finish(dirs.Forward), reverse: finish(dirs.Reverse),
      forwardTotal: totals.Forward, reverseTotal: totals.Reverse,
      buckets: AGING_BUCKETS, referenceTime, skippedNoDate,
      grandTotal: totals.Forward.total + totals.Reverse.total,
    };
  }

  /* ---------- 10. DWELL — non-terminal shipments, hours since last
     checkpoint, bucketed, grouped by Current Station (any station). ---------- */
  const DWELL_BUCKETS = [
    {key:'<24h', label:'< 24h', maxHours:24},
    {key:'1-2d', label:'1–2 days', maxHours:48},
    {key:'2-3d', label:'2–3 days', maxHours:72},
    {key:'3-5d', label:'3–5 days', maxHours:120},
    {key:'5-10d', label:'5–10 days', maxHours:240},
    {key:'>10d', label:'> 10 days', maxHours:Infinity},
  ];
  function dwellBucketFor(hours){
    for (const b of DWELL_BUCKETS){ if (hours < b.maxHours) return b.key; }
    return '>10d';
  }
  function blankDwellRow(label){
    const o = { station: label, total:0, defectAwbsByBucket:{} };
    DWELL_BUCKETS.forEach(b => { o[b.key] = 0; o.defectAwbsByBucket[b.key] = []; });
    return o;
  }
  function dwellBuckets(rows, referenceTime){
    const byStation = new Map();
    const grandTotalRow = blankDwellRow('Total');
    for (const r of rows){
      if (isTerminal(r)) continue;
      if (isAtFirstMile(r)) continue;
      if (r.currentStation === 'Unknown station') continue;
      if (!r.lastCheckpoint || !referenceTime) continue;
      const hours = hoursBetween(r.lastCheckpoint, referenceTime);
      if (hours == null || hours < 0) continue;
      const bucket = dwellBucketFor(hours);
      const key = r.currentStation || 'Unknown station';
      if (!byStation.has(key)) byStation.set(key, blankDwellRow(key));
      const rec = byStation.get(key);
      rec[bucket] += 1; rec.total += 1; rec.defectAwbsByBucket[bucket].push(r.awb);
      grandTotalRow[bucket] += 1; grandTotalRow.total += 1; grandTotalRow.defectAwbsByBucket[bucket].push(r.awb);
    }
    const out = Array.from(byStation.values()).sort((a,b)=>b.total-a.total);
    return { rows: out, total: grandTotalRow, buckets: DWELL_BUCKETS, referenceTime };
  }

  function computeAll(rows, opts){
    opts = opts || {};
    return {
      rowCount: rows.length,
      pickupEfficiency: pickupEfficiency(rows),
      pickupProgress: pickupProgress(rows, opts.pendencyThresholdPct),
      fdds: fdds(rows),
      pickupToRad: pickupToRad(rows, opts.radThresholdHours),
      pickupToCustomer: pickupToCustomer(rows, opts.customerThresholdDays, opts.referenceTime),
      rto: rtoMetrics(rows, opts.zrtoThresholdPctOfTotal, opts.rtoThresholdPct),
      lifecycle: shipmentLifecycle(rows, opts.referenceTime),
      dwell: dwellBuckets(rows, opts.referenceTime),
    };
  }

  return {
    buildColumnMap, parseDate, normalizeRows, computeAll, dateKey, timeOfDayKey,
    TERMINAL_STATUSES, PICKUP_STAGE_STATUSES,
  };
})();
