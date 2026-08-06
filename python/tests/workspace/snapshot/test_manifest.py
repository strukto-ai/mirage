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
from typing import Any

from mirage.types import CacheKey, JobKey, MountKey, StateKey
from mirage.workspace.snapshot.manifest import split_manifest_and_blobs
from mirage.workspace.snapshot.tar_io import read_tar, write_tar
from mirage.workspace.snapshot.utils import BLOB_REF_KEY


def _state() -> dict[str, Any]:
    return {
        StateKey.VERSION: 2,
        StateKey.MIRAGE_VERSION: "0.0.0",
        StateKey.DEFAULT_SESSION_ID: "s1",
        StateKey.DEFAULT_AGENT_ID: None,
        StateKey.CURRENT_AGENT_ID: None,
        StateKey.SESSIONS: [],
        StateKey.MOUNTS: [],
        StateKey.CACHE: {
            CacheKey.LIMIT: 10,
            CacheKey.MAX_DRAIN_BYTES: None,
            CacheKey.ENTRIES: [],
        },
        StateKey.JOBS: [],
    }


def test_a_key_the_splitter_never_heard_of_rides_through():
    # The regression guard for the whole bug class: state grows a key,
    # nobody touches manifest.py, and a tar snapshot still carries it.
    # An allowlist dropped such a key silently, with every in-memory
    # snapshot test still green (they never pass through here).
    state = _state()
    state["future_thing"] = {"a": 1, "b": ["c"]}

    manifest, blobs = split_manifest_and_blobs(state)
    assert manifest["future_thing"] == {"a": 1, "b": ["c"]}

    buf = io.BytesIO()
    write_tar(buf, manifest, blobs)
    buf.seek(0)
    assert read_tar(buf)["future_thing"] == {"a": 1, "b": ["c"]}


def test_known_keys_keep_their_captured_values():
    state = _state()
    state[StateKey.CLIS] = [{"name": "pager", "spec": "pager", "config": None}]
    state[StateKey.NODES] = {"/a": {"target": "/b"}}
    state[StateKey.FINGERPRINTS] = [{"path": "/a", "mount_prefix": "/"}]
    state[StateKey.LIVE_ONLY_MOUNTS] = ["/gmail"]

    manifest, _ = split_manifest_and_blobs(state)

    assert manifest[StateKey.CLIS] == state[StateKey.CLIS]
    assert manifest[StateKey.NODES] == state[StateKey.NODES]
    assert manifest[StateKey.FINGERPRINTS] == state[StateKey.FINGERPRINTS]
    assert manifest[StateKey.LIVE_ONLY_MOUNTS] == ["/gmail"]
    assert manifest[StateKey.VERSION] == 2
    assert manifest[StateKey.SESSIONS] == []


def test_cache_entry_bytes_become_a_blob_reference():
    state = _state()
    state[StateKey.CACHE][CacheKey.ENTRIES] = [{
        "key": "/a",
        CacheKey.DATA: b"hello"
    }]

    manifest, blobs = split_manifest_and_blobs(state)

    entry = manifest[StateKey.CACHE][CacheKey.ENTRIES][0]
    ref = entry[CacheKey.DATA][BLOB_REF_KEY]
    assert blobs[ref] == b"hello"
    # Sibling cache knobs survive the rewrite of the entries list.
    assert manifest[StateKey.CACHE][CacheKey.LIMIT] == 10


def test_job_streams_become_blob_references_and_empty_becomes_text():
    state = _state()
    state[StateKey.JOBS] = [{
        JobKey.ID: 1,
        JobKey.STDOUT: b"out",
        JobKey.STDERR: b"",
    }]

    manifest, blobs = split_manifest_and_blobs(state)

    job = manifest[StateKey.JOBS][0]
    assert blobs[job[JobKey.STDOUT][BLOB_REF_KEY]] == b"out"
    assert job[JobKey.STDERR] == ""


def test_mount_resource_state_is_rewritten_not_passed_through():
    state = _state()
    state[StateKey.MOUNTS] = [{
        MountKey.INDEX: 0,
        MountKey.PREFIX: "/m",
        MountKey.RESOURCE_STATE: {
            "type": "ram",
            "files": {
                "/a.txt": b"hi"
            },
        },
    }]

    manifest, blobs = split_manifest_and_blobs(state)

    files = manifest[StateKey.MOUNTS][0][MountKey.RESOURCE_STATE]["files"]
    assert blobs[files["/a.txt"][BLOB_REF_KEY]] == b"hi"
