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
import errno
import time

from mirage.types import ConsistencyPolicy, MountMode
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session


def test_disk_always_refetches_after_external_mutation(tmp_path):
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")

    vfs = DiskVFS(root=str(root))
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )

    async def run() -> tuple[bytes, bytes]:
        io1 = await ws.shell("cat /data/file.txt")
        first = await io1.materialize_stdout()
        time.sleep(1.1)
        (root / "file.txt").write_bytes(b"v2")
        io2 = await ws.shell("cat /data/file.txt")
        second = await io2.materialize_stdout()
        return first, second

    first, second = asyncio.run(run())
    assert first == b"v1"
    assert second == b"v2", (
        "ALWAYS must refetch from disk after mtime changed; got stale cache")


def test_disk_lazy_keeps_stale_cache_after_external_mutation(tmp_path):
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")

    vfs = DiskVFS(root=str(root))
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.LAZY,
    )

    async def run() -> tuple[bytes, bytes]:
        io1 = await ws.shell("cat /data/file.txt")
        first = await io1.materialize_stdout()
        time.sleep(1.1)
        (root / "file.txt").write_bytes(b"v2")
        io2 = await ws.shell("cat /data/file.txt")
        second = await io2.materialize_stdout()
        return first, second

    first, second = asyncio.run(run())
    assert first == b"v1"
    assert second in (b"v1", b"v2"), (
        "LAZY allowed to serve cached bytes; this test just confirms no crash")


def test_s3_always_warm_read_serves_cache_for_non_md5_fingerprint():
    """Multipart-style ETags are not the MD5 of the content. The cold
    read must stamp the cache entry with the backend ETag so a warm read
    under ALWAYS passes the freshness check and serves from cache
    instead of evicting and refetching on every read."""
    store = {"data.txt": b"name,age\nalice,30\n"}
    session = MultiBucketSession({"test-bucket": store}, etag_suffix="-2")
    client = session._client
    with patch_s3_session(session):
        config = S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
        ws = Workspace(
            {"/s3": (S3VFS(config), MountMode.WRITE)},
            mode=MountMode.WRITE,
            consistency=ConsistencyPolicy.ALWAYS,
        )

        async def run() -> tuple[bytes, bytes]:
            io1 = await ws.shell("cat /s3/data.txt | wc -c")
            first = await io1.materialize_stdout()
            io2 = await ws.shell("cat /s3/data.txt | wc -c")
            second = await io2.materialize_stdout()
            return first, second

        first, second = asyncio.run(run())
    assert first == second == b"18\n"
    assert client.calls["head_object"] >= 1, (
        "ALWAYS must consult the remote fingerprint on the warm read")
    assert client.calls["get_object"] == 1, (
        "warm read with an unchanged remote fingerprint must serve from "
        "cache; a second get_object means the entry was evicted")


