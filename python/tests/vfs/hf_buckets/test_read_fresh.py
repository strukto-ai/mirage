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
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from mirage.cache.file.config import CacheConfig
from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.state import to_state_dict
from tests.fixtures.hf_bucket import HfBucket

OLD = b"version one\n"
NEW = b"version two, longer\n"


@pytest_asyncio.fixture
async def watched(bucket: HfBucket) -> AsyncIterator[HfBucket]:
    """The test's bucket, checked afterwards for a read through opendal:
    a stat or read that fell back to it would answer the same bytes, so
    only the request list can tell.

    Args:
        bucket (HfBucket): the test's bucket.
    """
    yield bucket
    assert await bucket.count("opendal_read") == 0


async def _seeded(bucket: HfBucket, **files: bytes) -> None:
    await bucket.put(**files)
    await bucket.run.record_requests()


def _vfs(bucket: HfBucket, **config: str):
    return build_vfs("hf_buckets", bucket.fields(**config))


def _ws(vfs, policy: ReadPolicy = ReadPolicy.FRESH) -> Workspace:
    return Workspace(
        {
            "/m": Mount(
                vfs=vfs, mode=MountMode.WRITE, read=ReadSpec(policy=policy)
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        cache=CacheConfig(),
    )


async def _out(ws: Workspace, line: str, stdin: bytes | None = None) -> bytes:
    result = await ws.shell(line, stdin=stdin)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


@pytest.mark.asyncio
async def test_a_written_path_carries_no_token_then_heals_in_one_read(
    watched,
):
    # #1138. A bucket write stamps no token (opendal reports none, and #1101
    # Phase 1 adds no stat after a write), so the written entry verifies
    # against nothing: the first fresh read refetches once, and that read's
    # stamp makes every read after it warm.
    ws = _ws(_vfs(watched))
    try:
        await _out(ws, "tee /m/w.txt", stdin=b"hi\n")
        writes = [
            r.fingerprint
            for r in ws.vfs.records
            if not r.is_cache and r.op == "write"
        ]
        assert writes == [None]
        # Absent, not merely different: an invented token would pass a
        # check that only compared it with the xet hash.
        assert ws.cache._entries["/m/w.txt"].fingerprint is None
        assert not await ws.cache.is_fresh(
            "/m/w.txt", hashlib.md5(b"hi\n").hexdigest()
        )
        before = await watched.count("resolve")
        assert await _out(ws, "cat /m/w.txt") == b"hi\n"
        assert await watched.count("resolve") == before + 1
        assert await _out(ws, "cat /m/w.txt") == b"hi\n"
        assert await watched.count("resolve") == before + 1
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(401, ""), (404, "RepoNotFound")])
async def test_a_refused_probe_keeps_the_overlay(watched, status, code):
    await _seeded(watched, **{"a.txt": OLD})
    ws = _ws(_vfs(watched))
    try:
        await _out(ws, "cat /m/a.txt")
        await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
        await watched.refuse("paths_info", status, code)
        # Cross-mount cp reads through the dispatcher, the dispatcher whose
        # "no such file" drops the overlay; a plain cat never reaches it.
        cp = await ws.shell("cp /m/a.txt /r/x")
        assert cp.exit_code == 1
        assert await cp.stderr_str() == (
            "cp: cannot stat '/m/a.txt': Permission denied\n"
        )
        await watched.run.clear_answers()
        meta = ws.namespace.meta_for("/m/a.txt")
        assert meta is not None and meta.mode == 0o600
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_download_404_that_is_not_entry_not_found_keeps_the_overlay(
    watched,
):
    await _seeded(watched, **{"a.txt": OLD})
    ws = _ws(_vfs(watched))
    try:
        await _out(ws, "cat /m/a.txt")
        await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
        await ws.cache.remove("/m/a.txt")
        # A CDN-shaped 404 carries no error code: it is a failed
        # download, not a deleted file. Measured on the first green run:
        # the raw Hub error, not "No such file".
        await watched.refuse("resolve", 404)
        cp = await ws.shell("cp /m/a.txt /r/x")
        assert (cp.exit_code, await cp.stderr_str()) == (
            1,
            "cp: fake resolve refused\n",
        )
        meta = ws.namespace.meta_for("/m/a.txt")
        assert meta is not None and meta.mode == 0o600
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_gated_bucket_does_not_hide_the_other_mounts(watched):
    await _seeded(watched, **{"a.txt": b"needle\n"})
    await watched.refuse("resolve", 403)
    ws = Workspace(
        {
            "/m": (_vfs(watched), MountMode.READ),
            "/r": (RAMVFS(), MountMode.WRITE),
        }
    )
    try:
        await _out(ws, "tee /r/n.txt", stdin=b"needle\n")
        grep = await ws.shell("grep -r needle /")
        assert await grep.materialize_stdout() == b"/r/n.txt:needle\n"
        assert "Permission denied" in await grep.stderr_str()
        cat = await ws.shell("cat /m/a.txt")
        assert cat.exit_code == 1
        assert await cat.stderr_str() == "cat: /m/a.txt: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_listing_a_refused_bucket_is_never_absent(watched):
    # `ls` of a file reaches paths-info through the listing's file probe
    # (object_store readdir `_probe_file`); find and du answer from the
    # opendal listing alone, so only the dispatcher can mistake a refusal for
    # an absence.
    await _seeded(watched, **{"a.txt": OLD})
    await watched.refuse("paths_info", 401)
    ws = _ws(_vfs(watched), ReadPolicy.BOUNDED)
    try:
        result = await ws.shell("ls /m/a.txt")
        await result.materialize_stdout()
        # The raw refusal, never "No such file"; pinned on the first
        # green run.
        assert (result.exit_code, await result.stderr_str()) == (
            1,
            "ls: fake paths_info refused\n",
        )
        assert (await ws.mount("/m").index_store.get("/m/a.txt")).entry is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_probe_leaves_find_its_whole_prefixed_listing(watched):
    # A fresh probe stats through a throwaway index and writes nothing back,
    # so a find after a warm read still lists the whole prefixed subtree.
    await _seeded(
        watched,
        **{"pfx/a.txt": OLD, "pfx/sub/b.txt": NEW, "a.txt": b"decoy\n"},
    )
    ws = _ws(_vfs(watched, key_prefix="pfx/"))
    try:
        assert await _out(ws, "cat /m/a.txt") == OLD
        assert await _out(ws, "cat /m/a.txt") == OLD
        assert await _out(ws, "find /m") == (
            b"/m\n/m/a.txt\n/m/sub\n/m/sub/b.txt\n"
        )
    finally:
        await ws.close()


