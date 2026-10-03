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
import importlib
import os
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest

from mirage.cache.index.ram import ListingCheckStore
from mirage.types import ListingVersion, MountMode, ReadPolicy, ReadSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk import DiskVFS
from mirage.vfs.loader import load_attr
from mirage.vfs.registry import REGISTRY, build_vfs, known_vfs_names
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.reconcile import Reconciler
from tests.fixtures.github_api import FakeGitHub, serve
from tests.fixtures.hf_hub_api import FakeHub
from tests.fixtures.hf_hub_api import serve as serve_hub

disk_readdir = importlib.import_module("mirage.core.disk.readdir")


@dataclass
class Harness:
    """One declarer, filled and ready to be checked.

    Args:
        ws (Workspace): a fresh workspace with the backend at ``/m``.
        key (str): the listing key its check covers (the mount root for
            MOUNT, a folder for FOLDER).
        nested (str): a folder below the root, listed by the same fill.
        counts (Callable): (checks, refills) sent to the backend so far.
        change (Callable): change the backend outside mirage.
        checks (int): the checks one command listing ``key`` and
            ``nested`` sends: one for a MOUNT version, one per folder for
            a FOLDER version.
    """

    ws: Workspace
    key: str
    nested: str
    counts: Callable[[], tuple[int, int]]
    change: Callable[[], None]
    checks: int = 1


@asynccontextmanager
async def _github() -> AsyncIterator[Harness]:
    hub = FakeGitHub(files={"docs/sub/a.txt": b"a\n", "top.txt": b"t\n"})
    with serve(hub):
        vfs = build_vfs(
            "github",
            {
                "token": "t",
                "owner": "o",
                "repo": "r",
                "ref": "main",
                "base_url": hub.url,
            },
        )
        ws = Workspace(
            {
                "/m": Mount(
                    vfs=vfs,
                    mode=MountMode.READ,
                    read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
                )
            }
        )
        try:
            yield Harness(
                ws=ws,
                key="/m",
                nested="/m/docs/sub",
                counts=lambda: (hub.count("dir"), hub.count("recursive")),
                change=lambda: hub.files.__setitem__("docs/new.txt", b"n\n"),
            )
        finally:
            await ws.close()


def _hf(name: str, segment: str) -> Callable[[], AsyncIterator[Harness]]:

    @asynccontextmanager
    async def harness() -> AsyncIterator[Harness]:
        repo = (segment, "acme/widget")
        hub = FakeHub(
            repos={repo: {"docs/sub/a.txt": b"a\n", "top.txt": b"t\n"}}
        )
        with serve_hub(hub):
            vfs = build_vfs(
                name, {"repo_id": "acme/widget", "endpoint": hub.url}
            )
            ws = Workspace(
                {
                    "/m": Mount(
                        vfs=vfs,
                        mode=MountMode.READ,
                        read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
                    )
                }
            )
            try:
                yield Harness(
                    ws=ws,
                    key="/m",
                    nested="/m/docs/sub",
                    counts=lambda: (hub.count("revision"), hub.count("tree")),
                    change=lambda: hub.repos[repo].__setitem__(
                        "docs/new.txt", b"n\n"
                    ),
                )
            finally:
                await ws.close()

    return harness


