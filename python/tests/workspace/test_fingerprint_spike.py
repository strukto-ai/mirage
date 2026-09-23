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

import pytest

from mirage.io import IOResult
from mirage.types import (DEFAULT_READ_TTL, CacheFacts, MountMode, ReadPolicy,
                          ReadSpec)
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from mirage.workspace.mount.spec import Mount
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session


def test_disk_cannot_declare_fresh(tmp_path):
    """Disk is answered by the first rule, not the token-quality one.

    #1101 Q8 worried that refusing would leave the two commonest local
    mounts with no read policy. Disk never reaches that question: it
    does not cache reads, so there is no gate to revalidate at.
    """
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")
    with pytest.raises(ValueError) as exc:
        Workspace(
            {"/data": (DiskVFS(root=str(root)), MountMode.WRITE)},
            mode=MountMode.WRITE,
            read=ReadSpec(policy=ReadPolicy.FRESH),
        )
    assert "needs a resource that caches reads" in str(exc.value)


def test_disk_under_bounded_reads_current_bytes(tmp_path):
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")

    vfs = DiskVFS(root=str(root))
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
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
    # Disk does not cache reads at all, so `bounded` has nothing to
    # serve stale and the second read is always current. The old
    # assertion allowed either byte string, which no implementation
    # could fail.
    assert second == b"v2"


def test_s3_always_warm_read_serves_cache_for_non_md5_fingerprint():
    """Multipart-style ETags are not the MD5 of the content. The cold
    read must stamp the cache entry with the backend ETag so a warm read
    under `fresh` passes the freshness check and serves from cache
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
            read=ReadSpec(policy=ReadPolicy.FRESH),
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


def test_a_tokenless_entry_costs_one_extra_get_then_carries_the_etag():
    """The measured price of storing no token instead of a fabricated md5.

    On s3 the ETag of a simple unencrypted PUT *is* md5(content), so the
    old fallback was a valid validator there -- the one backend where it
    was. An entry that reaches the cache with no token (here through the
    programmatic ``apply_io`` door, which defaults ``records=None``) can
    no longer claim freshness, so the next read under ``fresh`` refetches
    once. After that the entry carries the backend's own ETag and the
    read after it is served from cache: the cost is one GET, once, not a
    refetch per read.

    The TypeScript twin lives in
    ``packages/node/src/vfs/s3/s3_consistency.test.ts`` rather than beside
    this file's port, because that is where the s3 mock harness and the
    other GET-count pins are.
    """
    store = {"data.txt": b"payload\n"}
    session = MultiBucketSession({"test-bucket": store})
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
            read=ReadSpec(policy=ReadPolicy.FRESH),
        )

        async def run() -> tuple[int, int]:
            # No `records`: the bytes land in the cache carrying no token,
            # which is exactly what the md5 default used to paper over.
            await ws.apply_io(
                IOResult(reads={"/s3/data.txt": b"payload\n"},
                         cache=["/s3/data.txt"]))
            assert not await ws.cache.is_fresh("/s3/data.txt", "anything")
            before = client.calls["get_object"]
            io1 = await ws.shell("cat /s3/data.txt")
            await io1.materialize_stdout()
            after_first = client.calls["get_object"]
            io2 = await ws.shell("cat /s3/data.txt")
            await io2.materialize_stdout()
            after_second = client.calls["get_object"]
            return after_first - before, after_second - after_first

        first, second = asyncio.run(run())

    assert first == 1, "the unverifiable entry is dropped and re-read once"
    assert second == 0, (
        "and the refetched entry carries a token that matches, so the read "
        "after it is served from cache")
    # Deliberately not asserting *which* token the refetch stamped: this
    # mock builds its ETag as md5(content) with an empty suffix, so the
    # backend's token and a fabricated md5 are the same string and the
    # claim cannot be tested on this fixture. It is pinned where the suffix
    # makes the two distinguishable -- test_write_fingerprint.py.


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
        read=ReadSpec(policy=ReadPolicy.FRESH),
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


def test_always_warm_read_costs_a_gate_probe():
    """Cost is the contract, and the gate's probe is the cost.

    A warm ``cat`` is three backend stats: the routing reconcile, ``cat``'s
    own operand stat, and the gate's probe. Two means the gate stopped
    probing a named warm operand -- which is what ``main`` does, so this
    number is what separates the two. Counting starts after the warm-up,
    because a cold+warm total is the same either way.
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
    assert client.calls["head_object"] == 3, (
        "routing reconcile + cat's own stat + the gate's probe; two means "
        "the gate no longer revalidates a named warm operand")
    assert client.calls["get_object"] == 0, (
        "an unchanged object must still be served from cache")