# Measured on the first green run, then pinned (test plan T23): the
# operand probe, at the command's first lookup of its operand; the
# handler's own stat and the cache stage reuse its answer.
WARM = [
    ("", "cat /m/a.txt", 1),
    ("ls /m", "cat /m/a.txt", 1),
    ("", "cat /m/a.txt | head -c 1", 1),
    ("", "cp /m/a.txt /r/a.txt", 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("prep,line,posts", WARM)
async def test_a_warm_fresh_read_costs_paths_info_and_no_download(
    watched, prep, line, posts
):
    await _seeded(watched, **{"a.txt": OLD})
    ws = _ws(_vfs(watched))
    try:
        await _out(ws, "cat /m/a.txt")
        if prep:
            await _out(ws, prep)
        await watched.run.record_requests()
        await _out(ws, line)
        counted = (
            await watched.count("paths_info"),
            await watched.count("resolve"),
        )
        assert counted == (posts, 0)
    finally:
        await ws.close()


async def _pinned_state(bucket: HfBucket):
    ws = _ws(_vfs(bucket))
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
async def test_a_read_pins_and_a_changed_file_drifts(watched):
    await _seeded(watched, **{"a.txt": OLD})
    state = await _pinned_state(watched)
    await watched.write("a.txt", NEW)
    with pytest.raises(ContentDriftError):
        await _load(state, _vfs(watched))


@pytest.mark.asyncio
async def test_the_pin_is_the_reads_own_token(watched):
    await _seeded(watched, **{"a.txt": OLD})
    await watched.serve_etag(OLD, '"other"')
    state = await _pinned_state(watched)
    # Upstream never changed; the pin is what the read vouched for, and
    # stat's token differs from it, which the check reports.
    with pytest.raises(ContentDriftError) as info:
        await _load(state, _vfs(watched))
    assert (
        info.value.live_fingerprint == (await watched.row("a.txt"))["xetHash"]
    )


@pytest.mark.asyncio
async def test_a_drift_check_the_hub_refuses_is_not_drift(watched):
    await _seeded(watched, **{"a.txt": OLD})
    state = await _pinned_state(watched)
    await watched.refuse("paths_info", 401)
    with pytest.raises(PermissionError):
        await _load(state, _vfs(watched))


@pytest.mark.asyncio
async def test_an_unchanged_file_loads_on_one_paths_info(watched):
    await _seeded(watched, **{"a.txt": OLD})
    state = await _pinned_state(watched)
    await watched.run.record_requests()
    await _load(state, _vfs(watched), line="true")
    assert (
        await watched.count("paths_info"),
        await watched.count("resolve"),
    ) == (1, 0)


@pytest.mark.asyncio
async def test_a_file_deleted_upstream_drifts_to_nothing(watched):
    await _seeded(watched, **{"a.txt": OLD})
    state = await _pinned_state(watched)
    await watched.remove("a.txt")
    with pytest.raises(ContentDriftError) as info:
        await _load(state, _vfs(watched), line="true")
    assert info.value.live_fingerprint is None
