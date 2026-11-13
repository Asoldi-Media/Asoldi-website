// The few iCalendar fields an inbox bot needs from a REPLY or COUNTER (RFC 5545 / 5546):
// who answered (ATTENDEE + PARTSTAT), for which event (UID, DTSTART) and any COMMENT.
// Pure: no env, no I/O.

/** Lines that start with a space or tab continue the line above. */
function unfold(text = '') {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

function firstEvent(lines) {
  const start = lines.findIndex((line) => /^BEGIN:VEVENT$/i.test(line));
  if (start < 0) return lines;
  const end = lines.findIndex((line, index) => index > start && /^END:VEVENT$/i.test(line));
  return lines.slice(start + 1, end > start ? end : undefined);
}

function property(line = '') {
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const map = {};
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq > 0) map[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: map, value: line.slice(colon + 1) };
}

/** Outlook writes Windows zone names in TZID; Intl only knows IANA names. */
const WINDOWS_ZONES = {
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'fle standard time': 'Europe/Helsinki',
  'e. europe standard time': 'Europe/Chisinau',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

function ianaZone(zone = '') {
  const name = String(zone || '').trim().replace(/^"|"$/g, '');
  return WINDOWS_ZONES[name.toLowerCase()] || name;
}

/** Minutes east of UTC for `zone` at the given UTC instant. */
function zoneOffsetMinutes(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - ms) / 60000);
}

/** "20261109T160000" in `zone` (or UTC with a trailing Z) as an ISO instant; '' when unreadable. */
export function icsDateToIso(value = '', zone = '') {
  const match = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!match) return '';
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (z || !zone) return new Date(wall).toISOString();
  const iana = ianaZone(zone);
  try {
    // Two passes settle the offset across a DST switch.
    let ms = wall - zoneOffsetMinutes(wall, iana) * 60000;
    ms = wall - zoneOffsetMinutes(ms, iana) * 60000;
    return new Date(ms).toISOString();
  } catch {
    return new Date(wall).toISOString();
  }
}

/**
 * { method, uid, dtstart, dtend, attendees: [{ email, partstat }], partstat, attendee, comment } of the
 * first VEVENT. `partstat` / `attendee` are the first attendee's (a REPLY carries only the one who answered).
 */
export function parseIcsEvent(text = '') {
  const lines = unfold(text).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const methodLine = lines.find((line) => /^METHOD:/i.test(line));
  const out = {
    method: methodLine ? methodLine.slice(7).trim().toUpperCase() : '',
    uid: '',
    dtstart: '',
    dtend: '',
    attendees: [],
    partstat: '',
    attendee: '',
    comment: '',
  };
  for (const line of firstEvent(lines)) {
    const prop = property(line);
    if (!prop) continue;
    if (prop.name === 'UID') out.uid = prop.value.trim();
    else if (prop.name === 'DTSTART') out.dtstart = icsDateToIso(prop.value, prop.params.TZID);
    else if (prop.name === 'DTEND') out.dtend = icsDateToIso(prop.value, prop.params.TZID);
    else if (prop.name === 'COMMENT' && !out.comment) out.comment = prop.value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
    else if (prop.name === 'ATTENDEE') {
      const email = prop.value.replace(/^mailto:/i, '').trim().toLowerCase();
      if (email) out.attendees.push({ email, partstat: String(prop.params.PARTSTAT || '').toUpperCase() });
    }
  }
  out.partstat = out.attendees[0]?.partstat || '';
  out.attendee = out.attendees[0]?.email || '';
  return out;
}
