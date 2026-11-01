/**
 * Dark-diff clock: loaded with --require before the hub, it starts the process clock at
 * DARK_DIFF_CLOCK_START (epoch ms), so the base and head runs see the same dates. Time then moves
 * on at the normal rate. Timers and performance.now() are untouched. Without the env value this
 * file does nothing.
 */
'use strict';

const start = Number(process.env.DARK_DIFF_CLOCK_START);
if (Number.isFinite(start) && start > 0) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  const now = () => RealDate.now() + offset;
  // A function, not a class: Date() without `new` must keep returning a string.
  function DarkDiffDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(now());
  }
  DarkDiffDate.prototype = RealDate.prototype;
  DarkDiffDate.now = now;
  DarkDiffDate.parse = RealDate.parse;
  DarkDiffDate.UTC = RealDate.UTC;
  Object.defineProperty(DarkDiffDate, 'name', { value: 'Date' });
  globalThis.Date = DarkDiffDate;
}
