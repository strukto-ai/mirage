import pytest

from mirage.core.slack.events.hook import SlackEventHook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.slack import SlackVFS
from mirage.vfs.slack.config import SlackConfig
from tests.fixtures.slack_workspace import SlackWorkspace

TS = "1755300600.000100"
LATE = "1755320400.000100"
INFO = "/api/conversations.info"


def _root() -> PathSpec:
    return PathSpec(virtual="/s", directory="/s", vfs_path="")


def _hook(workspace: SlackWorkspace) -> SlackEventHook:
    return SlackEventHook(workspace.accessor())


async def _map(hook, event_type, payload):
    return await hook.to_events(_root(), event_type, payload)


@pytest.mark.asyncio
async def test_a_message_updates_that_days_transcript(slack_workspace):
    events = await _map(
        _hook(slack_workspace), "message", {"channel": "C1", "ts": TS}
    )
    assert len(events) == 1
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == (
        "/s/channels/general__C1/2025-08-15/chat.jsonl"
    )


@pytest.mark.asyncio
async def test_a_late_evening_message_lands_in_the_next_utc_day(
    slack_workspace,
):
    # The trap a consumer reimplementing this would fall into: Slack
    # shows 10pm PDT on the 15th, the mount serves the 16th.
    events = await _map(
        _hook(slack_workspace), "message", {"channel": "C1", "ts": LATE}
    )
    assert events[0].path.virtual == (
        "/s/channels/general__C1/2025-08-16/chat.jsonl"
    )


@pytest.mark.asyncio
async def test_a_deletion_refreshes_the_day_it_happened_on(slack_workspace):
    events = await _map(
        _hook(slack_workspace),
        "message",
        {
            "channel": "C1",
            "subtype": "message_deleted",
            "ts": LATE,
            "deleted_ts": TS,
        },
    )
    assert events[0].path.virtual == (
        "/s/channels/general__C1/2025-08-15/chat.jsonl"
    )


@pytest.mark.asyncio
async def test_a_dm_is_named_after_the_other_person(slack_workspace):
    # D1 is ana's DM, so its directory takes her name from users.info.
    events = await _map(
        _hook(slack_workspace), "message", {"channel": "D1", "ts": TS}
    )
    assert events[0].path.virtual == "/s/dms/ana__D1/2025-08-15/chat.jsonl"


@pytest.mark.asyncio
async def test_a_channel_name_is_resolved_once(slack_workspace):
    hook = _hook(slack_workspace)
    await _map(hook, "message", {"channel": "C1", "ts": TS})
    await _map(hook, "message", {"channel": "C1", "ts": LATE})
    assert await slack_workspace.count(INFO) == 1


@pytest.mark.asyncio
async def test_a_reaction_updates_the_transcript_it_annotates(
    slack_workspace,
):
    events = await _map(
        _hook(slack_workspace),
        "reaction_added",
        {"item": {"channel": "C1", "ts": TS}},
    )
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == (
        "/s/channels/general__C1/2025-08-15/chat.jsonl"
    )


@pytest.mark.asyncio
async def test_a_pin_updates_the_transcript(slack_workspace):
    events = await _map(
        _hook(slack_workspace),
        "pin_added",
        {"item": {"channel": "C1", "ts": TS}},
    )
    assert events[0].kind is FileChangeKind.UPDATE


@pytest.mark.asyncio
async def test_a_shared_file_re_inventories_that_days_attachments(
    slack_workspace,
):
    # The rendered name comes from file_blob_name over metadata the
    # notification does not carry, so the directory is the honest answer.
    events = await _map(
        _hook(slack_workspace),
        "file_shared",
        {"file_id": "F1", "channel_id": "C1", "event_ts": TS},
    )
    assert events[0].kind is FileChangeKind.UNKNOWN
    assert events[0].path.virtual == "/s/channels/general__C1/2025-08-15/files"


@pytest.mark.asyncio
async def test_a_channel_listing_change_re_inventories_channels(
    slack_workspace,
):
    hook = _hook(slack_workspace)
    for kind in ("channel_created", "channel_archive", "group_rename"):
        events = await _map(
            hook, kind, {"channel": {"id": "C1", "name": "new"}}
        )
        assert events[0].kind is FileChangeKind.UNKNOWN
        assert events[0].path.virtual == "/s/channels"


@pytest.mark.asyncio
async def test_a_rename_drops_the_memoized_directory(slack_workspace):
    hook = _hook(slack_workspace)
    await _map(hook, "message", {"channel": "C1", "ts": TS})
    await _map(
        hook, "channel_rename", {"channel": {"id": "C1", "name": "eng"}}
    )
    await _map(hook, "message", {"channel": "C1", "ts": TS})
    assert await slack_workspace.count(INFO) == 2


@pytest.mark.asyncio
async def test_a_deleted_channel_names_the_id_as_a_string(slack_workspace):
    hook = _hook(slack_workspace)
    await _map(hook, "message", {"channel": "C1", "ts": TS})
    await _map(hook, "channel_deleted", {"channel": "C1"})
    await _map(hook, "message", {"channel": "C1", "ts": TS})
    assert await slack_workspace.count(INFO) == 2


@pytest.mark.asyncio
async def test_an_im_created_re_inventories_dms(slack_workspace):
    events = await _map(
        _hook(slack_workspace), "im_created", {"channel": {"id": "D1"}}
    )
    assert events[0].path.virtual == "/s/dms"


@pytest.mark.asyncio
async def test_a_profile_change_re_inventories_users(slack_workspace):
    hook = _hook(slack_workspace)
    for kind in ("user_change", "team_join"):
        events = await _map(hook, kind, {"user": {"id": "U1"}})
        assert events[0].kind is FileChangeKind.UNKNOWN
        assert events[0].path.virtual == "/s/users"


@pytest.mark.asyncio
async def test_an_unhandled_event_maps_to_nothing(slack_workspace):
    hook = _hook(slack_workspace)
    assert await _map(hook, "member_joined_channel", {"channel": "C1"}) == ()
    assert await slack_workspace.run.requests() == []


@pytest.mark.asyncio
async def test_a_message_without_a_channel_maps_to_nothing(slack_workspace):
    assert await _map(_hook(slack_workspace), "message", {"ts": TS}) == ()
    assert await slack_workspace.run.requests() == []


@pytest.mark.asyncio
async def test_a_non_object_payload_maps_to_nothing(slack_workspace):
    assert await _map(_hook(slack_workspace), "message", "not-an-object") == ()


def test_a_consumer_builds_the_hook_from_the_accessor():
    # A consumer reaches the hook by importing it, not through the
    # VFS: the payload it must build is Slack's own shape, so the
    # call site names the backend either way.
    vfs = SlackVFS(SlackConfig(token="xoxb-t"))
    assert isinstance(SlackEventHook(vfs.accessor), SlackEventHook)
