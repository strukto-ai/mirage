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

import hashlib

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.state import to_state_dict
from tests.fixtures.hf_buckets_opendal import FakeAsyncOperator
from tests.fixtures.hf_hub_api import FakeHub, serve, xet_hash

BUCKET = ("buckets", "acme/bkt")
OLD = b"version one\n"
NEW = b"version two, longer\n"


def _hub(files: dict[str, bytes]) -> FakeHub:
    return FakeHub(repos={BUCKET: dict(files)})


def _vfs(hub: FakeHub, **config: str):
    # The opendal fake lists and writes the very dict the Hub serves, so a
    # write through the mount is what the next HTTP read downloads.
    vfs = build_vfs("hf_buckets", {
        "bucket": "acme/bkt",
        "endpoint": hub.url,
        **config
    })
    # Its reads refuse into `reach`, so a stat or read that fell back to
    # opendal fails loudly rather than answering from the same dict.
    op = FakeAsyncOperator(files=hub.repos[BUCKET],
                           root=vfs.accessor._root() or "",
                           reach=[])
    vfs.accessor.operator = lambda: op
    return vfs


def _ws(vfs, policy: ReadPolicy = ReadPolicy.FRESH) -> Workspace:
    return Workspace({
        "/m":
        Mount(vfs=vfs, mode=MountMode.WRITE, read=ReadSpec(policy=policy)),
        "/r": (RAMVFS(), MountMode.WRITE),
    })


async def _out(ws: Workspace, line: str, stdin: bytes | None = None) -> bytes:
    result = await ws.shell(line, stdin=stdin)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


def _files(hub: FakeHub) -> dict[str, bytes]:
    return hub.repos[BUCKET]


@pytest.mark.asyncio
async def test_a_written_path_carries_no_token_then_heals_in_one_read():
    # #1138. A bucket write stamps no token (opendal reports none, and #1101
    # Phase 1 adds no stat after a write), so the written entry verifies
    # against nothing: the first fresh read refetches once, and that read's
    # stamp makes every read after it warm.
    with serve(_hub({})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "tee /m/w.txt", stdin=b"hi\n")
            writes = [
                r.fingerprint for r in ws.vfs.network_records
                if r.op == "write"
            ]
            assert writes == [None]
            # Absent, not merely different: an invented token would pass a
            # check that only compared it with the xet hash.
            assert ws.cache._entries["/m/w.txt"].fingerprint is None
            assert not await ws.cache.is_fresh(
                "/m/w.txt",
                hashlib.md5(b"hi\n").hexdigest())
            before = hub.count("bucket_resolve")
            assert await _out(ws, "cat /m/w.txt") == b"hi\n"
            assert hub.count("bucket_resolve") == before + 1
            assert await _out(ws, "cat /m/w.txt") == b"hi\n"
            assert hub.count("bucket_resolve") == before + 1
        finally:
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("route,status,code", [
    ("bucket_paths_info", 401, ""),
    ("bucket_paths_info", 404, "RepoNotFound"),
])
async def test_a_refused_probe_keeps_the_overlay(route, status, code):
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
            hub.fail[route] = (status, code)
            # Cross-mount cp reads through the dispatcher, the door whose
            # "no such file" drops the overlay; a plain cat never reaches it.
            cp = await ws.shell("cp /m/a.txt /r/x")
            assert cp.exit_code == 1
            assert await cp.stderr_str() == "cp: /m/a.txt: Permission denied\n"
            hub.fail.clear()
            meta = ws.namespace.meta_for("/m/a.txt")
            assert meta is not None and meta.mode == 0o600
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_download_404_that_is_not_entry_not_found_keeps_the_overlay():
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
            await ws.cache.remove("/m/a.txt")
            # A CDN-shaped 404 carries no error code: it is a failed
            # download, not a deleted file. Measured on the first green run:
            # the raw Hub error, not "No such file".
            hub.fail["bucket_resolve"] = (404, "")
            cp = await ws.shell("cp /m/a.txt /r/x")
            assert (cp.exit_code, await
                    cp.stderr_str()) == (1, "fake bucket_resolve refused\n")
            meta = ws.namespace.meta_for("/m/a.txt")
            assert meta is not None and meta.mode == 0o600
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_gated_bucket_does_not_hide_the_other_mounts():
    with serve(_hub({"a.txt": b"needle\n"})) as hub:
        hub.fail["bucket_resolve"] = (403, "")
        ws = Workspace({
            "/m": (_vfs(hub), MountMode.READ),
            "/r": (RAMVFS(), MountMode.WRITE),
        })
        try:
            await _out(ws, "tee /r/n.txt", stdin=b"needle\n")
            grep = await ws.shell("grep -r needle /")
            assert await grep.materialize_stdout() == b"/r/n.txt:needle\n"
            assert "Permission denied" in await grep.stderr_str()
            cat = await ws.shell("cat /m/a.txt")
            assert cat.exit_code == 1
            assert await cat.stderr_str(
            ) == "cat: /m/a.txt: Permission denied\n"
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_listing_a_refused_bucket_is_never_absent():
    # `ls` of a file reaches paths-info through the listing's file probe
    # (object_store readdir `_probe_file`); find and du answer from the
    # opendal listing alone, so only this door can mistake a refusal for
    # an absence.
    with serve(_hub({"a.txt": OLD})) as hub:
        hub.fail["bucket_paths_info"] = (401, "")
        vfs = _vfs(hub)
        ws = _ws(vfs, ReadPolicy.BOUNDED)
        try:
            result = await ws.shell("ls /m/a.txt")
            await result.materialize_stdout()
            # The raw refusal, never "No such file"; pinned on the first
            # green run.
            assert (result.exit_code, await result.stderr_str()) == (
                1, "ls: fake bucket_paths_info refused\n")
            assert (await vfs.index.get("/m/a.txt")).entry is None
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_probe_leaves_find_its_whole_prefixed_listing():
    # A fresh probe stats through a throwaway index and writes nothing back,
    # so a find after a warm read still lists the whole prefixed subtree.
    with serve(
            _hub({
                "pfx/a.txt": OLD,
                "pfx/sub/b.txt": NEW,
                "a.txt": b"decoy\n"
            })) as hub:
        ws = _ws(_vfs(hub, key_prefix="pfx/"))
        try:
            assert await _out(ws, "cat /m/a.txt") == OLD
            assert await _out(ws, "cat /m/a.txt") == OLD
            assert await _out(
                ws, "find /m") == (b"/m\n/m/a.txt\n/m/sub\n/m/sub/b.txt\n")
        finally:
            await ws.close()


