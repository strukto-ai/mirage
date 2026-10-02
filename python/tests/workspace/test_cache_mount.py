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

from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.core.disk.constants import SCOPE_ERROR
from mirage.core.disk.read import read_bytes
from mirage.core.disk.readdir import readdir
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)


@command("stat", vfs="disk", spec=SPECS["stat"], filetype=".zzz")
async def stat_zzz_disk(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin=None,
    index=None,
    **_extra: object,
) -> tuple[bytes | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    raw = await read_bytes(accessor, paths[0])
    return b"CUSTOM DISK STAT %d\n" % len(raw), IOResult(
        reads={paths[0].mount_path: raw}, cache=[paths[0].mount_path]
    )


@pytest.mark.asyncio
async def test_cache_decoupled_from_root_mount():
    """The file cache is a hidden store reached via ``registry.file_cache``,
    not the virtual root mount's VFS. When no ``/`` is mounted the root
    is an ordinary empty RAM mount at ``/`` (a normal entry in ``_mounts``)
    and never holds the cache."""
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    assert ws._registry.file_cache is ws.cache
    assert ws._registry.root_mount.vfs is not ws.cache
    assert ws._registry.root_mount.vfs.caches_reads is False
    assert ws._registry.root_mount.prefix == "/"
    assert ws._registry.root_mount in ws._registry.mounts()


@pytest.mark.asyncio
async def test_warm_read_stays_on_real_mount(tmp_path):
    """Read-through: the second (cached) read still runs the REAL mount's
    command. The cache is a hidden store, not a mount, so a warm read serves
    the cached bytes while the command stays on its real mount and keeps its
    custom handler."""
    (tmp_path / "example.zzz").write_bytes(b"payload")
    disk = DiskVFS(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/": disk}, mode=MountMode.READ)
    ws.mount("/").register_fns([stat_zzz_disk])

    first = await ws.shell("stat /example.zzz")
    second = await ws.shell("stat /example.zzz")
    assert "CUSTOM DISK STAT" in (await first.stdout_str())
    assert "CUSTOM DISK STAT" in (await second.stdout_str()), (
        "warm read lost the real mount's custom handler; read-through should "
        "keep the command on the real mount"
    )


@pytest.mark.asyncio
async def test_cross_mount_read_serves_cache(tmp_path):
    """A cross-mount read relays each operand through ``execute_op``, and the
    op-layer read-through serves a warm operand from cache. Proven under
    `bounded`
    by mutating the file out-of-band: the cross-mount read still returns the
    cached v1."""
    (tmp_path / "a.txt").write_bytes(b"v1\n")
    disk = DiskVFS(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace(
        {"/d/": disk, "/r/": RAMVFS()},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
    )
    await ws.shell("echo hi > /r/b.txt")
    await (await ws.shell("cat /d/a.txt")).stdout_str()
    (tmp_path / "a.txt").write_bytes(b"v2\n")
    out = await (await ws.shell("cat /d/a.txt /r/b.txt")).stdout_str()
    assert "v1" in out and "v2" not in out, (
        f"cross-mount read did not serve the warm operand from cache: {out!r}"
    )


def _stat_scope(path):
    return PathSpec(virtual=path, directory=path, vfs_path="", resolved=True)


@pytest.mark.asyncio
async def test_stat_gcs_orphaned_overlay_under_fresh():
    """A remotely-deleted path leaves an orphaned attribute overlay. Under
    ``read: fresh``, a stat the backend reports gone GCs the overlay node.

    The subject is the reaction, not RAM: the instance declares the two
    capabilities the verdict asks for so a RAM mount can legally carry
    the policy.
    """
    ram = RAMVFS()
    ram.caches_reads = True
    ram.read_revalidatable = True
    ws = Workspace(
        {"/data/": ram},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    assert ws.namespace.meta_for("/data/gone.txt") is not None

    with pytest.raises(FileNotFoundError):
        await ws.dispatch("stat", _stat_scope("/data/gone.txt"))

    assert ws.namespace.meta_for("/data/gone.txt") is None


@pytest.mark.asyncio
async def test_shell_stat_gcs_orphan_under_fresh():
    """A single-mount shell read (not the dispatcher) reconciles via the
    registry: under ``read: fresh``, a stat the backend reports gone GCs
    the overlay."""
    ram = RAMVFS()
    ram.caches_reads = True
    ram.read_revalidatable = True
    ws = Workspace(
        {"/r/": ram},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/r/gone.txt", mode=0o600)
    assert ws.namespace.meta_for("/r/gone.txt") is not None

    await ws.shell("stat /r/gone.txt")

    assert ws.namespace.meta_for("/r/gone.txt") is None


@pytest.mark.asyncio
async def test_stat_keeps_overlay_under_bounded():
    """Under ``read: bounded`` the overlay is left in place."""
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
    )
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)

    with pytest.raises(FileNotFoundError):
        await ws.dispatch("stat", _stat_scope("/data/gone.txt"))

    assert ws.namespace.meta_for("/data/gone.txt") is not None


@pytest.mark.asyncio
async def test_a_guarded_cp_leaves_the_entry_it_read_past(tmp_path):
    """Under ``bounded`` the guarded walk leaves the entry it read past.

    Every condition here is load-bearing and fails silently if changed.
    The hide forces `cp` onto the primitive walk, whose per-file read
    carries no backend token; the native strategy fills no cache at all.
    The mount is the root because `cp` keys its reads on ``src.virtual``
    while the runner re-prefixes, so on ``/r`` the fill lands at
    ``/r/r/dir/a.txt`` and this asserts nothing (#441, #629).
    """
    (tmp_path / "dir").mkdir()
    (tmp_path / "dir" / "a.txt").write_bytes(b"v1\n")
    disk = DiskVFS(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace(
        {"/": disk},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
    )
    ws.create_session("agent", profile={"paths": {"hide": ["/dir/.secret"]}})

    cold = await (
        await ws.shell("cat /dir/a.txt", session_id="agent")
    ).stdout_str()
    assert cold == "v1\n"

    (tmp_path / "dir" / "a.txt").write_bytes(b"v2\n")
    copied = await ws.shell("cp -r /dir /copy", session_id="agent")
    assert copied.exit_code == 0

    made = await (
        await ws.shell("cat /copy/a.txt", session_id="agent")
    ).stdout_str()
    assert made == "v2\n", "the copy has to hold the bytes the walk read"
    served = await (
        await ws.shell("cat /dir/a.txt", session_id="agent")
    ).stdout_str()
    assert served == "v1\n", (
        "the guarded walk overwrote the entry it read past"
    )


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    assert result.exit_code == 0, (line, await result.stderr_str())
    return out


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /r/a; echo new | tee /r/a",
        "cat /r/a; echo new > /r/a",
        "cat /r/a; cat /r/b > /r/a",
    ],
)
async def test_a_read_earlier_on_the_line_does_not_outlive_the_write(line):
    # MIRAGE-14: the read's bytes used to be cached over the write's, so
    # the next cat served the pre-write content until the ttl ran out.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'old\\n' > /r/a; printf 'new\\n' > /r/b")
    await _out(ws, line)
    assert await _out(ws, "cat /r/a") == b"new\n"


@pytest.mark.asyncio
async def test_a_same_mount_cp_over_a_path_read_on_the_line_is_never_empty():
    # cp lists its target in writes as an empty eviction marker; taking
    # the write side for a path also read would cache an empty file.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'old\\n' > /r/a; printf 'bee\\n' > /r/b")
    await _out(ws, "cat /r/a; cp /r/b /r/a")
    assert await _out(ws, "cat /r/a") == b"bee\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["echo new | tee /r/a; cat /r/a", "echo new | tee /r/a"]
)
async def test_a_write_then_a_read_on_one_line_serves_the_write(line):
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'old\\n' > /r/a; cat /r/a")
    await _out(ws, line)
    assert await _out(ws, "cat /r/a") == b"new\n"


def _caching_ram_under(policy: ReadPolicy) -> Workspace:
    ram = RAMVFS()
    ram.caches_reads = True
    # Only fresh needs it; bounded runs on a plain caching mount.
    ram.read_revalidatable = policy == ReadPolicy.FRESH
    return Workspace(
        {"/r/": ram},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=policy),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,path",
    [
        ("echo new | tee /r/a", "/r/a"),
        ("sed -i s/one/uno/ /r/b", "/r/b"),
        ("sort -o /r/so /r/b", "/r/so"),
        ("uniq /r/b /r/u", "/r/u"),
        ("shuf -o /r/s /r/b", "/r/s"),
        ("iconv -f utf-8 -t utf-8 -o /r/i /r/b", "/r/i"),
        ("zip -q /r/z.zip /r/b", "/r/z.zip"),
    ],
)
async def test_a_same_mount_write_keeps_its_output_under_bounded(line, path):
    # A command whose output goes through the backend's whole-file write
    # inside the command settles it: on a bounded mount the cache holds
    # exactly the bytes the backend stored.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'one\\ntwo\\nthree\\n' > /r/b")
    await _out(ws, line)
    held = await ws._cache.get(path)
    store = ws.mount("/r/").vfs.accessor.store
    assert held is not None
    assert held == store.files[path.removeprefix("/r")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,path",
    [
        ("cp /r/b /r/c", "/r/c"),
        ("split -l 1 /r/b /r/x", "/r/xaa"),
        ("csplit -f /r/cs /r/b 2", "/r/cs00"),
        (
            "mkdir /r/out; tar -cf /r/t.tar -C /r b; tar -xf /r/t.tar -C /r/out",
            "/r/out/b",
        ),
    ],
)
async def test_a_write_outside_the_settle_path_stays_evicted(line, path):
    # A native copy only invalidates, and split, csplit and tar write
    # through the dispatcher, which evicts after the op: these keep
    # nothing until that path settles too.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'one\\ntwo\\nthree\\n' > /r/b")
    await _out(ws, line)
    assert await ws._cache.exists(path) is False


