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

import aiohttp
import pytest

from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree import fetch_tree
from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.github import GitHubVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.keys import StateKey
from mirage.workspace.snapshot.state import to_state_dict
from tests.fixtures.github_api import FakeGitHub, blob_sha, serve

OLD = b"version one\n"
NEW = b"version two, longer\n"
PATH = "/gh/docs/a.txt"


def _hub(files: dict[str, bytes] | None = None, **kwargs) -> FakeGitHub:
    return FakeGitHub(files=dict(
        files or {
            "docs/a.txt": OLD,
            "docs/b.txt": b"bravo",
            "top.txt": b"top"
        }),
                      **kwargs)


def _vfs(hub: FakeGitHub):
    return build_vfs(
        "github", {
            "token": "t",
            "owner": "o",
            "repo": "r",
            "ref": "main",
            "base_url": hub.url
        })


def _ws(vfs, policy: ReadPolicy = ReadPolicy.FRESH, prefix: str = "/gh"):
    return Workspace({
        prefix:
        Mount(vfs=vfs, mode=MountMode.READ, read=ReadSpec(policy=policy)),
        "/r": (RAMVFS(), MountMode.WRITE),
    })


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _fails(ws: Workspace, line: str) -> str:
    result = await ws.shell(line)
    await result.materialize_stdout()
    assert result.exit_code == 1, line
    return await result.stderr_str()


# A mount at /src over a repository holding a src/ directory is the decoy: a
# record labelled repo-relative or mount-relative lands on a key the cache
# never asks for, so the entry would carry no token.
@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/", "/gh", "/src"])
async def test_a_read_leaves_its_sha_on_the_cache_entry(prefix):
    with serve(_hub({"src/a.txt": OLD})) as hub:
        ws = _ws(_vfs(hub), prefix=prefix)
        path = prefix.rstrip("/") + "/src/a.txt"
        try:
            assert await _out(ws, f"cat {path}") == OLD
            assert await ws.cache.is_fresh(path, blob_sha(OLD))
        finally:
            await ws.close()


