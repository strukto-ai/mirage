# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
from datetime import datetime, timezone

import aiohttp

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.events import DiscordEventHook
from mirage.core.discord.history import snowflake_at
from mirage.types import FileChangeKind, PathSpec

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
GUILD = {"id": "900", "name": "Ada's Server"}
GENERAL = {"id": "100", "name": "general", "type": 0, "guild_id": "900"}
THREAD = {"id": "", "name": "a thread", "type": 11, "parent_id": "100"}
CHANNEL_DIR = "/d/Ada's Server__900/channels/general__100"


def _id(year: int, month: int, day: int, hour: int = 12) -> str:
    stamp = datetime(year, month, day, hour, tzinfo=timezone.utc)
    return str(snowflake_at(stamp.timestamp()))


OLD = _id(2026, 9, 20)
LATE = _id(2026, 10, 1, 23)
THREAD_ID = _id(2026, 9, 28)


def _root() -> PathSpec:
    return PathSpec(virtual="/d", directory="/d", vfs_path="")


def _hook(monkeypatch) -> tuple[DiscordEventHook, list[str]]:
    calls: list[str] = []
    objects = {
        "/guilds/900": GUILD,
        "/channels/100": GENERAL,
        f"/channels/{THREAD_ID}": {**THREAD, "id": THREAD_ID},
        "/channels/555": {"id": "555", "name": "voice", "type": 2},
    }

    async def fake_get(config, endpoint, params=None, session=None):
        calls.append(endpoint)
        if endpoint not in objects:
            raise aiohttp.ClientResponseError(
                request_info=None,  # type: ignore[arg-type]
                history=(),
                status=404,
            )
        return dict(objects[endpoint])

    monkeypatch.setattr("mirage.core.discord.events.discord_get", fake_get)
    accessor = DiscordAccessor(DiscordConfig(token="t"))
    hook = DiscordEventHook(accessor)
    hook.objects = objects
    return hook, calls


def _map(hook, event_type, payload) -> list[tuple[FileChangeKind, str]]:
    events = asyncio.run(hook.to_events(_root(), event_type, payload))
    return [(e.kind, e.path.virtual) for e in events]


def test_a_message_updates_the_utc_day_its_id_was_minted_on(monkeypatch):
    hook, _ = _hook(monkeypatch)
    found = _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "100"})
    assert found == [(U, f"{CHANNEL_DIR}/2026-10-01/chat.jsonl")]


def test_a_new_messages_listed_attachments_are_created(monkeypatch):
    hook, _ = _hook(monkeypatch)
    attachments = [
        {"id": "7", "filename": "plan.pdf", "url": "u", "size": 3},
        {"id": "8", "filename": "gone.png"},
    ]
    found = _map(
        hook,
        "MESSAGE_CREATE",
        {"id": LATE, "channel_id": "100", "attachments": attachments},
    )
    assert found == [
        (U, f"{CHANNEL_DIR}/2026-10-01/chat.jsonl"),
        (C, f"{CHANNEL_DIR}/2026-10-01/files/plan__7.pdf"),
    ]


