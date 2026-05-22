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

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountKey, MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot.state import to_state_dict
from mirage.workspace.version.mapping import (blob_to_meta, meta_to_blob,
                                              to_state, to_tree_inputs)


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


def test_meta_blob_round_trip():
    meta = {
        "format": 1,
        "mounts": [],
        "pins": {"/s3/a.txt": {"rev": "v123", "fp": "etag-abc"}},
    }

    parsed = blob_to_meta(meta_to_blob(meta))

    assert parsed["format"] == 1
    assert parsed["pins"]["/s3/a.txt"] == {"rev": "v123", "fp": "etag-abc"}