# Each cell is (dir listings, whole-tree walks, blob downloads) for one line
# on a warm fresh mount. cat pays two probes (routing, then the cache door),
# as hf's table does; cp skips routing's probe.
WARM = [
    ("cat /gh/docs/a.txt", (2, 0, 0)),
    ("cat /gh/docs/a.txt | head -c 1", (2, 0, 0)),
    ("cp /gh/docs/a.txt /r/a.txt", (1, 0, 0)),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,cost", WARM)
async def test_a_warm_fresh_read_costs_one_listing_per_probe(line, cost):
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            hub.log.clear()
            await _out(ws, line)
            assert hub.counts() == cost
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_changed_file_is_refetched_once_then_served_warm():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            assert await _out(ws, f"cat {PATH}") == OLD
            hub.files["docs/a.txt"] = NEW
            hub.log.clear()
            assert await _out(ws, f"cat {PATH}") == NEW
            # The probe finds a new sha; cat's own stat asks the cleared
            # index's one directory; the read refills and downloads.
            assert hub.counts() == (2, 1, 1)
            hub.log.clear()
            assert await _out(ws, f"cat {PATH}") == NEW
            assert hub.counts() == (2, 0, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_bounded_mount_serves_its_cache():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
        try:
            assert await _out(ws, f"cat {PATH}") == OLD
            hub.files["docs/a.txt"] = NEW
            hub.log.clear()
            assert await _out(ws, f"cat {PATH}") == OLD
            assert hub.counts() == (0, 0, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_new_mount_lists_once_and_never_asks_one_directory():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"stat {PATH}")
            await _out(ws, f"stat {PATH}")
            await _out(ws, "ls /gh/docs")
            assert hub.counts() == (0, 1, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_bounded_mount_lists_once_and_never_asks_one_directory():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub), ReadPolicy.BOUNDED)
        try:
            await _out(ws, f"stat {PATH}")
            await _out(ws, f"stat {PATH}")
            await _out(ws, "ls /gh/docs")
            assert hub.counts() == (0, 1, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_revert_is_read_through_both_doors():
    # Content-addressed shas make every stamp source agree once the index is
    # refilled, so this guards that both the stream door (cat) and the bytes
    # door (cp) stamp, rather than telling stamp sources apart.
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            for step, data in enumerate((OLD, NEW, OLD)):
                hub.files["docs/a.txt"] = data
                assert await _out(ws, f"cat {PATH}") == data
                await _out(ws, f"cp {PATH} /r/c{step}")
                assert await _out(ws, f"cat /r/c{step}") == data
                assert await ws.cache.is_fresh(PATH, blob_sha(data))
                assert ("blob", blob_sha(data)) in hub.log
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_cold_read_serves_the_listing_until_a_probe_corrects_it():
    # Documented limit, chosen by the user: fresh revalidates cached bytes,
    # so the first read of a file comes from the mount's listing, and the
    # next read's probe corrects it.
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, "ls /gh/docs")
            hub.files["docs/a.txt"] = NEW
            assert await _out(ws, f"cat {PATH}") == OLD
            assert await ws.cache.is_fresh(PATH, blob_sha(OLD))
            assert await _out(ws, f"cat {PATH}") == NEW
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_probe_leaves_find_its_whole_listing():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _out(ws, f"cat {PATH}")
            walks = hub.count("recursive")
            listed = await _out(ws, "find /gh -type f")
            assert sorted(listed.decode().split()) == [
                "/gh/docs/a.txt", "/gh/docs/b.txt", "/gh/top.txt"
            ]
            assert hub.count("recursive") == walks
        finally:
            await ws.close()


async def _overlaid(ws: Workspace) -> None:
    await ws.namespace.set_attrs(PATH, mode=0o600)


def _kept(ws: Workspace) -> bool:
    meta = ws.namespace.meta_for(PATH)
    return meta is not None and meta.mode == 0o600


@pytest.mark.asyncio
async def test_a_repository_it_cannot_see_keeps_the_overlay():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _overlaid(ws)
            # Lost access answers 404 on both endpoints: cannot verify, so the
            # copy is dropped and the cold read fails, but nothing is gone.
            hub.fail.update({
                "dir": (404, "Not Found"),
                "recursive": (404, "Not Found")
            })
            err = await _fails(ws, f"cat {PATH}")
            # The HTTP error propagates as the cold read's message, unchanged
            # from any other refused github read; it is never ENOENT.
            assert err == ("cat: 404, message='Not Found', url='"
                           f"{hub.url}/repos/o/r/git/trees/main"
                           "?recursive=1'\n")
            assert _kept(ws)
            err = await _fails(ws, f"cp {PATH} /r/x")
            # cp renders a backend error without its own prefix, as it does
            # for any backend (unchanged here).
            assert err == ("404, message='Not Found', url='"
                           f"{hub.url}/repos/o/r/git/trees/main"
                           "?recursive=1'\n")
            assert _kept(ws)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_refused_token_keeps_the_overlay():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _overlaid(ws)
            # Only the one-directory route refuses: deferring on 401 would
            # walk the tree, which answers, and hide the refusal.
            hub.fail["dir"] = (401, "Bad credentials")
            hub.log.clear()
            err = await _fails(ws, f"cat {PATH}")
            assert err == ("cat: 401, message='Unauthorized', url='"
                           f"{hub.url}/repos/o/r/git/trees/main:docs'\n")
            assert hub.count("recursive") == 0
            assert _kept(ws)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_parent_directory_gone_upstream_is_gone():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _overlaid(ws)
            del hub.files["docs/a.txt"]
            del hub.files["docs/b.txt"]
            err = await _fails(ws, f"cat {PATH}")
            assert err == f"cat: {PATH}: No such file or directory\n"
            assert ws.namespace.meta_for(PATH) is None
            assert not await ws.cache.exists(PATH)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_file_gone_from_a_live_directory_is_gone():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _overlaid(ws)
            del hub.files["docs/a.txt"]
            hub.log.clear()
            err = await _fails(ws, f"cat {PATH}")
            assert err == f"cat: {PATH}: No such file or directory\n"
            assert ws.namespace.meta_for(PATH) is None
            # The probe and cat's own stat each answer absent from one listing
            # of docs/; the single walk is the generic adapter asking whether
            # the path is an implicit directory after that ENOENT. A probe
            # that deferred on the complete listing would walk once more.
            assert hub.counts() == (2, 1, 0)
        finally:
            await ws.close()


async def _cleared_with_overlay(ws: Workspace, hub: FakeGitHub) -> None:
    await _out(ws, f"cat {PATH}")
    await ws.cache.remove(PATH)
    mount = ws._registry.mount_for(PATH)
    await mount.index.clear()
    await _overlaid(ws)
    hub.fail.update({
        "dir": (404, "Not Found"),
        "recursive": (401, "Bad credentials")
    })


@pytest.mark.asyncio
async def test_the_dispatcher_door_never_reads_cannot_see_as_gone():
    # No cached copy, so cp's own stat is the op that reaches the backend:
    # an ENOENT there goes through on_op_missing, which drops the overlay.
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _cleared_with_overlay(ws, hub)
            err = await _fails(ws, f"cp {PATH} /r/x")
            assert err == ("401, message='Unauthorized', url='"
                           f"{hub.url}/repos/o/r/git/trees/main"
                           "?recursive=1'\n")
            assert _kept(ws)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_the_xattr_door_never_reads_cannot_see_as_gone():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _cleared_with_overlay(ws, hub)
            err = await _fails(ws, f"getfattr -d {PATH}")
            assert err == ("401, message='Unauthorized', url='"
                           f"{hub.url}/repos/o/r/git/trees/main"
                           "?recursive=1'\n")
            assert _kept(ws)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_truncated_parent_listing_is_not_absence():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        try:
            await _out(ws, f"cat {PATH}")
            await _overlaid(ws)
            hub.truncated_dirs["docs"] = 0
            hub.log.clear()
            assert await _out(ws, f"cat {PATH}") == OLD
            assert _kept(ws)
            # One listing of docs/ per probe, each cut short, so each defers
            # to one walk of the whole tree, which finds the file.
            assert hub.counts() == (2, 2, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_truncated_repository_probes_one_directory():
    files = {"top.txt": b"t", "docs/a.txt": OLD}
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as hub:
        config = GitHubConfig(token="t", base_url=hub.url)
        tree, truncated = await fetch_tree(config, "o", "r", "main")
        vfs = GitHubVFS(config,
                        "o",
                        "r",
                        "main",
                        default_branch="main",
                        tree=tree,
                        truncated=truncated)
        # Built truncated, as TypeScript's create builds it: only the
        # per-directory walk's listings can arm the point route here.
        assert vfs.accessor.refills == 0
        ws = _ws(vfs)
        try:
            assert await _out(ws, f"cat {PATH}") == OLD
            # The walk listed the root and docs/ on the way to the file.
            assert vfs.accessor.refills == 2
            hub.log.clear()
            assert await _out(ws, f"cat {PATH}") == OLD
            assert hub.counts() == (2, 0, 0)
            assert hub.count("sha_dir") == 0
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_directory_github_cuts_short_is_not_absence():
    # A truncated repository whose docs/ listing GitHub also cuts short: the
    # walk refuses the cut listing rather than caching it whole, so a probe
    # cannot read the file as gone, and the overlay stays.
    files = {"top.txt": b"t", "docs/a.txt": OLD, "docs/b.txt": b"bravo"}
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as hub:
        config = GitHubConfig(token="t", base_url=hub.url)
        tree, truncated = await fetch_tree(config, "o", "r", "main")
        vfs = GitHubVFS(config,
                        "o",
                        "r",
                        "main",
                        default_branch="main",
                        tree=tree,
                        truncated=truncated)
        ws = _ws(vfs)
        try:
            assert await _out(ws, f"cat {PATH}") == OLD
            await _overlaid(ws)
            hub.truncated_dirs["docs"] = 0
            err = await _fails(ws, f"cat {PATH}")
            assert err.startswith(
                "cat: GitHub truncated the tree listing of o/r ")
            assert _kept(ws)
        finally:
            await ws.close()


async def _pinned_state(hub: FakeGitHub):
    ws = _ws(_vfs(hub))
    try:
        await _out(ws, f"cat {PATH}")
        return await to_state_dict(ws)
    finally:
        await ws.close()


async def _load(state, vfs):
    loaded = await Workspace.from_state(state, mounts={"/gh": vfs})
    try:
        await _out(loaded, f"cat {PATH}")
    finally:
        await loaded.close()


@pytest.mark.asyncio
async def test_a_read_pins_its_sha_and_a_changed_file_drifts():
    with serve(_hub()) as hub:
        state = await _pinned_state(hub)
        pins = [f for f in state[StateKey.FINGERPRINTS] if f["path"] == PATH]
        assert [p["fingerprint"] for p in pins] == [blob_sha(OLD)]
        assert "/gh/" not in state[StateKey.LIVE_ONLY_MOUNTS]
        await _load(state, _vfs(hub))
        hub.files["docs/a.txt"] = NEW
        with pytest.raises(ContentDriftError) as caught:
            await _load(state, _vfs(hub))
        assert (caught.value.snapshot_fingerprint,
                caught.value.live_fingerprint) == (blob_sha(OLD),
                                                   blob_sha(NEW))


@pytest.mark.asyncio
async def test_a_drift_check_on_a_live_mount_asks_one_directory():
    with serve(_hub()) as hub:
        vfs = _vfs(hub)
        ws = _ws(vfs)
        try:
            await _out(ws, f"cat {PATH}")
            state = await to_state_dict(ws)
            hub.files["docs/a.txt"] = NEW
            hub.log.clear()
            with pytest.raises(ContentDriftError):
                await _load(state, vfs)
            assert (hub.count("dir"), hub.count("recursive")) == (1, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_drift_check_the_token_is_refused_is_not_drift():
    with serve(_hub()) as hub:
        vfs = _vfs(hub)
        ws = _ws(vfs)
        try:
            await _out(ws, f"cat {PATH}")
            state = await to_state_dict(ws)
            # The one-directory route is refused while the whole tree would
            # answer: deferring on 401 would pass the check silently.
            hub.fail["dir"] = (401, "Bad credentials")
            with pytest.raises(aiohttp.ClientResponseError) as caught:
                await _load(state, vfs)
            assert caught.value.status == 401
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_snapshot_from_before_github_pinned_still_loads():
    with serve(_hub()) as hub:
        state = await _pinned_state(hub)
        state[StateKey.FINGERPRINTS] = [
            f for f in state[StateKey.FINGERPRINTS]
            if not f["path"].startswith("/gh/")
        ]
        state[StateKey.LIVE_ONLY_MOUNTS] = ["/gh/"]
        loaded = await Workspace.from_state(state, mounts={"/gh": _vfs(hub)})
        try:
            # No pin, so nothing is checked and nothing raises under STRICT;
            # the override mount reads bounded and serves the restored copy.
            assert await _out(loaded, f"cat {PATH}") == OLD
        finally:
            await loaded.close()
