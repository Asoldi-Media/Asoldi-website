// One Intl.DateTimeFormat per locale, time zone and option set, reused by every caller.
// Building a formatter is expensive (a large allocation outside the JS heap), and the sales code
// asks for the same few on every read. A formatter never changes after it is built, so sharing one
// gives the same text as building a new one each time. An invalid time zone still throws the
// constructor's own RangeError on every call, because nothing is stored for it.
const formatters = new Map();
const MAX_FORMATTERS = 200;

export function cachedDateTimeFormat(locale, options = {}) {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}
