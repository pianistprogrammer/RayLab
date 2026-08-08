from datetime import datetime, time

from raylab_sidecar.models import NodePolicy, ScheduleWindow
from raylab_sidecar.policy import schedule_allows, should_share


def test_schedule_allows_overnight_window() -> None:
    policy = NodePolicy(schedule_enabled=True, schedule_windows=[ScheduleWindow(days=[0], start=time(22), end=time(7))])

    assert schedule_allows(policy, datetime(2026, 8, 3, 23, 0)) is True
    assert schedule_allows(policy, datetime(2026, 8, 3, 12, 0)) is False


def test_manual_override_precedence() -> None:
    policy = NodePolicy(master_enabled=False, manual_override="force_on")

    allowed, reason = should_share(policy, idle=False)

    assert allowed is True
    assert "forcing sharing on" in reason


def test_panic_wins_over_everything() -> None:
    policy = NodePolicy(master_enabled=True, manual_override="panic")

    allowed, reason = should_share(policy, idle=True)

    assert allowed is False
    assert "Panic" in reason
