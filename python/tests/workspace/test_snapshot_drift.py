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

from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.observe.context import RecordingScope, record, start_op
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import DriftPolicy, MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.snapshot import (ContentDriftError, install_fingerprints,
                                       to_state_dict)
from tests.e2e.s3_mock import patch_s3_multi


def _load(*args, **kwargs):
    return asyncio.run(Workspace.load(*args, **kwargs))


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
    assert ws._drift.pending is True
    assert "/m/checked.txt" in ws._drift.paths


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

        dst = _load(snap, resources={"/s3": S3Resource(_config())})
        with pytest.raises(ContentDriftError) as exc_info:
            asyncio.run(dst.execute("cat /s3/data.csv"))
        assert exc_info.value.path == "/s3/data.csv"
        live = exc_info.value.live_fingerprint
        recorded = exc_info.value.snapshot_fingerprint
        assert live != recorded


def test_strict_load_checks_drift_before_an_ops_write(tmp_path):
    """The ops facade (the FUSE path) reaches the dispatcher without
    passing Workspace.dispatch, so the pending checks must run at the
    door itself: a first write may not clobber drifted remote state
    before ContentDriftError fires.
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

        dst = _load(snap, resources={"/s3": S3Resource(_config())})
        with pytest.raises(ContentDriftError):
            asyncio.run(dst.fs.write("/s3/data.csv", b"CLOBBERED\n"))
        assert store["data.csv"] == b"VERSION 2 DRIFTED\n"


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

        dst = _load(snap,
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

        dst = _load(snap, resources={"/s3": S3Resource(_config())})
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

        dst = _load(snap, resources={"/s3": S3Resource(_config())})
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

        dst = _load(snap, resources={"/s3": S3Resource(_config())})
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
        _load(snap)
    assert any("live-only" in r.message.lower()
               or "live-only" in r.getMessage().lower()
               for r in caplog.records) or any(
                   "no drift" in r.message.lower()
                   or "no drift" in r.getMessage().lower()
                   for r in caplog.records)


@pytest.mark.asyncio
@pytest.mark.parametrize("capture", ["state", "copy"])
async def test_snapshot_prepares_new_mount_before_capturing_cache(capture):
    old = {"data/file": b"old", "outside": b"keep", "data2/file": b"sibling"}
    new = {"file": b"new"}
    with patch_s3_multi({"old": old, "new": new}):
        ancestor = S3Resource(_config().model_copy(update={"bucket": "old"}))
        replacement = S3Resource(
            _config().model_copy(update={"bucket": "new"}))
        ws = Workspace({"/": ancestor})
        clone = None
        try:
            assert (await ws.execute("cat /data/file /outside /data2/file")
                    ).stdout == b"oldkeepsibling"
            assert await ws.cache.get("/data/file") == b"old"
            ws.add_mount("/data", replacement)
            if capture == "copy":
                clone = await ws.copy()
            else:
                state = await to_state_dict(ws)
                assert "/data/file" not in [
                    e["key"] for e in state["cache"]["entries"]
                ]
                clone = await Workspace.from_state(state,
                                                   resources={
                                                       "/": ancestor,
                                                       "/data": replacement
                                                   })
            assert await clone.cache.get("/data/file") is None
            assert await clone.cache.get("/outside") == b"keep"
            assert await clone.cache.get("/data2/file") == b"sibling"
            assert (await clone.execute("cat /data/file")).stdout == b"new"
        finally:
            if clone is not None:
                await clone.close()
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("shadow", [False, True])
@pytest.mark.parametrize("delayed", [False, True])
async def test_snapshot_fingerprints_keep_read_mount_ownership(
        shadow, delayed):
    old = {"data/file" if shadow else "file": b"old"}
    with patch_s3_multi({
            "old": old,
            "new": {
                "file": b"new"
            },
            "keep": {
                "file": b"keep"
            }
    }):
        ancestor = S3Resource(_config().model_copy(update={"bucket": "old"}))
        replacement = S3Resource(
            _config().model_copy(update={"bucket": "new"}))
        sibling = S3Resource(_config().model_copy(update={"bucket": "keep"}))
        ws = Workspace({
            "/" if shadow else "/data": ancestor,
            "/data/nested": sibling
        })
        entered = asyncio.Event()
        release = asyncio.Event()

        async def gate(_inv):
            entered.set()
            await release.wait()
            return None, IOResult()

        ws.register_cli("gate", CLISpec(name="gate", fn=gate))
        reading = None
        try:
            await ws.execute("cat /data/nested/file")
            if delayed:
                reading = asyncio.create_task(
                    ws.execute("cat /data/file; gate"))
                await asyncio.wait_for(entered.wait(), 5)
            else:
                await ws.execute("cat /data/file")
            if not shadow:
                await ws.unmount("/data")
            ws.add_mount("/data", replacement)
            release.set()
            if reading is not None:
                assert (await reading).stdout == b"old"
            state = await to_state_dict(ws)
            assert [e["path"]
                    for e in state["fingerprints"]] == ["/data/nested/file"]
            await ws.execute("cat /data/file")
            state = await to_state_dict(ws)
            entries = {e["path"]: e for e in state["fingerprints"]}
            new_read = next(
                r for r in ws._ops.records if r.path == "/data/file"
                and r.mount_id == ws.mount("/data").mount_id and r.fingerprint)
            assert entries["/data/file"]["fingerprint"] == new_read.fingerprint
            assert "/data/nested/file" in entries
        finally:
            release.set()
            if reading is not None:
                await asyncio.gather(reading, return_exceptions=True)
            await ws.close()


@pytest.mark.asyncio
async def test_snapshot_rejects_fingerprint_from_retired_lazy_op():
    resource = RAMResource()
    resource.SUPPORTS_SNAPSHOT = True
    payload = b"old"

    @op("read", resource="ram")
    async def lazy_read(accessor, scope, **kwargs):
        record("read", scope.virtual, "ram", 3, start_op(), fingerprint="old")
        yield payload

    resource.register_op(lazy_read)
    ws = Workspace({"/data": resource})
    scope = RecordingScope()
    try:
        stream, _ = await ws.dispatch("read",
                                      PathSpec.from_str_path("/data/file"))
        old_id = ws.mount("/data").mount_id
        removing = asyncio.create_task(ws.unmount("/data"))
        async with asyncio.timeout(5):
            while ws._registry.try_mount_for_prefix("/data") is not None:
                await asyncio.sleep(0)
        replacement = RAMResource()
        replacement.SUPPORTS_SNAPSHOT = True
        ws.add_mount("/data", replacement)
        async for chunk in stream:
            assert chunk == payload
        ws._ops.records.extend(scope.records)
        await removing
        assert scope.records[0].mount_id == old_id
        assert (await to_state_dict(ws))["fingerprints"] == []
    finally:
        scope.close()
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("shadow", [False, True])
async def test_restored_drift_checks_do_not_follow_replaced_mounts(shadow):
    prefix = "/" if shadow else "/data"
    with patch_s3_multi({"old": {}, "new": {"file": b"new"}}):
        ancestor = S3Resource(_config().model_copy(update={"bucket": "old"}))
        replacement = S3Resource(
            _config().model_copy(update={"bucket": "new"}))
        source = Workspace({prefix: ancestor})
        loaded = None
        try:
            state = await to_state_dict(source)
            state["fingerprints"] = [{
                "path": "/data/file",
                "mount_prefix": prefix,
                "fingerprint": "old-account"
            }]
            loaded = await Workspace.from_state(state,
                                                resources={prefix: ancestor})
            if not shadow:
                await loaded.unmount("/data")
            loaded.add_mount("/data", replacement)
            assert (await loaded.execute("cat /data/file")).stdout == b"new"
        finally:
            if loaded is not None:
                await loaded.close()
            await source.close()
