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

import io

import pytest

from mirage.resource.ram import RAMResource
from mirage.server.version.state_tree import (blob_to_meta, meta_to_blob,
                                              to_state, tree_inputs_from_state)
from mirage.types import (CacheKey, FingerprintKey, MountKey, MountMode,
                          SessionKey, StateKey)
from mirage.workspace import Workspace
from mirage.workspace.snapshot.manifest import split_manifest_and_blobs
from mirage.workspace.snapshot.state import to_state_dict
from mirage.workspace.snapshot.tar_io import read_tar, write_tar


def _mount_files(state: dict, prefix: str) -> dict:
    for mount in state["mounts"]:
        if mount["prefix"] == prefix:
            return mount["resource_state"]["files"]
    raise KeyError(prefix)


@pytest.mark.asyncio
async def test_tree_inputs_from_state_ram_files():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")
    await ws.execute("mkdir -p /m/sub && echo world > /m/sub/b.txt")

    entries, meta = tree_inputs_from_state(await to_state_dict(ws))

    assert entries["m/a.txt"] == b"hello\n"
    assert entries["m/sub/b.txt"] == b"world\n"

    prefixes = [m[MountKey.PREFIX] for m in meta["mounts"]]
    assert "/m/" in prefixes


@pytest.mark.asyncio
async def test_to_state_round_trips_files():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")
    await ws.execute("mkdir -p /m/sub && echo world > /m/sub/b.txt")

    original_files = _mount_files(await to_state_dict(ws), "/m/")
    entries, meta = tree_inputs_from_state(await to_state_dict(ws))
    state = to_state(entries, meta)

    assert _mount_files(state, "/m/") == original_files


@pytest.mark.asyncio
async def test_to_state_is_tar_loadable():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")

    entries, meta = tree_inputs_from_state(await to_state_dict(ws))
    state = to_state(entries, meta)

    manifest, blobs = split_manifest_and_blobs(state)
    buf = io.BytesIO()
    write_tar(buf, manifest, blobs)
    buf.seek(0)
    restored = read_tar(buf)

    assert _mount_files(restored, "/m/")["/a.txt"] == b"hello\n"


@pytest.mark.asyncio
async def test_whole_world_round_trip_sessions_nodes_history():
    """A commit is the whole world: sessions, namespace nodes, and the
    command history round-trip through the .mirage/ control-plane
    subtree. Cache stays out (derived, rebuildable)."""
    ws = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hi > /a.txt")
    state = await to_state_dict(ws)
    state[StateKey.CACHE][CacheKey.ENTRIES] = [{
        CacheKey.KEY: "/a.txt",
        CacheKey.DATA: b"cached-bytes",
        CacheKey.FINGERPRINT: "etag-1",
        CacheKey.TTL: None,
        CacheKey.CACHED_AT: 123.0,
        CacheKey.SIZE: 12,
    }]
    state[StateKey.FINGERPRINTS] = [{
        FingerprintKey.PATH: "/a.txt",
        FingerprintKey.MOUNT_PREFIX: "/",
        FingerprintKey.FINGERPRINT: "etag-1",
        FingerprintKey.REVISION: "v1",
    }]
    state[StateKey.SESSIONS] = [{
        SessionKey.SESSION_ID: "agent_a",
        SessionKey.CWD: "/sub",
        SessionKey.ENV: {
            "API_KEY": "@aws:prod-key"
        },
        "mount_modes": {
            "/": "read"
        },
    }]
    state[StateKey.NODES] = {"/link.txt": {"target": "/a.txt"}}
    state[StateKey.HISTORY] = [{
        "type": "COMMAND",
        "command": "echo hi > /a.txt",
        "timestamp": 123.0,
        "session": "agent_a",
    }, {
        "type": "COMMAND",
        "command": "cat /a.txt",
        "timestamp": 456.0,
        "session": "agent_b",
    }]

    entries, meta = tree_inputs_from_state(state)
    meta = blob_to_meta(meta_to_blob(meta))
    restored = to_state(entries, meta)

    files = _mount_files(restored, "/")
    assert files["/a.txt"] == b"hi\n"
    assert restored[StateKey.FINGERPRINTS][0][FingerprintKey.REVISION] == "v1"

    session = restored[StateKey.SESSIONS][0]
    assert session[SessionKey.CWD] == "/sub"
    assert session[SessionKey.ENV] == {"API_KEY": "@aws:prod-key"}
    assert session["mount_modes"] == {"/": "read"}
    assert restored[StateKey.NODES] == {"/link.txt": {"target": "/a.txt"}}
    assert [e["command"] for e in restored[StateKey.HISTORY]
            ] == ["echo hi > /a.txt", "cat /a.txt"]

    # Cache is the one exclusion: derived and rebuildable.
    assert restored[StateKey.CACHE][CacheKey.ENTRIES] == []
    assert all(b"cached-bytes" not in data for data in entries.values())

    # Control-plane state lives under .mirage/, never in mount files.
    assert ".mirage/sessions.json" in entries
    assert ".mirage/namespace.json" in entries
    # One history file per session, mirroring the live ObserverStore.
    assert ".mirage/history/agent_a.jsonl" in entries
    assert ".mirage/history/agent_b.jsonl" in entries
    assert all(not p.startswith(".mirage/") for p in files)


@pytest.mark.asyncio
async def test_control_plane_files_never_leak_into_mount_files():
    ws = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hi > /a.txt")
    state = await to_state_dict(ws)
    state[StateKey.SESSIONS] = [{
        SessionKey.SESSION_ID: "agent_a",
        SessionKey.ENV: {
            "API_KEY": "@aws:prod-key"
        },
    }]

    entries, meta = tree_inputs_from_state(state)
    restored = to_state(entries, blob_to_meta(meta_to_blob(meta)))

    files = _mount_files(restored, "/")
    assert list(files) == ["/a.txt"]


def test_meta_blob_round_trip():
    meta = {
        "mounts": [],
        "pins": {
            "/s3/a.txt": {
                "rev": "v123",
                "fp": "etag-abc"
            }
        },
    }

    parsed = blob_to_meta(meta_to_blob(meta))

    assert parsed["pins"]["/s3/a.txt"] == {"rev": "v123", "fp": "etag-abc"}
