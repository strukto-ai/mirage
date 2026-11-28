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

from mirage.cache.file.config import CacheConfig
from mirage.core.hf_hub.read import read
from mirage.core.hf_hub.readdir import readdir
from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.state import to_state_dict
from tests.fixtures.handed import call
from tests.fixtures.hub_repo import BRIDGE, RESOLVE, HubRepo, blob_oid

OLD = b"version one\n"
NEW = b"version two, longer\n"


def _vfs(hub: HubRepo):
    return build_vfs("hf_models", hub.config())


def _ws(vfs, policy: ReadPolicy = ReadPolicy.FRESH) -> Workspace:
    return Workspace(
        {
            "/m": Mount(
                vfs=vfs, mode=MountMode.READ, read=ReadSpec(policy=policy)
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        cache=CacheConfig(),
    )


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _seeded(hub: HubRepo, **files: bytes) -> None:
    await hub.commit(files)
    await hub.run.record_requests()


async def _listed_before_the_bytes(hub: HubRepo, path: str, new: bytes):
    """Land a commit of ``new`` while the next download waits, after the
    mount listed the file: the listing describes what it held before, and
    the download serves ``new``.

    Args:
        hub (HubRepo): the repository.
        path (str): the file.
        new (bytes): what the commit writes.
    """

    async def change() -> None:
        # Plain, not Xet: storing one on Xet reloads the run, which would
        # drop the download it holds.
        await hub.commit({path: new}, xet=False)

    await hub.run.before_next([("GET", RESOLVE)], change)


@pytest.mark.asyncio
async def test_a_revert_never_serves_other_bytes_as_fresh(hub):
    # The listing still describes OLD while the download already serves
    # NEW: the read must not label NEW with OLD's oid, or a revert back to
    # OLD makes the probe agree and NEW is served as if it were OLD.
    await _seeded(hub, **{"a.txt": OLD})
    await _listed_before_the_bytes(hub, "a.txt", NEW)
    ws = _ws(_vfs(hub))
    try:
        assert await _out(ws, "cat /m/a.txt") == NEW
        # The fixture held: the listing was OLD's, and the cached copy
        # carries no token rather than OLD's oid.
        assert not await ws.cache.is_fresh("/m/a.txt", blob_oid(OLD))
        await hub.commit({"a.txt": OLD})
        assert await _out(ws, "cat /m/a.txt") == OLD
        assert await hub.count("resolve") == 1
        # The refetch was verified, so it restamped and now serves warm.
        await hub.run.record_requests()
        assert await _out(ws, "cat /m/a.txt") == OLD
        assert await hub.count("resolve") == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_revert_through_cp_never_serves_other_bytes_as_fresh(hub):
    # The same revert through the bytes read: a cross-mount cp reads
    # with read_bytes, where cat reads with the stream.
    await _seeded(hub, **{"a.txt": OLD})
    await _listed_before_the_bytes(hub, "a.txt", NEW)
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cp /m/a.txt /r/one")
        assert await _out(ws, "cat /r/one") == NEW
        await hub.commit({"a.txt": OLD})
        await _out(ws, "cp /m/a.txt /r/two")
        assert await _out(ws, "cat /r/two") == OLD
        assert await hub.count("resolve") == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_probe_leaves_find_its_whole_listing(hub):
    await _seeded(hub, **{"a.txt": OLD, "d/b.txt": NEW})
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        # The warm read's probes answer through paths-info; a probe that
        # seeded its one row as the mount's listing would leave find
        # seeing a single file, or walking again to recover.
        await _out(ws, "cat /m/a.txt")
        await hub.run.record_requests()
        listed = await _out(ws, "find /m -type f")
        assert listed.decode().split() == ["/m/a.txt", "/m/d/b.txt"]
        # find, a new command, re-checks the listing once under fresh:
        # one head check against its version, and no walk (Task 1.3).
        assert (await hub.count("revision"), await hub.count("tree")) == (1, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_that_cannot_see_its_repo_fails_loudly(hub):
    await _seeded(hub, **{"a.txt": OLD})
    await hub.refuse("tree", 401)
    ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
    try:
        # A refusal reads as a directory the caller may not open, the
        # error every file tool already knows how to report and skip.
        ls = await ws.shell("ls /m")
        assert ls.exit_code != 0
        assert "Permission denied" in await ls.stderr_str()
        cat = await ws.shell("cat /m/a.txt")
        assert cat.exit_code == 1
        assert await cat.stderr_str() == "cat: /m/a.txt: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refused_mount_does_not_hide_the_other_mounts(hub):
    # One hf mount the token cannot see must not blank out a search across
    # the workspace: the walk reports that mount and keeps going.
    await _seeded(hub, **{"a.txt": OLD})
    await hub.refuse("tree", 401)
    ws = Workspace(
        {
            "/h": (_vfs(hub), MountMode.READ),
            "/r": (RAMVFS(), MountMode.WRITE),
        }
    )
    try:
        await (
            await ws.shell("tee /r/n.txt", stdin=b"needle\n")
        ).materialize_stdout()
        grep = await ws.shell("grep -r needle /")
        assert await grep.materialize_stdout() == b"/r/n.txt:needle\n"
        assert "Permission denied" in await grep.stderr_str()
        find = await ws.shell("find / -type f")
        assert b"/r/n.txt" in await find.materialize_stdout()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_gated_download_does_not_hide_the_other_mounts(hub):
    # The tree lists but the file download is refused, as for a gated repo.
    await _seeded(hub, **{"a.txt": b"needle\n"})
    await hub.refuse("resolve", 403)
    ws = Workspace(
        {
            "/h": (_vfs(hub), MountMode.READ),
            "/r": (RAMVFS(), MountMode.WRITE),
        }
    )
    try:
        await (
            await ws.shell("tee /r/n.txt", stdin=b"needle\n")
        ).materialize_stdout()
        grep = await ws.shell("grep -r needle /")
        assert await grep.materialize_stdout() == b"/r/n.txt:needle\n"
        assert "Permission denied" in await grep.stderr_str()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_expired_token_keeps_the_overlay(hub):
    await _seeded(hub, **{"a.txt": OLD})
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
        await hub.refuse("tree", 401)
        await hub.refuse("paths_info", 401)
        # Cross-mount cp reads through the dispatcher, the dispatcher whose
        # "no such file" drops the overlay; a plain cat never reaches it.
        cp = await ws.shell("cp /m/a.txt /r/x")
        assert cp.exit_code == 1
        # The refusal, not "No such file": the tree the cold read rebuilt
        # was refused outright rather than read as empty.
        assert (await cp.stderr_str()).endswith("Permission denied\n")
        meta = ws.namespace.meta_for("/m/a.txt")
        assert meta is not None and meta.mode == 0o600
    finally:
        await ws.close()


async def _pinned_state(hub: HubRepo):
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        return await to_state_dict(ws)
    finally:
        await ws.close()


async def _load(state, vfs):
    loaded = await Workspace.from_state(state, mounts={"/m": vfs})
    try:
        await _out(loaded, "cat /m/a.txt")
    finally:
        await loaded.close()


@pytest.mark.asyncio
async def test_a_verified_read_pins_and_a_changed_file_drifts(hub):
    await _seeded(hub, **{"a.txt": OLD})
    state = await _pinned_state(hub)
    await hub.commit({"a.txt": NEW})
    with pytest.raises(ContentDriftError):
        await _load(state, _vfs(hub))
    # The check asks for the one path rather than walking the tree.
    assert (await hub.count("paths_info"), await hub.count("tree")) == (1, 0)


@pytest.mark.asyncio
async def test_an_unverified_read_pins_nothing(hub):
    await _seeded(hub, **{"a.txt": OLD})
    await _listed_before_the_bytes(hub, "a.txt", NEW)
    state = await _pinned_state(hub)
    # Upstream is at NEW, which is what the agent actually read; a pin
    # of the listing's OLD oid would raise a drift that never happened.
    await _load(state, _vfs(hub))


@pytest.mark.asyncio
async def test_a_drift_check_the_hub_refuses_is_not_drift(hub):
    await _seeded(hub, **{"a.txt": OLD})
    state = await _pinned_state(hub)
    await hub.refuse("paths_info", 401)
    with pytest.raises(PermissionError):
        await _load(state, _vfs(hub))


@pytest.mark.asyncio
async def test_a_drift_check_on_a_loaded_mount_asks_one_path(hub):
    await _seeded(hub, **{"a.txt": OLD})
    vfs = _vfs(hub)
    ws = _ws(vfs)
    try:
        await _out(ws, "cat /m/a.txt")
        state = await to_state_dict(ws)
        # The check asks for the one path rather than walking again.
        await hub.commit({"a.txt": NEW})
        with pytest.raises(ContentDriftError):
            await _load(state, vfs)
        assert (
            await hub.count("paths_info"),
            await hub.count("tree"),
        ) == (1, 0)
        await hub.refuse("paths_info", 401)
        with pytest.raises(PermissionError):
            await _load(state, vfs)
    finally:
        await ws.close()


# Measured on the first green run, then pinned (test plan T31): each path
# ask is one reconcile probe, and a warm read makes no download. The probe
# runs at the command's first lookup of the operand its line names, and the
# command's own stat and the cache stage reuse its answer, so a cross-mount
# cp re-checks no listing either (it was a head check, and before that a
# whole tree walk, Task 1.3).
WARM = [
    ("cat /m/a.txt", 1, 0, 0),
    ("cat /m/a.txt | head -c 1", 1, 0, 0),
    ("cp /m/a.txt /r/a.txt", 1, 0, 0),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,posts,walks,heads", WARM)
async def test_a_warm_fresh_read_costs_one_path_per_probe(
    hub, line, posts, walks, heads
):
    await _seeded(hub, **{"a.txt": OLD})
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        await hub.run.record_requests()
        await _out(ws, line)
        assert (
            await hub.count("paths_info"),
            await hub.count("tree"),
            await hub.count("resolve"),
            await hub.count("revision"),
        ) == (posts, walks, 0, heads)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_new_mount_loads_its_tree_once_and_never_asks_one_path(hub):
    await _seeded(hub, **{"a.txt": OLD})
    ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
    try:
        await _out(ws, "stat -c %s /m/a.txt")
        await _out(ws, "stat -c %s /m/a.txt")
        await _out(ws, "ls /m")
        # The fill resolves the head it walks the tree at (Task 1.3).
        assert (
            await hub.count("tree"),
            await hub.count("paths_info"),
            await hub.count("revision"),
        ) == (1, 0, 1)
    finally:
        await ws.close()


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual="/" + path, directory="/", vfs_path=path, raw_path="/" + path
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("override,expected", [(None, True), ("other", False)])
async def test_a_ranged_read_stamps_the_whole_files_oid(
    hub, override, expected
):
    await _seeded(hub, **{"a.txt": OLD})
    if override is not None:
        # The bytes' own answer with its ETag changed: one that names none
        # of the row's ids.
        await hub.run.answer_next(
            "GET",
            BRIDGE,
            206,
            OLD[2:5],
            headers={
                "ETag": f'"{override}"',
                "Content-Range": f"bytes 2-4/{len(OLD)}",
                "Content-Type": "application/octet-stream",
            },
        )
    vfs = _vfs(hub)
    scope = RecordingScope()
    try:
        data = await call(
            read, readdir, vfs.accessor, _spec("a.txt"), offset=2, size=3
        )
    finally:
        scope.close()
        await vfs.accessor.close()
    assert data == OLD[2:5]
    stamped = [r.fingerprint for r in scope.records]
    assert stamped == ([blob_oid(OLD)] if expected else [None])
