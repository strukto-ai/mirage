import asyncio
import os

import pytest

from mirage.core.redis.watch.hook import RedisEventHook
from mirage.types import FileChangeKind, MountMode, PathSpec
from mirage.vfs.redis import RedisVFS
from mirage.workspace import Workspace

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


def _root() -> PathSpec:
    return PathSpec(virtual="/r", directory="/r", vfs_path="")


def _hook(prefix: str = "wt:") -> RedisEventHook:
    return RedisEventHook(RedisVFS(url=REDIS_URL, key_prefix=prefix).accessor)


def _map(event_type: str, key: str):
    return asyncio.run(_hook().to_events(_root(), event_type, key))


def test_set_maps_to_an_update_on_the_virtual_path():
    events = _map("set", "wt:file:/day/a.txt")
    assert len(events) == 1
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == "/r/day/a.txt"
    assert events[0].path.vfs_path == "day/a.txt"


def test_deletions_map_to_delete():
    for verb in ("del", "unlink", "expired", "evicted", "rename_from"):
        assert _map(verb,
                    "wt:file:/day/a.txt")[0].kind is FileChangeKind.DELETE


def test_rename_to_maps_to_an_update_on_the_new_key():
    events = _map("rename_to", "wt:file:/day/new.txt")
    assert events[0].kind is FileChangeKind.UPDATE
    assert events[0].path.virtual == "/r/day/new.txt"


def test_side_keys_map_to_nothing():
    assert _map("set", "wt:modified:/day/a.txt") == ()
    assert _map("set", "wt:attrs:/day/a.txt") == ()


def test_a_dir_set_change_re_inventories_the_mount():
    # The message names the set, never the member, and an empty
    # directory has no file: key, so the mount root is the narrowest
    # honest answer.
    events = _map("sadd", "wt:dir")
    assert events[0].kind is FileChangeKind.UNKNOWN
    assert events[0].path.virtual == "/r"
    assert _map("srem", "wt:dir")[0].kind is FileChangeKind.UNKNOWN


def test_an_unrelated_verb_on_the_dir_set_maps_to_nothing():
    assert _map("smembers", "wt:dir") == ()


def test_a_key_from_another_namespace_maps_to_nothing():
    assert _map("set", "other:file:/day/a.txt") == ()


def test_an_unhandled_verb_maps_to_nothing():
    assert _map("expire", "wt:file:/day/a.txt") == ()


def test_a_non_string_payload_maps_to_nothing():
    assert _map("set", {"key": "wt:file:/a.txt"}) == ()


@pytest.mark.asyncio
async def test_a_real_keyspace_notification_refreshes_the_listing():
    prefix = "wtlive:"
    watched = RedisVFS(url=REDIS_URL, key_prefix=prefix)
    ws = Workspace({"/r": (watched, MountMode.WRITE)}, mode=MountMode.WRITE)
    other = Workspace(
        {"/r": (RedisVFS(url=REDIS_URL, key_prefix=prefix), MountMode.WRITE)},
        mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /r/day")
        await ws.shell("sh -c 'echo one > /r/day/a.txt'")
        assert "a.txt" in await (await ws.shell("ls /r/day")).stdout_str()

        # The external writer is a second workspace over the same redis,
        # so the watched workspace's caches never see the write.
        await other.shell("sh -c 'echo two > /r/day/b.txt'")

        # Exactly what a `__keyevent@N__:set` subscriber would forward.
        hook = RedisEventHook(watched.accessor)
        for change in await hook.to_events(_root(), "set",
                                           f"{prefix}file:/day/b.txt"):
            await ws.notify(change)

        assert "b.txt" in await (await ws.shell("ls /r/day")).stdout_str()
    finally:
        await ws.shell("rm -rf /r/day")
        await ws.close()
        await other.close()
