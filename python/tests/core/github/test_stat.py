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

from unittest.mock import AsyncMock

import pytest

import mirage.core.github.stat as stat_module
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.core.github.stat import tree as subtree
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.github import GitHubVFS
from mirage.workspace import Workspace
from tests.fixtures.github_api import FakeGitHub, blob_sha, serve

ROOT = PathSpec(virtual="/gh", directory="/gh", vfs_path="")
FILES = {"src/main.py": b"x" * 120, "README.md": b"y" * 50}


def _three() -> FakeGitHub:
    return FakeGitHub(
        files={f"d{i}/{n}.txt": b"x\n" for i in (1, 2, 3) for n in "abc"}
    )


def _vfs(hub: FakeGitHub) -> GitHubVFS:
    return GitHubVFS(
        GitHubConfig(
            token="t", owner="o", repo="r", ref="main", base_url=hub.url
        )
    )


def _under(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual[len("/gh") :]
    )


async def _stat_at(hub: FakeGitHub, path: str) -> FileStat:
    ws = Workspace({"/gh": _vfs(hub)}, mode=MountMode.READ)
    try:
        row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
        return row
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stat_file():
    with serve(FakeGitHub(files=FILES)) as hub:
        result = await _stat_at(hub, "/gh/src/main.py")
    assert result.name == "main.py"
    assert result.size == 120
    assert result.content == ContentType.TEXT
    assert result.fingerprint == blob_sha(b"x" * 120)
    assert result.extra == {"sha": blob_sha(b"x" * 120)}


@pytest.mark.asyncio
async def test_stat_directory_and_root():
    with serve(FakeGitHub(files=FILES)) as hub:
        found = await _stat_at(hub, "/gh/src")
        root = await stat(_vfs(hub).accessor, ROOT)
    assert (found.name, found.type, found.fingerprint) == (
        "src",
        FileType.DIRECTORY,
        None,
    )
    assert (root.name, root.type, root.fingerprint) == (
        "/",
        FileType.DIRECTORY,
        None,
    )


@pytest.mark.asyncio
async def test_stat_not_found():
    with serve(FakeGitHub(files=FILES)) as hub:
        with pytest.raises(FileNotFoundError):
            await _stat_at(hub, "/gh/nonexistent.py")


@pytest.mark.asyncio
async def test_stat_propagates_a_listing_failure():
    # A tree the backend refuses is no answer about the path, so the
    # refusal surfaces rather than ENOENT.
    with serve(FakeGitHub(files=FILES)) as hub:
        hub.fail["recursive"] = (500, "boom")
        with pytest.raises(Exception, match="500"):
            await _stat_at(hub, "/gh/missing.py")


@pytest.mark.asyncio
async def test_a_check_asks_the_parent_directory():
    with serve(FakeGitHub(files=FILES)) as hub:
        vfs = _vfs(hub)
        found = await stat(
            vfs.accessor, _under("/gh/src/main.py"), None, ListingCheckStore()
        )
        assert found.fingerprint == blob_sha(b"x" * 120)
        with pytest.raises(FileNotFoundError):
            await stat(
                vfs.accessor,
                _under("/gh/src/nope.py"),
                None,
                ListingCheckStore(),
            )
        assert hub.counts() == (2, 0, 0)


@pytest.mark.asyncio
async def test_a_check_asks_the_whole_tree_past_a_cut_listing():
    with serve(FakeGitHub(files=FILES)) as hub:
        hub.truncated_dirs["src"] = 0
        vfs = _vfs(hub)
        found = await stat(
            vfs.accessor, _under("/gh/src/main.py"), None, ListingCheckStore()
        )
        assert found.size == 120
        assert hub.counts() == (1, 1, 0)


@pytest.mark.asyncio
async def test_a_check_walks_a_truncated_tree_by_its_folders(monkeypatch):
    files = {"top.txt": b"t", "docs/sub/b.txt": b"b"}
    monkeypatch.setattr(stat_module, "point_row", AsyncMock(return_value=None))
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as hub:
        vfs = _vfs(hub)
        found = await stat(
            vfs.accessor,
            _under("/gh/docs/sub/b.txt"),
            None,
            ListingCheckStore(),
        )
        assert found.size == 1
        assert (hub.count("recursive"), hub.count("sha_dir")) == (1, 2)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 500])
async def test_a_refused_head_names_no_version_and_refills_nothing(status):
    with serve(_three()) as hub:
        vfs = _vfs(hub)
        hub.fail["dir"] = (status, "refused")
        found = await stat(vfs.accessor, ROOT, None, ListingCheckStore())
        assert found.fingerprint is None
        assert hub.count("recursive") == 0
        assert (vfs.accessor.tree, vfs.accessor.tree_loaded) == ({}, False)


# Through any store but the gate's check the root names no version and asks
# nothing; only the check wants that request.
@pytest.mark.asyncio
async def test_a_root_stat_outside_a_check_asks_nothing():
    with serve(_three()) as hub:
        vfs = _vfs(hub)
        found = await stat(vfs.accessor, ROOT)
        assert found.fingerprint is None
        assert hub.counts() == (0, 0, 0)
        checked = await stat(vfs.accessor, ROOT, None, ListingCheckStore())
        assert checked.fingerprint == hub.head()


@pytest.mark.asyncio
async def test_tree_answers_each_entry_as_its_listing_does():
    files = {"docs/a.txt": b"alpha", "docs/sub/b.txt": b"bb", "top.txt": b"t"}
    with serve(FakeGitHub(files=files)) as hub:
        vfs = _vfs(hub)
        found = await subtree(vfs.accessor, _under("/gh/docs"))
        assert found is not None
        assert sorted(found) == ["a.txt", "sub", "sub/b.txt"]
        listing = await readdir(vfs.accessor, _under("/gh/docs"))
        assert {row.name: row for row in listing.entries} == {
            "a.txt": found["a.txt"],
            "sub": found["sub"],
        }
        assert sorted(await subtree(vfs.accessor, ROOT) or {}) == [
            "docs",
            "docs/a.txt",
            "docs/sub",
            "docs/sub/b.txt",
            "top.txt",
        ]


@pytest.mark.asyncio
async def test_tree_leaves_a_file_and_a_truncated_tree_to_the_walk():
    files = {"docs/a.txt": b"alpha", "top.txt": b"t"}
    with serve(FakeGitHub(files=files)) as hub:
        vfs = _vfs(hub)
        assert await subtree(vfs.accessor, _under("/gh/top.txt")) is None
        assert await subtree(vfs.accessor, _under("/gh/nope")) is None
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as hub:
        vfs = _vfs(hub)
        assert await subtree(vfs.accessor, ROOT) is None
        assert await subtree(vfs.accessor, ROOT) is None
        assert hub.count("recursive") == 1