@pytest.mark.asyncio
async def test_a_silent_write_is_not_kept_under_fresh():
    # RAM's write answers no token, so nothing could verify the bytes on a
    # fresh mount: the entry is dropped rather than kept unverifiable.
    ws = _caching_ram_under(ReadPolicy.FRESH)
    await _out(ws, "echo new | tee /r/a")
    assert await ws._cache.exists("/r/a") is False


@pytest.mark.asyncio
async def test_a_redirect_is_still_evicted():
    # A redirect writes through the dispatcher, which runs no cache manager
    # and evicts after the op; it keeps nothing until that path settles.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "echo old > /r/a")
    await _out(ws, "cat /r/a")
    assert await ws._cache.exists("/r/a") is True
    await _out(ws, "echo new > /r/a")
    assert await ws._cache.exists("/r/a") is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,paths",
    [
        ("split -l 1 /r/b /r/x", ["/r/xaa", "/r/xab", "/r/xac"]),
        ("tar -cf /r/t.tar -C /r b", ["/r/t.tar"]),
        (
            "mkdir /r/out; tar -cf /r/t.tar -C /r b; tar -xf /r/t.tar -C /r/out",
            ["/r/out/b"],
        ),
    ],
)
async def test_a_dispatched_write_inside_a_command_fills_nothing(
    monkeypatch, line, paths
):
    # The dispatcher evicts what its write op wrote, so a manager inherited
    # from the enclosing command must not settle the bytes first: a fill the
    # eviction then drops still costs a set, and can push warm entries out.
    ws = _caching_ram_under(ReadPolicy.BOUNDED)
    await _out(ws, "printf 'one\\ntwo\\nthree\\n' > /r/b")
    filled: list[str] = []
    real_set = ws._cache.set

    async def counting_set(
        key: str, data: bytes, **kwargs: str | int | None
    ) -> None:
        filled.append(key)
        await real_set(key, data, **kwargs)

    monkeypatch.setattr(ws._cache, "set", counting_set)
    await _out(ws, line)
    assert [key for key in filled if key in paths] == []