@asynccontextmanager
async def _disk() -> AsyncIterator[Harness]:
    with (
        tempfile.TemporaryDirectory() as tmp,
        pytest.MonkeyPatch.context() as mp,
    ):
        root = Path(tmp)
        (root / "docs" / "sub").mkdir(parents=True)
        (root / "docs" / "sub" / "a.txt").write_bytes(b"a\n")
        (root / "top.txt").write_bytes(b"t\n")
        clock = {"now": 0}

        def settle() -> None:
            # The clock rule: 3 s past the latest change of every folder
            # listed, re-read after each outside change, so no version is
            # withheld by the racy guard.
            clock["now"] = (
                max(
                    max(st.st_ctime_ns, st.st_mtime_ns)
                    for st in map(os.stat, (root, root / "docs" / "sub"))
                )
                + 3_000_000_000
            )

        settle()
        mp.setattr(
            "mirage.core.disk.listing_version.time_ns", lambda: clock["now"]
        )
        scans: list[str] = []
        checks: list[str] = []
        scan = disk_readdir.read_entries
        check = Reconciler._listing_fingerprint

        def counted_scan(directory):
            scans.append(str(directory))
            return scan(directory)

        async def counted_check(self, mount, path):
            checks.append(path)
            return await check(self, mount, path)

        mp.setattr(disk_readdir, "read_entries", counted_scan)
        mp.setattr(Reconciler, "_listing_fingerprint", counted_check)

        def change() -> None:
            (root / "new.txt").write_bytes(b"n\n")
            settle()

        vfs = build_vfs("disk", {"root": tmp})
        ws = Workspace(
            {
                "/m": Mount(
                    vfs=vfs,
                    mode=MountMode.WRITE,
                    read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
                )
            }
        )
        try:
            yield Harness(
                ws=ws,
                key="/m",
                nested="/m/docs/sub",
                counts=lambda: (len(checks), len(scans)),
                change=change,
                checks=2,
            )
        finally:
            await ws.close()


# A declarer gets a harness proving that its check and its fill agree, so
# the gate's stat and the stored version are one kind of token. Each
# declaring backend adds its row with its declaration.
HARNESSES: dict[str, Callable[[], AsyncIterator[Harness]]] = {
    "github": _github,
    "hf_models": _hf("hf_models", "models"),
    "hf_datasets": _hf("hf_datasets", "datasets"),
    "hf_spaces": _hf("hf_spaces", "spaces"),
    "disk": _disk,
}


def _declared() -> set[str]:
    declared = set()
    for name in known_vfs_names():
        entry = REGISTRY.get(name)
        if entry is None:
            continue
        if load_attr(entry.vfs_path).listing_version != ListingVersion.NONE:
            declared.add(name)
    return declared


def test_every_declaring_backend_has_a_harness():
    assert _declared() == set(HARNESSES)


def test_the_harness_roster_is_pinned():
    # A literal, not the derived set: the expectation must not move with
    # the registry it checks.
    assert sorted(HARNESSES) == [
        "disk",
        "github",
        "hf_datasets",
        "hf_models",
        "hf_spaces",
    ]


def test_the_base_declares_no_version_and_no_pin():
    assert BaseVFS.listing_version is ListingVersion.NONE
    assert BaseVFS.listings_pin is None
    assert [m.value for m in ListingVersion] == ["none", "mount", "folder"]


async def _shell(ws: Workspace, line: str) -> None:
    result = await asyncio.wait_for(ws.shell(line), 10)
    await result.materialize_stdout()
    assert (result.exit_code, await result.stderr_str()) == (0, ""), line


async def _check_contract(name: str) -> None:
    async with HARNESSES[name]() as harness:
        ws = harness.ws
        mount = ws.mount(harness.key)
        await _shell(ws, f"ls {harness.key} {harness.nested}")
        store = mount.index_store
        stored = (await store.list_dir(harness.key)).version
        assert stored is not None
        assert (await store.list_dir(harness.nested)).version is not None
        remote = await mount.execute_op(
            "stat", harness.key, index=ListingCheckStore()
        )
        assert remote.fingerprint == stored
        before = harness.counts()
        await _shell(ws, f"ls {harness.key} {harness.nested}")
        checks, refills = (
            now - then for now, then in zip(harness.counts(), before)
        )
        assert (checks, refills) == (harness.checks, 0)
        assert mount.vfs.listing_version == type(mount.vfs).listing_version
        harness.change()
        moved = await mount.execute_op(
            "stat", harness.key, index=ListingCheckStore()
        )
        assert moved.fingerprint is not None
        assert moved.fingerprint != stored


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(HARNESSES))
async def test_a_declarers_check_answers_what_its_fill_stored(name):
    await _check_contract(name)


def test_turning_folder_versions_off_leaves_the_declaration(tmp_path):
    off = DiskVFS(str(tmp_path), folder_versions=False)
    on = DiskVFS(str(tmp_path))
    assert off.listing_version is ListingVersion.NONE
    assert on.listing_version is ListingVersion.FOLDER
    assert DiskVFS.listing_version is ListingVersion.FOLDER
    assert "disk" in _declared()
