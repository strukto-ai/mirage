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

from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.client import GitHubApiError
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.core.github.stat import tree as subtree
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.github import GitHubVFS
from mirage.workspace import Workspace
from tests.core.github.conftest import TREES, GitHubRepo, blob_sha

ROOT = PathSpec(virtual="/gh", directory="/gh", vfs_path="")
FILES = {"src/main.py": b"x" * 120, "README.md": b"y" * 50}
THREE = {f"d{i}/{n}.txt": b"x\n" for i in (1, 2, 3) for n in "abc"}


def _vfs(repo: GitHubRepo) -> GitHubVFS:
    return GitHubVFS(repo.config(ref="main"))


def _under(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual[len("/gh") :]
    )


async def _stat_at(repo: GitHubRepo, path: str) -> FileStat:
    ws = Workspace({"/gh": _vfs(repo)}, mode=MountMode.READ)
    try:
        row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
        return row
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stat_file(repo):
    await repo.create(FILES)
    result = await _stat_at(repo, "/gh/src/main.py")
    assert result.name == "main.py"
    assert result.size == 120
    assert result.content == ContentType.TEXT
    assert result.fingerprint == blob_sha(b"x" * 120)
    assert result.extra == {"sha": blob_sha(b"x" * 120)}


@pytest.mark.asyncio
async def test_stat_directory_and_root(repo):
    await repo.create(FILES)
    found = await _stat_at(repo, "/gh/src")
    root = await stat(_vfs(repo).accessor, ROOT)
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
async def test_stat_not_found(repo):
    await repo.create(FILES)
    with pytest.raises(FileNotFoundError):
        await _stat_at(repo, "/gh/nonexistent.py")


@pytest.mark.asyncio
async def test_stat_propagates_a_listing_failure(repo):
    # A tree the backend refuses is no answer about the path, so the
    # refusal surfaces rather than ENOENT.
    await repo.create(FILES)
    await repo.refuse("recursive", 500, "boom")
    with pytest.raises(GitHubApiError, match="boom") as raised:
        await _stat_at(repo, "/gh/missing.py")
    assert raised.value.status == 500


@pytest.mark.asyncio
async def test_a_check_asks_the_parent_directory(repo):
    await repo.create(FILES)
    vfs = _vfs(repo)
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
    assert await repo.counts() == (2, 0, 0)


@pytest.mark.asyncio
async def test_a_check_asks_the_whole_tree_past_a_cut_listing(repo):
    await repo.create(FILES)
    await repo.cut_short("src", 0)
    vfs = _vfs(repo)
    found = await stat(
        vfs.accessor, _under("/gh/src/main.py"), None, ListingCheckStore()
    )
    assert found.size == 120
    assert await repo.counts() == (1, 1, 0)


# The parent's own listing is refused, so the check falls back to the whole
# tree, which is truncated, and walks it folder by folder.
@pytest.mark.asyncio
async def test_a_check_walks_a_truncated_tree_by_its_folders(repo):
    await repo.create({"top.txt": b"t", "docs/sub/b.txt": b"b"})
    await repo.truncate()
    await repo.run.answer_next(
        "GET",
        TREES,
        404,
        {"message": "Not Found"},
        path=repo.tree_path("main:docs/sub"),
    )
    vfs = _vfs(repo)
    found = await stat(
        vfs.accessor,
        _under("/gh/docs/sub/b.txt"),
        None,
        ListingCheckStore(),
    )
    assert found.size == 1
    assert (await repo.count("recursive"), await repo.count("sha_dir")) == (
        1,
        2,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 500])
async def test_a_refused_head_names_no_version_and_refills_nothing(
    repo, status
):
    await repo.create(THREE)
    vfs = _vfs(repo)
    await repo.refuse("dir", status, "refused")
    found = await stat(vfs.accessor, ROOT, None, ListingCheckStore())
    assert found.fingerprint is None
    assert await repo.count("recursive") == 0
    assert (vfs.accessor.tree, vfs.accessor.tree_loaded) == ({}, False)


# Through any store but the gate's check the root names no version and asks
# nothing; only the check wants that request.
@pytest.mark.asyncio
async def test_a_root_stat_outside_a_check_asks_nothing(repo):
    head = await repo.create(THREE)
    vfs = _vfs(repo)
    found = await stat(vfs.accessor, ROOT)
    assert found.fingerprint is None
    assert await repo.counts() == (0, 0, 0)
    checked = await stat(vfs.accessor, ROOT, None, ListingCheckStore())
    assert checked.fingerprint == head


@pytest.mark.asyncio
async def test_tree_answers_each_entry_as_its_listing_does(repo):
    await repo.create(
        {"docs/a.txt": b"alpha", "docs/sub/b.txt": b"bb", "top.txt": b"t"}
    )
    vfs = _vfs(repo)
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
async def test_tree_leaves_a_file_and_a_truncated_tree_to_the_walk(repo):
    await repo.create({"docs/a.txt": b"alpha", "top.txt": b"t"})
    vfs = _vfs(repo)
    assert await subtree(vfs.accessor, _under("/gh/top.txt")) is None
    assert await subtree(vfs.accessor, _under("/gh/nope")) is None
    await repo.truncate()
    vfs = _vfs(repo)
    assert await subtree(vfs.accessor, ROOT) is None
    assert await subtree(vfs.accessor, ROOT) is None
    assert await repo.count("recursive") == 1
