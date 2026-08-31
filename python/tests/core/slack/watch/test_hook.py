import asyncio

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.watch.hook import SlackEventHook
from mirage.resource.slack import SlackResource
from mirage.types import FileChangeKind, PathSpec

# 2025-08-15T23:30:00Z is 4:30pm PDT the same day, so client and mount
# agree; 2025-08-16T05:00:00Z is 10pm PDT on the 15th, where they do not.
TS = "1755300600.000100"
LATE = "1755320400.000100"


def _root() -> PathSpec:
    return PathSpec(virtual="/s", directory="/s", resource_path="")


def _hook(monkeypatch, channel: dict, user: dict | None = None) -> tuple:
    calls: list[tuple[str, dict]] = []

    async def fake_get(config, method, params=None, session=None):
        calls.append((method, params or {}))
        if method == "conversations.info":
            return {"ok": True, "channel": channel}
        return {"ok": True, "user": user or {}}

    monkeypatch.setattr("mirage.core.slack.watch.hook.slack_get", fake_get)
    accessor = SlackAccessor(SlackConfig(token="xoxb-t"))
    return SlackEventHook(accessor), calls


def _map(hook, event_type, payload):
    return asyncio.run(hook.to_events(_root(), event_type, payload))


def test_a_message_updates_that_days_transcript(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(hook, "message", {"channel": "C0288", "ts": TS})
    assert len(events) == 1
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == (
        "/s/channels/general__C0288/2025-08-15/chat.jsonl")


def test_a_late_evening_message_lands_in_the_next_utc_day(monkeypatch):
    # The trap a consumer reimplementing this would fall into: Slack
    # shows 10pm PDT on the 15th, the mount serves the 16th.
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(hook, "message", {"channel": "C0288", "ts": LATE})
    assert events[0].path.virtual == (
        "/s/channels/general__C0288/2025-08-16/chat.jsonl")


def test_a_deletion_refreshes_the_day_it_happened_on(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(
        hook, "message", {
            "channel": "C0288",
            "subtype": "message_deleted",
            "ts": LATE,
            "deleted_ts": TS,
        })
    assert events[0].path.virtual == (
        "/s/channels/general__C0288/2025-08-15/chat.jsonl")


def test_a_dm_is_named_after_the_other_person(monkeypatch):
    hook, _ = _hook(
        monkeypatch,
        {
            "id": "D0777",
            "is_im": True,
            "user": "U0431"
        },
        user={"name": "ada"},
    )
    events = _map(hook, "message", {"channel": "D0777", "ts": TS})
    assert events[0].path.virtual == (
        "/s/dms/ada__D0777/2025-08-15/chat.jsonl")


def test_a_channel_name_is_resolved_once(monkeypatch):
    hook, calls = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    _map(hook, "message", {"channel": "C0288", "ts": TS})
    _map(hook, "message", {"channel": "C0288", "ts": LATE})
    assert [m for m, _ in calls] == ["conversations.info"]


def test_a_reaction_updates_the_transcript_it_annotates(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(hook, "reaction_added",
                  {"item": {
                      "channel": "C0288",
                      "ts": TS
                  }})
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == (
        "/s/channels/general__C0288/2025-08-15/chat.jsonl")


def test_a_pin_updates_the_transcript(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(hook, "pin_added", {"item": {"channel": "C0288", "ts": TS}})
    assert events[0].kind is FileChangeKind.UPDATE


def test_a_shared_file_re_inventories_that_days_attachments(monkeypatch):
    # The rendered name comes from file_blob_name over metadata the
    # notification does not carry, so the directory is the honest answer.
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    events = _map(hook, "file_shared", {
        "file_id": "F1",
        "channel_id": "C0288",
        "event_ts": TS
    })
    assert events[0].kind is FileChangeKind.UNKNOWN
    assert events[0].path.virtual == (
        "/s/channels/general__C0288/2025-08-15/files")


def test_a_channel_listing_change_re_inventories_channels(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    for kind in ("channel_created", "channel_archive", "group_rename"):
        events = _map(hook, kind, {"channel": {"id": "C0288", "name": "new"}})
        assert events[0].kind is FileChangeKind.UNKNOWN
        assert events[0].path.virtual == "/s/channels"


def test_a_rename_drops_the_memoized_directory(monkeypatch):
    hook, calls = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    _map(hook, "message", {"channel": "C0288", "ts": TS})
    _map(hook, "channel_rename", {"channel": {"id": "C0288", "name": "eng"}})
    _map(hook, "message", {"channel": "C0288", "ts": TS})
    assert [m
            for m, _ in calls] == ["conversations.info", "conversations.info"]


def test_a_deleted_channel_names_the_id_as_a_string(monkeypatch):
    hook, calls = _hook(monkeypatch, {"id": "C0288", "name": "general"})
    _map(hook, "message", {"channel": "C0288", "ts": TS})
    _map(hook, "channel_deleted", {"channel": "C0288"})
    _map(hook, "message", {"channel": "C0288", "ts": TS})
    assert len(calls) == 2


def test_an_im_created_re_inventories_dms(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "D0777"})
    events = _map(hook, "im_created", {"channel": {"id": "D0777"}})
    assert events[0].path.virtual == "/s/dms"


def test_a_profile_change_re_inventories_users(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288"})
    for kind in ("user_change", "team_join"):
        events = _map(hook, kind, {"user": {"id": "U0431"}})
        assert events[0].kind is FileChangeKind.UNKNOWN
        assert events[0].path.virtual == "/s/users"


def test_an_unhandled_event_maps_to_nothing(monkeypatch):
    hook, calls = _hook(monkeypatch, {"id": "C0288"})
    assert _map(hook, "member_joined_channel", {"channel": "C0288"}) == ()
    assert calls == []


def test_a_message_without_a_channel_maps_to_nothing(monkeypatch):
    hook, calls = _hook(monkeypatch, {"id": "C0288"})
    assert _map(hook, "message", {"ts": TS}) == ()
    assert calls == []


def test_a_non_object_payload_maps_to_nothing(monkeypatch):
    hook, _ = _hook(monkeypatch, {"id": "C0288"})
    assert _map(hook, "message", "not-an-object") == ()


def test_a_consumer_builds_the_hook_from_the_accessor():
    # A consumer reaches the hook by importing it, not through the
    # resource: the payload it must build is Slack's own shape, so the
    # call site names the backend either way.
    resource = SlackResource(SlackConfig(token="xoxb-t"))
    assert isinstance(SlackEventHook(resource.accessor), SlackEventHook)