# Measured on the first green run, then pinned (test plan T23): the
# routing probe, the handler's stat against a mount index nothing filled,
# and the cache door's probe; `ls` fills the index and saves the second.
# Cross-mount cp skips routing's probe and stats through its own door.
WARM = [
    ("", "cat /m/a.txt", 3),
    ("ls /m", "cat /m/a.txt", 2),
    ("", "cat /m/a.txt | head -c 1", 3),
    ("", "cp /m/a.txt /r/a.txt", 2),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("prep,line,posts", WARM)
async def test_a_warm_fresh_read_costs_paths_info_and_no_download(
        prep, line, posts):
    with serve(_hub({"a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "cat /m/a.txt")
            if prep:
                await _out(ws, prep)
            hub.log.clear()
            await _out(ws, line)
            counted = (hub.count("bucket_paths_info"),
                       hub.count("bucket_resolve"))
            assert counted == (posts, 0)
        finally:
            await ws.close()


async def _pinned_state(hub: FakeHub):
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, "cat /m/a.txt")
        return await to_state_dict(ws)
    finally:
        await ws.close()


async def _load(state, vfs, line: str = "cat /m/a.txt"):
    # The drift check drains on the first command after the load.
    loaded = await Workspace.from_state(state, mounts={"/m": vfs})
    try:
        await _out(loaded, line)
    finally:
        await loaded.close()


@pytest.mark.asyncio
async def test_a_read_pins_and_a_changed_file_drifts():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        _files(hub)["a.txt"] = NEW
        with pytest.raises(ContentDriftError):
            await _load(state, _vfs(hub))


@pytest.mark.asyncio
async def test_the_pin_is_the_reads_own_token():
    with serve(_hub({"a.txt": OLD})) as hub:
        hub.etags["a.txt"] = '"other"'
        state = await _pinned_state(hub)
        hub.etags.clear()
        # Upstream never changed; the pin is what the read vouched for, and
        # stat's token differs from it, which the check reports.
        with pytest.raises(ContentDriftError) as info:
            await _load(state, _vfs(hub))
        assert info.value.live_fingerprint == xet_hash(OLD)


@pytest.mark.asyncio
async def test_a_drift_check_the_hub_refuses_is_not_drift():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        hub.fail["bucket_paths_info"] = (401, "")
        with pytest.raises(PermissionError):
            await _load(state, _vfs(hub))


@pytest.mark.asyncio
async def test_an_unchanged_file_loads_on_one_paths_info():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        hub.log.clear()
        await _load(state, _vfs(hub), line="true")
        assert (hub.count("bucket_paths_info"),
                hub.count("bucket_resolve")) == (1, 0)


@pytest.mark.asyncio
async def test_a_file_deleted_upstream_drifts_to_nothing():
    with serve(_hub({"a.txt": OLD})) as hub:
        state = await _pinned_state(hub)
        del _files(hub)["a.txt"]
        with pytest.raises(ContentDriftError) as info:
            await _load(state, _vfs(hub), line="true")
        assert info.value.live_fingerprint is None


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual="/m/" + path,
                    directory="/m/",
                    vfs_path=path,
                    raw_path="/m/" + path)


@pytest.mark.asyncio
async def test_a_window_past_eof_is_empty_on_every_door():
    with serve(_hub({"a.txt": b"abc"})) as hub:
        vfs = _vfs(hub)
        ws = _ws(vfs, ReadPolicy.BOUNDED)
        try:
            # The ops read op folds a 416 for every backend; the VFS's own
            # range door has no fold, so the read must answer it itself.
            via_op = await ws.mount("/m/a.txt").execute_op(
                "read",
                "/m/a.txt",
                index=RAMIndexCacheStore(),
                offset=99,
                size=5)
            assert via_op == b""
            assert await vfs.range_read(_spec("a.txt"), 99, 104) == b""
        finally:
            await ws.close()
