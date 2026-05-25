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
from contextlib import ExitStack

import pytest

from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import DriftPolicy, MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot import ContentDriftError, install_fingerprints
from tests.integration.s3_mock import patch_s3_multi


def test_install_fingerprints_pins_revision_and_queues_drift():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    entries = [
        {
            "path": "/m/pinned.txt",
            "mount_prefix": "/m/",
            "revision": "v9"
        },
        {
            "path": "/m/checked.txt",
            "mount_prefix": "/m/",
            "fingerprint": "fp1"
        },
    ]

    install_fingerprints(ws, entries, DriftPolicy.STRICT)

    mount = ws._registry.mount_for("/m/pinned.txt")
    assert mount.revisions["/m/pinned.txt"] == "v9"
    assert ws._drift_check_pending is True
    queued = [path for (_, path, _) in ws._pending_drift]
    assert "/m/checked.txt" in queued


def _config() -> S3Config:
    return S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )


def test_strict_load_raises_when_s3_etag_drifts(tmp_path):
    """Snapshot a workspace with one read on /s3, mutate the underlying
    object so its ETag changes, load with strict policy: the next read
    must raise ContentDriftError rather than silently serve drifted
    bytes.
    """
    store = {"data.csv": b"version 1 bytes\n"}
    with ExitStack() as stack:
        stack.enter_context(patch_s3_multi({"test-bucket": store}))
        src = Workspace({"/s3": (S3Resource(_config()), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        result = asyncio.run(src.execute("cat /s3/data.csv"))
        assert b"version 1" in result.stdout

        snap = tmp_path / "snap.tar"
        asyncio.run(src.snapshot(snap))
        store["data.csv"] = b"VERSION 2 DRIFTED\n"

        dst = Workspace.load(snap, resources={"/s3": S3Resource(_config())})
        with pytest.raises(ContentDriftError) as exc_info:
            asyncio.run(dst.execute("cat /s3/data.csv"))
        assert exc_info.value.path == "/s3/data.csv"
        live = exc_info.value.live_fingerprint
        recorded = exc_info.value.snapshot_fingerprint
        assert live != recorded


def test_off_load_serves_drifted_bytes_silently(tmp_path):
    """drift_policy=OFF disables the check: the load returns the new
    bytes with no error. This is the only opt-out from drift detection.
    """
    store = {"data.csv": b"version 1 bytes\n"}
    with ExitStack() as stack:
        stack.enter_context(patch_s3_multi({"test-bucket": store}))
        src = Workspace({"/s3": (S3Resource(_config()), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        asyncio.run(src.execute("cat /s3/data.csv"))

        snap = tmp_path / "snap.tar"
        asyncio.run(src.snapshot(snap))
        store["data.csv"] = b"VERSION 2 DRIFTED\n"

        dst = Workspace.load(snap,
                             resources={"/s3": S3Resource(_config())},
                             drift_policy=DriftPolicy.OFF)
        result = asyncio.run(dst.execute("cat /s3/data.csv"))
        assert b"VERSION 2 DRIFTED" in result.stdout


def test_strict_load_passes_when_etag_unchanged(tmp_path):
    """The control case: same bytes still in S3, strict load must succeed
    and serve them. Verifies the check is precise (no false positives).
    """
    store = {"data.csv": b"stable bytes\n"}
    with ExitStack() as stack:
        stack.enter_context(patch_s3_multi({"test-bucket": store}))
        src = Workspace({"/s3": (S3Resource(_config()), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        asyncio.run(src.execute("cat /s3/data.csv"))

        snap = tmp_path / "snap.tar"
        asyncio.run(src.snapshot(snap))

        dst = Workspace.load(snap, resources={"/s3": S3Resource(_config())})
        result = asyncio.run(dst.execute("cat /s3/data.csv"))
        assert b"stable bytes" in result.stdout


def test_unrecorded_path_skips_drift_check(tmp_path):
    """A path the agent did not read at snapshot time has no recorded
    fingerprint, so it must NOT be drift-checked at load — just live-
    served. Tests that drift-check is opt-in per recorded path.
    """
    store = {
        "read-me.txt": b"recorded\n",
        "added-later.txt": b"not in snapshot\n"
    }
    with ExitStack() as stack:
        stack.enter_context(patch_s3_multi({"test-bucket": store}))
        src = Workspace({"/s3": (S3Resource(_config()), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        asyncio.run(src.execute("cat /s3/read-me.txt"))

        snap = tmp_path / "snap.tar"
        asyncio.run(src.snapshot(snap))

        dst = Workspace.load(snap, resources={"/s3": S3Resource(_config())})
        result = asyncio.run(dst.execute("cat /s3/added-later.txt"))
        assert b"not in snapshot" in result.stdout


def test_version_pin_serves_original_bytes_on_versioned_bucket(tmp_path):
    """On a versioned S3 bucket, snapshot captures the object's VersionId
    alongside its ETag. After the live bytes drift, load with default
    STRICT policy pins reads to the recorded VersionId and serves the
    ORIGINAL bytes the agent saw, instead of raising drift or returning
    the current head.
    """
    store = {"data.csv": b"original\n"}
    with ExitStack() as stack:
        stack.enter_context(
            patch_s3_multi({"test-bucket": store}, versioned={"test-bucket"}))
        src = Workspace({"/s3": (S3Resource(_config()), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        asyncio.run(src.execute("cat /s3/data.csv"))

        snap = tmp_path / "snap.tar"
        asyncio.run(src.snapshot(snap))
        store["data.csv"] = b"mutated bytes\n"

        dst = Workspace.load(snap, resources={"/s3": S3Resource(_config())})
        # Cache holds snapshot bytes; clear so we hit S3 and exercise the
        # pin path, not the cache path.
        _drop_path_from_cache(dst, "/s3/data.csv")
        result = asyncio.run(dst.execute("cat /s3/data.csv"))
        assert result.stdout == b"original\n"


def _drop_path_from_cache(ws, path: str) -> None:
    cache = ws._cache
    cache._entries.pop(path, None)
    cache._store.files.pop(path, None)


def test_live_only_mount_does_not_block_snapshot(tmp_path, caplog):
    """Workspaces with non-SUPPORTS_SNAPSHOT mounts (RAM here as a stand-
    in for Gmail/Slack/Linear) snapshot fine; no fingerprints are
    captured for those paths and the load layer logs an honest warning
    surfacing the live-only mount list.
    """
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo body > /m/note.txt"))
    asyncio.run(src.execute("cat /m/note.txt"))

    snap = tmp_path / "snap.tar"
    asyncio.run(src.snapshot(snap))

    with caplog.at_level("WARNING"):
        Workspace.load(snap)
    assert any("live-only" in r.message.lower()
               or "live-only" in r.getMessage().lower()
               for r in caplog.records) or any(
                   "no drift" in r.message.lower()
                   or "no drift" in r.getMessage().lower()
                   for r in caplog.records)
