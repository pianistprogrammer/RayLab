from __future__ import annotations

from datetime import datetime, time

from .models import NodePolicy


def _time_in_window(now_time: time, start: time, end: time) -> bool:
    if start <= end:
        return start <= now_time <= end
    return now_time >= start or now_time <= end


def schedule_allows(policy: NodePolicy, now: datetime | None = None) -> bool:
    if not policy.schedule_enabled:
        return True
    if not policy.schedule_windows:
        return False
    current = now or datetime.now()
    for window in policy.schedule_windows:
        if current.weekday() in window.days and _time_in_window(current.time(), window.start, window.end):
            return True
    return False


def should_share(policy: NodePolicy, *, idle: bool, now: datetime | None = None) -> tuple[bool, str]:
    if policy.manual_override == "panic":
        return False, "Panic stop is active for this session."
    if policy.manual_override == "force_off":
        return False, "Manual override is forcing sharing off."
    if policy.manual_override == "force_on":
        return True, "Manual override is forcing sharing on."
    if not policy.master_enabled:
        return False, "Master sharing toggle is off."
    if not schedule_allows(policy, now):
        return False, "Outside allowed sharing schedule."
    if policy.idle_only_enabled and not idle:
        return False, "Idle-only mode is waiting for local activity to drop."
    return True, "Policy allows sharing."