def test_an_edit_or_delete_refreshes_the_day_the_message_was_posted(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    day = f"{CHANNEL_DIR}/2026-09-20"
    expected = [(U, f"{day}/chat.jsonl"), (X, f"{day}/files")]
    for kind in ("MESSAGE_UPDATE", "MESSAGE_DELETE"):
        assert _map(hook, kind, {"id": OLD, "channel_id": "100"}) == expected


def test_a_bulk_delete_names_each_day_once(monkeypatch):
    hook, _ = _hook(monkeypatch)
    found = _map(
        hook,
        "MESSAGE_DELETE_BULK",
        {"ids": [OLD, OLD, LATE], "channel_id": "100"},
    )
    assert [path for _, path in found] == [
        f"{CHANNEL_DIR}/2026-09-20/chat.jsonl",
        f"{CHANNEL_DIR}/2026-09-20/files",
        f"{CHANNEL_DIR}/2026-10-01/chat.jsonl",
        f"{CHANNEL_DIR}/2026-10-01/files",
    ]


def test_a_reaction_updates_its_messages_day(monkeypatch):
    hook, _ = _hook(monkeypatch)
    found = _map(
        hook,
        "MESSAGE_REACTION_ADD",
        {"message_id": OLD, "channel_id": "100", "user_id": "1"},
    )
    assert found == [(U, f"{CHANNEL_DIR}/2026-09-20/chat.jsonl")]


def test_a_thread_message_refreshes_its_starter_in_the_parent(monkeypatch):
    hook, _ = _hook(monkeypatch)
    found = _map(
        hook,
        "MESSAGE_CREATE",
        {
            "id": LATE,
            "channel_id": THREAD_ID,
            "attachments": [{"id": "7", "filename": "a.txt", "url": "u"}],
        },
    )
    assert found == [(U, f"{CHANNEL_DIR}/2026-09-28/chat.jsonl")]


def test_ids_resolve_once_and_unlisted_channels_map_to_nothing(monkeypatch):
    hook, calls = _hook(monkeypatch)
    _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "100"})
    _map(hook, "MESSAGE_UPDATE", {"id": OLD, "channel_id": "100"})
    assert calls == ["/channels/100", "/guilds/900"]
    assert (
        _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "555"}) == []
    )


def test_a_channel_dispatch_renames_and_lists_again(monkeypatch):
    hook, calls = _hook(monkeypatch)
    renamed = {**GENERAL, "name": "lobby"}
    found = _map(hook, "CHANNEL_UPDATE", renamed)
    assert found == [(X, "/d/Ada's Server__900/channels")]
    found = _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "100"})
    assert found == [
        (U, "/d/Ada's Server__900/channels/lobby__100/2026-10-01/chat.jsonl")
    ]
    assert "/channels/100" not in calls


def test_member_and_guild_dispatches_are_unknown_on_their_listing(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    found = _map(hook, "GUILD_MEMBER_ADD", {"guild_id": "900", "user": {}})
    assert found == [(X, "/d/Ada's Server__900/members")]
    assert _map(hook, "GUILD_CREATE", {"id": "900", "name": "New"}) == [
        (X, "/d")
    ]
    assert _map(hook, "GUILD_MEMBER_REMOVE", {"guild_id": "900"}) == [
        (X, "/d/New__900/members")
    ]


def test_a_direct_message_and_an_unknown_dispatch_map_to_nothing(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    assert _map(hook, "MESSAGE_CREATE", {"id": LATE}) == []
    assert _map(hook, "TYPING_START", {"channel_id": "100"}) == []
    assert _map(hook, "MESSAGE_CREATE", "not an object") == []


def test_a_reconnect_forgets_the_guilds_channels(monkeypatch):
    hook, calls = _hook(monkeypatch)
    _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "100"})
    hook.objects["/channels/100"] = {**GENERAL, "name": "lobby"}
    _map(hook, "GUILD_CREATE", {"id": "900", "name": "Ada's Server"})
    found = _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "100"})
    assert found == [
        (U, "/d/Ada's Server__900/channels/lobby__100/2026-10-01/chat.jsonl")
    ]
    assert calls.count("/channels/100") == 2


def test_a_message_from_a_deleted_channel_or_guild_is_unknown_above_it(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    gone = {"id": OLD, "channel_id": "404", "guild_id": "900"}
    assert _map(hook, "MESSAGE_DELETE", gone) == [
        (X, "/d/Ada's Server__900/channels")
    ]
    gone = {"id": OLD, "channel_id": "404", "guild_id": "901"}
    assert _map(hook, "MESSAGE_DELETE", gone) == [(X, "/d")]
    hook.objects["/channels/300"] = {**GENERAL, "id": "300", "guild_id": "901"}
    found = _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "300"})
    assert found == [(X, "/d")]
    found = _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "404"})
    assert found == []