def _always_mount(objects):
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    session = MultiBucketSession({"test-bucket": objects})
    return session, Workspace(
        {"/s3": (S3VFS(config), MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )


def test_always_revalidates_a_walk_and_a_glob():
    """The second door, the one every shell read uses.

    A recursive walk and a glob never named their files as operands, so the
    registry's pre-command reconcile never saw them and the file cache
    served whatever it held. Warming has to go through ``cat``: ``grep -r``
    fills no file cache of its own, so warming with it would leave the
    cache empty and the assertion would hold before and after the gate.
    """
    objects = {"a.txt": b"v1\n", "b.txt": b"v1\n"}
    session, ws = _always_mount(objects)

    async def run() -> tuple[bytes, bytes, dict[str, int]]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            await ws.shell("cat /s3/b.txt")
            objects["b.txt"] = b"v2\n"
            session._client.calls.clear()
            walk = (await ws.shell("grep -r v /s3/")).stdout
            walk_calls = dict(session._client.calls)
            glob = (await ws.shell("cat /s3/*.txt")).stdout
            await ws.close()
            return walk, glob, walk_calls

    walk, glob, walk_calls = asyncio.run(run())
    assert walk == b"/s3/a.txt:v1\n/s3/b.txt:v2\n", (
        "a recursive walk must revalidate each file it reads from cache")
    assert glob == b"v1\nv2\n", (
        "a glob operand must revalidate the files it expanded to")
    assert walk_calls["head_object"] == 2, (
        "one backend stat per file walked; zero means the walk never "
        "revalidated, which is the bug this test exists for")


def test_always_warm_read_probes_once():
    """Cost is the contract: a warm read probes once, not twice.

    ``cat`` stats its own operand before reading it, so a warm read costs
    two head_objects: that stat and the gate's probe. A third means the
    registry reconciled an operand the gate was going to probe anyway, and
    every named warm read silently doubled its stats. Counting has to start
    after the warm-up, because a cold+warm total is the same number before
    and after this change.
    """
    objects = {"a.txt": b"name,age\n"}
    session, ws = _always_mount(objects)
    client = session._client

    async def run() -> None:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            client.calls.clear()
            assert (await ws.shell("cat /s3/a.txt")).stdout == b"name,age\n"
            await ws.close()

    asyncio.run(run())
    assert client.calls["head_object"] == 2, (
        "one warm read is cat's own stat plus one gate probe; three means "
        "the registry's pre-command reconcile stopped deduplicating")
    assert client.calls["get_object"] == 0, (
        "an unchanged object must still be served from cache")


def test_metadata_command_keeps_its_own_reconcile():
    """`ls` reads no bytes, so the gate never fires for it.

    The dedup skips the pre-command reconcile only for commands whose
    byte reads go through the gate. A metadata command is not one, so it
    must still pay its own probe -- cat's stat, ls's stat, and the
    reconcile that would otherwise be dropped.
    """
    objects = {"a.txt": b"v1\n"}
    session, ws = _always_mount(objects)
    client = session._client

    async def run() -> None:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            client.calls.clear()
            assert (await ws.shell("ls -l /s3/a.txt")).exit_code == 0
            await ws.close()

    asyncio.run(run())
    assert client.calls["head_object"] == 3, (
        "ls must still reconcile its operand; 2 means the skip leaked to "
        "a command the gate does not cover")


def test_fanout_revalidates_a_descendant_mount():
    """A cross-mount walk reaches each leg through that leg's own manager.

    The fan-out calls `mount.execute_cmd` directly, bypassing the
    registry's pre-command reconcile entirely, so before the gate a
    descendant mount's cached bytes were never revalidated at all.
    """
    parent = {"p.txt": b"v1\n"}
    child = {"c.txt": b"v1\n"}
    session = MultiBucketSession({"bucket-a": parent, "bucket-b": child})

    def mount(bucket: str) -> S3VFS:
        return S3VFS(
            S3Config(bucket=bucket,
                     region="us-east-1",
                     aws_access_key_id="fake",
                     aws_secret_access_key="fake"))

    ws = Workspace(
        {
            "/x": (mount("bucket-a"), MountMode.WRITE),
            "/x/y": (mount("bucket-b"), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )

    async def run() -> bytes:
        with patch_s3_session(session):
            await ws.shell("cat /x/p.txt")
            await ws.shell("cat /x/y/c.txt")
            parent["p.txt"] = b"v2\n"
            child["c.txt"] = b"v2\n"
            out = (await ws.shell("grep -r v /x/")).stdout
            await ws.close()
            return out

    out = asyncio.run(run())
    assert b"/x/p.txt:v2" in out, "the primary leg must revalidate"
    assert b"/x/y/c.txt:v2" in out, (
        "the descendant leg must revalidate too; the fan-out never reaches "
        "the registry's reconcile, so only the cache gate covers it")


def test_a_flaky_probe_costs_a_refetch_not_the_walk():
    """One transient stat must not take down a recursive walk.

    The gate probes every file a walk reads, so a probe that raises had
    to be a verdict rather than an exception: a generic backend error is
    not in grep's per-file catch, so propagating it aborted the whole
    traversal and printed nothing at all.
    """
    objects = {"a.txt": b"v1\n", "b.txt": b"v1\n"}
    session, ws = _always_mount(objects)

    async def run() -> tuple[int, bytes]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            await ws.shell("cat /s3/b.txt")
            mount = ws.namespace.mount_for("/s3/a.txt")
            real = mount.execute_op

            async def flaky(op, path, **kwargs):
                if op == "stat" and path.endswith(
                        "a.txt") and "index" in kwargs:
                    raise OSError(errno.EIO, "backend stat unavailable")
                return await real(op, path, **kwargs)

            mount.execute_op = flaky
            result = await ws.shell("grep -r v /s3/")
            await ws.close()
            return result.exit_code, result.stdout

    code, out = asyncio.run(run())
    assert code == 0, "a flaky probe must not fail the walk"
    assert out == b"/s3/a.txt:v1\n/s3/b.txt:v1\n", (
        "the unverifiable file is re-read from the backend, not dropped")


def test_ram_falls_back_to_lazy_when_fingerprint_absent():
    vfs = RAMVFS()
    vfs._store.files["/file.txt"] = b"v1"
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )

    async def run() -> bytes:
        io1 = await ws.shell("cat /data/file.txt")
        return await io1.materialize_stdout()

    data = asyncio.run(run())
    assert data == b"v1", (
        "RAM read under ALWAYS must succeed (no fingerprint → LAZY fallback)")
