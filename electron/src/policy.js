'use strict';

// ─── schedule_allows ─────────────────────────────────────────────────────────

function _timeInWindow(nowTime, start, end) {
  // Times as "HH:MM" strings or Date objects — normalise to minutes since midnight.
  const toMins = (t) => {
    if (typeof t === 'string') {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    }
    return t.getHours() * 60 + t.getMinutes();
  };
  const n = toMins(nowTime);
  const s = toMins(start);
  const e = toMins(end);
  if (s <= e) return n >= s && n <= e;          // same-day window
  return n >= s || n <= e;                       // overnight window
}

function scheduleAllows(policy, now) {
  if (!policy.schedule_enabled) return true;
  if (!policy.schedule_windows || policy.schedule_windows.length === 0) return false;
  const d = now || new Date();
  // JS getDay(): 0=Sunday … 6=Saturday. Python weekday(): 0=Monday … 6=Sunday.
  // Convert: JS Sunday(0) → Python 6, JS Monday(1) → Python 0, etc.
  const pythonWeekday = (d.getDay() + 6) % 7;
  for (const win of policy.schedule_windows) {
    if ((win.days || []).includes(pythonWeekday)) {
      const nowTime = { getHours: () => d.getHours(), getMinutes: () => d.getMinutes() };
      if (_timeInWindow(nowTime, win.start || '22:00', win.end || '07:00')) return true;
    }
  }
  return false;
}

function shouldShare(policy, { idle = false, now } = {}) {
  if (policy.manual_override === 'panic')     return [false, 'Panic stop is active for this session.'];
  if (policy.manual_override === 'force_off') return [false, 'Manual override is forcing sharing off.'];
  if (policy.manual_override === 'force_on')  return [true,  'Manual override is forcing sharing on.'];
  if (!policy.master_enabled)                 return [false, 'Master sharing toggle is off.'];
  if (!scheduleAllows(policy, now))           return [false, 'Outside allowed sharing schedule.'];
  if (policy.idle_only_enabled && !idle)      return [false, 'Idle-only mode is waiting for local activity to drop.'];
  return [true, 'Policy allows sharing.'];
}

module.exports = { scheduleAllows, shouldShare };
