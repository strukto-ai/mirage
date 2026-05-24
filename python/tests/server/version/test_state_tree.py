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
                                              to_state, to_tree_inputs,
                                              tree_inputs_from_state)
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
async def test_to_tree_inputs_ram_files():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")
    await ws.execute("mkdir -p /m/sub && echo world > /m/sub/b.txt")

    entries, meta = to_tree_inputs(ws)

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

    original_files = _mount_files(to_state_dict(ws), "/m/")
    entries, meta = to_tree_inputs(ws)
    state = to_state(entries, meta)

    assert _mount_files(state, "/m/") == original_files


@pytest.mark.asyncio
async def test_tree_inputs_from_state_matches_ws_path():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hi > /m/a.txt")

    entries_ws, _ = to_tree_inputs(ws)
    entries_state, _ = tree_inputs_from_state(to_state_dict(ws))

    assert entries_ws == entries_state
    assert entries_state["m/a.txt"] == b"hi\n"


@pytest.mark.asyncio
async def test_to_state_is_tar_loadable():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")

    entries, meta = to_tree_inputs(ws)
    state = to_state(entries, meta)

    manifest, blobs = split_manifest_and_blobs(state)
    buf = io.BytesIO()
    write_tar(buf, manifest, blobs)
    buf.seek(0)
    restored = read_tar(buf)

    assert _mount_files(restored, "/m/")["/a.txt"] == b"hello\n"


@pytest.mark.asyncio
async def test_cache_fingerprints_sessions_round_trip():
    ws = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hi > /a.txt")
    state = to_state_dict(ws)
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
            "FOO": "bar"
        },
    }]

    entries, meta = tree_inputs_from_state(state)
    meta = blob_to_meta(meta_to_blob(meta))
    restored = to_state(entries, meta)

    cache_entries = restored[StateKey.CACHE][CacheKey.ENTRIES]
    assert len(cache_entries) == 1
    assert cache_entries[0][CacheKey.DATA] == b"cached-bytes"
    assert cache_entries[0][CacheKey.KEY] == "/a.txt"
    assert restored[StateKey.FINGERPRINTS][0][FingerprintKey.REVISION] == "v1"
    assert restored[StateKey.SESSIONS][0][SessionKey.CWD] == "/sub"
    assert restored[StateKey.SESSIONS][0][SessionKey.ENV] == {"FOO": "bar"}

    files = _mount_files(restored, "/")
    assert files["/a.txt"] == b"hi\n"
    assert all(".mirage-cache" not in k for k in files)


@pytest.mark.asyncio
async def test_cache_and_pins_survive_tar():
    ws = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hi > /a.txt")
    state = to_state_dict(ws)
    state[StateKey.CACHE][CacheKey.ENTRIES] = [{
        CacheKey.KEY: "/a.txt",
        CacheKey.DATA: b"cached-bytes",
        CacheKey.FINGERPRINT: "etag-1",
        CacheKey.TTL: None,
        CacheKey.CACHED_AT: 1.0,
        CacheKey.SIZE: 12,
    }]
    state[StateKey.FINGERPRINTS] = [{
        FingerprintKey.PATH: "/a.txt",
        FingerprintKey.MOUNT_PREFIX: "/",
        FingerprintKey.REVISION: "v1",
    }]
    state[StateKey.SESSIONS] = [{
        SessionKey.SESSION_ID: "agent_a",
        SessionKey.CWD: "/sub",
        SessionKey.ENV: {
            "FOO": "bar"
        },
    }]

    entries, meta = tree_inputs_from_state(state)
    meta = blob_to_meta(meta_to_blob(meta))
    rebuilt = to_state(entries, meta)

    manifest, blobs = split_manifest_and_blobs(rebuilt)
    buf = io.BytesIO()
    write_tar(buf, manifest, blobs)
    buf.seek(0)
    restored = read_tar(buf)

    ce = restored[StateKey.CACHE][CacheKey.ENTRIES]
    assert ce[0][CacheKey.DATA] == b"cached-bytes"
    assert restored[StateKey.FINGERPRINTS][0][FingerprintKey.REVISION] == "v1"
    sessions = {
        s[SessionKey.SESSION_ID]: s
        for s in restored[StateKey.SESSIONS]
    }
    assert sessions["agent_a"][SessionKey.CWD] == "/sub"


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