class _SnapshotFalseS3(S3VFS):
    """A caching, fingerprint-bearing mount that cannot be snapshotted.

    Subclassed rather than patching ``S3VFS.SUPPORTS_SNAPSHOT``: that is a
    class attribute, and mutating it leaks into every other test in the
    session.
    """

    SUPPORTS_SNAPSHOT: bool = False


def test_snapshot_false_mount_still_serves_a_verified_cache():
    """The ``SUPPORTS_SNAPSHOT`` short-circuit is gone, and must stay gone.

    It dropped every cached copy on a mount declaring the flag False,
    without probing -- a proxy for "the stat carries no content token" and
    the wrong one, since this mount's stat and read tokens are both the
    ETag. Restoring it turns ``get_object`` from 0 to 1 and wipes the
    mount's whole index, so the GET is the assertion that matters; the
    stat count moves for unrelated reasons.
    """
    objects = {"a.txt": b"v1\n"}
    session = MultiBucketSession({"test-bucket": objects})
    client = session._client
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    ws = Workspace(
        {"/s3": (_SnapshotFalseS3(config), MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )

    async def run() -> bytes:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            client.calls.clear()
            out = (await ws.shell("cat /s3/a.txt")).stdout
            await ws.close()
            return out

    out = asyncio.run(run())
    assert out == b"v1\n"
    assert client.calls["get_object"] == 0, (
        "a verified cache entry must be served, not refetched, however the "
        "mount answers SUPPORTS_SNAPSHOT")


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
        read=ReadSpec(policy=ReadPolicy.FRESH),
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


def test_ram_cannot_declare_fresh():
    """The silent downgrade is refused, not accepted.

    This test used to assert the opposite: that a RAM mount under `fresh`
    "must succeed (no fingerprint -> LAZY fallback)". That fallback is
    the bug the read policy exists to remove -- a mount that asked to
    revalidate and quietly did not. RAM does not cache reads, so the
    gate could never fire, and the mount is refused at construction
    rather than downgraded behind the operator's back.
    """
    vfs = RAMVFS()
    vfs._store.files["/file.txt"] = b"v1"
    with pytest.raises(ValueError) as exc:
        Workspace(
            {"/data": (vfs, MountMode.WRITE)},
            mode=MountMode.WRITE,
            read=ReadSpec(policy=ReadPolicy.FRESH),
        )
    assert "needs a resource that caches reads" in str(exc.value)


def test_a_routing_probe_failure_never_takes_the_line():
    """Routing runs before any handler, so a raise there loses the line.

    ``reconcile_read`` probes a warm named operand at routing. If that
    probe raised, there would be no command yet to report it: the whole
    line fails, later ``;`` stages included, with no operand named. The
    probe is best-effort instead. The entry is dropped and the command
    reads the backend itself, so ``ls`` lists and ``cat`` prints current
    bytes, and the stage after the ``;`` still runs.
    """
    objects = {"a.txt": b"v1\n"}
    session, ws = _always_mount(objects)

    async def run() -> list[tuple[int, bytes]]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            mount = ws.namespace.mount_for("/s3/a.txt")
            real = mount.execute_op

            async def broken(op, path, **kwargs):
                if op == "stat":
                    raise TypeError("probe bug")
                return await real(op, path, **kwargs)

            mount.execute_op = broken
            results = []
            for line in ("ls -l /s3/a.txt; echo survived",
                         "cat /s3/a.txt; echo survived"):
                io = await ws.shell(line)
                results.append((io.exit_code, await io.materialize_stdout()))
            await ws.close()
            return results

    (ls_exit, ls_out), (cat_exit, cat_out) = asyncio.run(run())
    assert ls_exit == 0 and ls_out.endswith(b"/s3/a.txt\nsurvived\n"), (
        "a routing probe failure must not take a metadata command's line")
    assert cat_exit == 0 and cat_out == b"v1\nsurvived\n", (
        "a routing probe failure drops the entry and the read goes cold")


def test_metadata_command_reconciles_its_operand():
    """``ls`` reads no bytes, so the cache gate never fires for it.

    Routing is the one door a metadata command has to backend truth, and
    it must keep probing there: a warm ``ls -l`` costs three backend
    stats, and two means the routing reconcile stopped firing for a
    command the gate does not cover.
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
        "ls must still reconcile its operand at routing; 2 means the one "
        "door a metadata command has to backend truth went dark")


def _bounded_mount(objects, ttl=600):
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
        read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=ttl),
    )


def test_bounded_stamps_the_mounts_bound_on_the_cache_entry():
    objects = {"a.txt": b"v1\n"}
    session, ws = _bounded_mount(objects, ttl=30)

    async def run() -> int | None:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            entry = ws.cache._entries["/s3/a.txt"]
            await ws.close()
            return entry.ttl

    assert asyncio.run(run()) == 30, (
        "the mount's bound must reach the cache entry, or `bounded` is "
        "`lazy` renamed")


def test_bounded_serves_within_the_bound_then_goes_cold():
    """Cost is the contract: `bounded` costs no probe, and does expire.

    `fresh` and `bounded` differ only in call count, so a functional
    assertion alone cannot tell one from the other. The clock is advanced
    by ageing the entry rather than sleeping: CacheEntry.expired reads
    time.time() at property-read time and there is no clock seam.
    """
    objects = {"a.txt": b"v1\n"}
    session, ws = _bounded_mount(objects, ttl=30)
    client = session._client

    async def run() -> tuple[bytes, dict[str, int], bytes]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            client.calls.clear()
            warm = (await ws.shell("cat /s3/a.txt")).stdout
            warm_calls = dict(client.calls)
            objects["a.txt"] = b"v2\n"
            entry = ws.cache._entries["/s3/a.txt"]
            entry.cached_at -= 31
            cold = (await ws.shell("cat /s3/a.txt")).stdout
            await ws.close()
            return warm, warm_calls, cold

    warm, warm_calls, cold = asyncio.run(run())
    assert warm == b"v1\n"
    assert warm_calls["head_object"] == 1, (
        "a warm bounded read is cat's own stat and nothing else; the same "
        "read under fresh costs three (the routing reconcile, cat's stat "
        "and the gate's probe), so anything above one means a door that "
        "should have skipped did not")
    assert warm_calls.get("get_object", 0) == 0
    assert cold == b"v2\n", "past its bound, the entry must not be served"


def test_bounded_walk_costs_no_per_file_stat():
    """The other side of ``test_always_revalidates_a_walk_and_a_glob``.

    The same two files under ``fresh`` cost two head_objects, one per
    file walked. Under ``bounded`` they cost none, so those two probes
    are exactly what the policy buys -- a claim only a call count can
    make, since both policies print the same bytes here.
    """
    objects = {"a.txt": b"v1\n", "b.txt": b"v1\n"}
    session, ws = _bounded_mount(objects, ttl=30)
    client = session._client

    async def run() -> tuple[bytes, dict[str, int]]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            await ws.shell("cat /s3/b.txt")
            client.calls.clear()
            walk = (await ws.shell("grep -r v /s3/")).stdout
            calls = dict(client.calls)
            await ws.close()
            return walk, calls

    walk, calls = asyncio.run(run())
    assert walk == b"/s3/a.txt:v1\n/s3/b.txt:v1\n"
    assert calls.get(
        "head_object",
        0) == 0, ("a bounded walk must not revalidate; two means bounded is "
                  "probing like fresh")
    assert calls.get("get_object", 0) == 0


def test_bounded_drops_an_entry_that_carries_no_bound():
    """The self-heal: entries written before the policy existed.

    Nothing stamped a ttl before this, and a warm read short-circuits
    rather than re-setting, so such an entry would never acquire a bound
    and never expire. It has to be removed, not merely refused: refusing
    alone leaves it in place and refetches on every read forever.
    """
    objects = {"a.txt": b"v1\n"}
    session, ws = _bounded_mount(objects, ttl=30)
    client = session._client

    async def run() -> tuple[dict[str, int], int | None]:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            # An entry as a pre-D1 deployment left it: no bound.
            ws.cache._entries["/s3/a.txt"].ttl = None
            client.calls.clear()
            assert (await ws.shell("cat /s3/a.txt")).stdout == b"v1\n"
            replacement = ws.cache._entries["/s3/a.txt"].ttl
            await ws.close()
            return dict(client.calls), replacement

    calls, replacement = asyncio.run(run())
    assert calls["get_object"] == 1, (
        "the bound-less entry is dropped and read cold, once")
    assert replacement == 30, (
        "the cold read must re-stamp the bound, or the drop repeats on "
        "every read forever")


def test_two_mounts_carry_two_different_bounds():
    """The headline claim: the bound is per mount, not per workspace.

    Every other bounded test declares one workspace-level bound, so the
    per-mount value and the default are the same number and a stamp that
    read the workspace default would pass them all. Two mounts with two
    bounds is the only shape that tells them apart.
    """
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    objects = {"a.txt": b"v1\n"}
    session = MultiBucketSession({"test-bucket": objects})
    ws = Workspace(
        {
            "/fast":
            Mount(vfs=S3VFS(config),
                  mode=MountMode.WRITE,
                  read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=30)),
            "/slow":
            Mount(vfs=S3VFS(config),
                  mode=MountMode.WRITE,
                  read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=90)),
        },
        mode=MountMode.WRITE,
    )

    async def run() -> tuple[int | None, int | None]:
        with patch_s3_session(session):
            await ws.shell("cat /fast/a.txt")
            await ws.shell("cat /slow/a.txt")
            fast = ws.cache._entries["/fast/a.txt"].ttl
            slow = ws.cache._entries["/slow/a.txt"].ttl
            await ws.close()
            return fast, slow

    assert asyncio.run(run()) == (30, 90)


def test_the_live_cache_facts_door_reads_the_mounts_bound():
    """``apply_io`` with no captured function is the embedder's door.

    ``cache_facts_for`` resolves the mount live and is what the public
    ``Workspace.apply_io`` (FUSE and facade fills) uses. Only
    ``capture_cache_facts``, reached through a shell line, is covered by
    the tests above, so a door returning ``DEFAULT_READ_TTL`` here would
    go unnoticed.
    """
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    ws = Workspace(
        {
            "/s3":
            Mount(vfs=S3VFS(config),
                  mode=MountMode.WRITE,
                  read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=45))
        },
        mode=MountMode.WRITE,
    )

    async def run() -> tuple[int | None, CacheFacts]:
        await ws.apply_io(
            IOResult(reads={"/s3/f.txt": b"x"}, cache=["/s3/f.txt"]))
        entry = ws.cache._entries["/s3/f.txt"].ttl
        unmounted = ws._dispatcher.cache_facts_for("/nowhere/f.txt")
        await ws.close()
        return entry, unmounted

    ttl, unmounted = asyncio.run(run())
    assert ttl == 45, ("the live door must read the mount's bound, not the "
                       "package default")
    assert unmounted.cacheable is False


def test_a_fresh_mount_still_stamps_a_bound():
    """`fresh` entries carry a bound too.

    Two workspaces can share one Redis cache under different policies,
    so an entry written by a `fresh` mount must still expire for the
    `bounded` one reading it. Keying the stamp on the policy would leave
    only the dataclass test standing.
    """
    objects = {"a.txt": b"v1\n"}
    session, ws = _always_mount(objects)

    async def run() -> int | None:
        with patch_s3_session(session):
            await ws.shell("cat /s3/a.txt")
            ttl = ws.cache._entries["/s3/a.txt"].ttl
            await ws.close()
            return ttl

    assert asyncio.run(run()) == DEFAULT_READ_TTL
