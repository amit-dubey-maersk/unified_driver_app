// X12 214 (Transportation Carrier Shipment Status) builder with two profiles, each shaped exactly like its real sample files:
//   OALM     ISA GS ST B10 L11*TO L11*LT L11*LN [L11*CH] N7 AT7 SE GE IEA                       "~"+CRLF, ST02=0001, B10-01=204 TN
//   DRAYAPP  ISA GS ST B10 [L11*WO] L11*SS [L11*CH] L11*TO L11*LT L11*LN N7 LX AT7 SE GE IEA    "~" only, ST02=SE02=ISA13, B10-01=204 SS,
//            HDDR>HDDR, N7 weight with 2 decimals and no size, container optional (the existing DrayApp -> Trinium format, 2,165 samples)

export const SEG_END = '~\r\n';

/** MSMU1974881 -> { prefix: 'MSMU', number: '197488', check: '1' } */
export function splitContainer(num) {
  const m = /^([A-Z]{4})(\d{6})(\d)$/.exec((num || '').trim().toUpperCase());
  return m ? { prefix: m[1], number: m[2], check: m[3] } : null;
}

/** App size/type (40HC, 40DV, 20DV, 45HC, or already 40H/40/20/45H) -> 214 N7-15 (20, 40, 40H, 45H). */
export function appSizeToN7(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  const m = /^(20|40|45)(H|HC|HQ)?/.exec(c);
  if (!m) return null;
  return m[1] + (m[2] ? 'H' : '');
}

/** Order payload's containerType "40 DRY" + containerHeight "9 6" -> N7-15. */
export function sizeFromOrder(containerType, containerHeight) {
  const size = /^\d+/.exec(containerType || '')?.[0];
  if (!size) return null;
  return size + (/^9/.test(containerHeight || '') ? 'H' : '');
}

const pad = (s, n) => String(s).padEnd(n, ' ');

/**
 * Local wall-clock {date:'CCYYMMDD', time:'HHMM'} from an ISO local string ("2026-11-03T15:02:00").
 */
export function localParts(isoLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoLocal || '');
  return m ? { date: m[1] + m[2] + m[3], time: m[4] + m[5] } : null;
}

/** UTC instant + "+hh:mm" offset -> local ISO string without offset. */
export function utcToLocal(utcIso, offset) {
  const t = Date.parse(utcIso);
  const m = /^([+-])(\d{2}):(\d{2})/.exec(offset || '');
  if (Number.isNaN(t) || !m) return null;
  const ms = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
  return new Date(t + ms).toISOString().slice(0, 19);
}

/**
 * @param o {isaControl:number, now:Date, sender, receiver, scac, b10_01, dispatchSeq, to?, legType, legNumber, chassis?,
 *           container:{prefix,number,check,weight?,size?}, code, local:{date,time}}
 */
export function build214(o) {
  const dray = o.profile === 'DRAYAPP';
  const ctl9 = String(o.isaControl).padStart(9, '0');
  const ctl = String(Number(o.isaControl));
  const iso = o.now.toISOString(); // sender-side timestamp (UTC)
  const yymmdd = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const ccyymmdd = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const hhmm = iso.slice(11, 13) + iso.slice(14, 16);

  const c = o.container || {};
  const n7 = new Array(19).fill('');
  n7[0] = 'N7'; n7[1] = c.prefix ?? ''; n7[2] = c.number ?? ''; n7[3] = c.weight ?? ''; n7[15] = dray ? '' : (c.size ?? ''); n7[18] = c.check ?? '';

  const stId = dray ? ctl : '0001';
  const body = [
    ['ST', '214', stId],
    ['B10', o.b10_01, o.dispatchSeq, o.scac],
    ...(dray
      ? [
        ...(o.wo ? [['L11', String(o.wo).slice(0, 30), 'WO']] : []),
        ...(o.bol ? [['L11', o.bol, 'SS']] : []),
        ...(o.chassis ? [['L11', o.chassis, 'CH']] : []),
        ...(o.to ? [['L11', o.to, 'TO']] : []),
        ['L11', o.legType, 'LT'], ['L11', o.legNumber, 'LN'], n7, ['LX', '1'],
      ]
      : [
        ...(o.to ? [['L11', o.to, 'TO']] : []),
        ['L11', o.legType, 'LT'], ['L11', o.legNumber, 'LN'],
        ...(o.chassis ? [['L11', o.chassis, 'CH']] : []),
        n7,
      ]),
    ['AT7', o.code, 'NS', '', '', o.local.date, o.local.time, 'LT'],
  ];
  const segs = [
    ['ISA', '00', pad('', 10), '00', pad('', 10), '02', pad(o.sender, 15), '02', pad(o.receiver, 15), yymmdd, hhmm, 'U', '00401', ctl9, '0', 'P', '>'],
    ['GS', 'QM', o.sender, o.receiver, ccyymmdd, hhmm, ctl, 'X', '004010'],
    ...body,
    ['SE', String(body.length + 1), stId],
    ['GE', '1', ctl],
    ['IEA', '1', ctl9],
  ];
  const end = dray ? '~' : SEG_END;
  return segs.map(x => x.join('*')).join(end) + end;
}

/**
 * File name. OALM samples: 214_YYYYMMDD_HHMMSS_<control>_<code>.txt
 * DrayApp samples:  hddr<container, lower case, if any><YYYYMMDD><HHMMSS><4 digits><control, 12 digits>.edi
 *   e.g. hddrffau8840181 20261102 122340 7780 000004450258.edi  (the 4 digits are a sub-second counter)
 */
export function fileName214(now, isaControl, code, opts = {}) {
  const iso = now.toISOString();
  const ymd = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const hms = iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
  if (opts.profile === 'DRAYAPP') {
    const frac = iso.slice(20, 23) + '0'; // milliseconds + 0; uniqueness comes from the control number
    return `hddr${(opts.container || '').toLowerCase()}${ymd}${hms}${frac}${String(isaControl).padStart(12, '0')}.edi`;
  }
  return `214_${ymd}_${hms}_${String(isaControl).padStart(9, '0')}_${code.toLowerCase()}.txt`;
}
