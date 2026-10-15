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

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GitHubConfig
from mirage.core.github.readdir import readdir
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import DirListing, FileType, PathSpec
from tests.fixtures.github_api import FakeGitHub, serve


@pytest.fixture
def tree():
    return {
        "src": TreeEntry(path="src", type="tree", sha="aaa", size=None),
        "src/main.py": TreeEntry(
            path="src/main.py", type="blob", sha="bbb", size=120
        ),
        "src/utils": TreeEntry(
            path="src/utils", type="tree", sha="ccc", size=None
        ),
        "src/utils/helpers.py": TreeEntry(
            path="src/utils/helpers.py", type="blob", sha="ddd", size=80
        ),
        "README.md": TreeEntry(
            path="README.md", type="blob", sha="eee", size=50
        ),
    }


@pytest.fixture
def accessor(tree, monkeypatch) -> GitHubAccessor:
    async def fetch_tree(config, owner, repo, ref, session=None):
        return dict(tree), False, "HEAD1"

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", fetch_tree)
    return GitHubAccessor(GitHubConfig(token="t"), "o", "r", "main")


def _spec(rel: str) -> PathSpec:
    virtual = "/" + rel if rel else "/"
    return PathSpec(vfs_path=rel, virtual=virtual, directory=virtual)


def _names(listing: DirListing) -> list[str]:
    return [row.name for row in listing.entries]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rel,names",
    [
        ("", ["README.md", "src"]),
        ("src", ["main.py", "utils"]),
        ("src/utils", ["helpers.py"]),
    ],
)
async def test_readdir_lists_a_folder_of_the_tree(accessor, rel, names):
    assert _names(await readdir(accessor, _spec(rel))) == names


@pytest.mark.asyncio
async def test_one_tree_seeds_every_folder_below_at_its_head(accessor):
    listing = await readdir(accessor, _spec(""))

    assert listing.version == "HEAD1"
    assert {k: [r.name for r in v] for k, v in listing.seeds.items()} == {
        "src": ["main.py", "utils"],
        "src/utils": ["helpers.py"],
    }
    utils = next(row for row in listing.seeds["src"] if row.name == "utils")
    assert (utils.type, utils.extra) == (FileType.DIRECTORY, {"sha": "ccc"})
    main = listing.seeds["src"][0]
    assert (main.size, main.fingerprint) == (120, "bbb")


@pytest.mark.asyncio
async def test_readdir_refuses_what_is_no_folder(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, _spec("nonexistent"))
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, _spec("README.md"))


def _truncated(gh: FakeGitHub) -> GitHubAccessor:
    return GitHubAccessor(
        GitHubConfig(token="t", base_url=gh.url),
        "o",
        "r",
        "main",
        tree={},
        truncated=True,
    )


@pytest.mark.asyncio
async def test_a_truncated_tree_lists_each_folder_by_its_sha():
    files = {"top.txt": b"t", "docs/sub/b.txt": b"b"}
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as gh:
        accessor = _truncated(gh)
        root = await readdir(
            accessor, PathSpec(vfs_path="", virtual="/gh", directory="/gh")
        )
        assert _names(root) == ["docs", "top.txt"]
        docs = await readdir(
            accessor,
            PathSpec(
                vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"
            ),
            root.entries[0],
        )
        assert _names(docs) == ["sub"]
        assert gh.count("recursive") == 0
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"
                ),
            )


@pytest.mark.asyncio
async def test_the_truncated_walk_refuses_a_directory_github_cut_short():
    files = {"top.txt": b"t", "big/a.txt": b"a", "big/b.txt": b"b"}
    with serve(FakeGitHub(files=files, truncated_recursive=True)) as gh:
        gh.truncated_dirs["big"] = 1
        accessor = _truncated(gh)
        root = await readdir(
            accessor, PathSpec(vfs_path="", virtual="/gh", directory="/gh")
        )
        big = next(row for row in root.entries if row.name == "big")
        path = PathSpec(vfs_path="big", virtual="/gh/big", directory="/gh/big")
        with pytest.raises(GitHubApiError, match="truncated the tree listing"):
            await readdir(accessor, path, big)


@pytest.mark.asyncio
async def test_readdir_reports_a_folder_the_fresh_tree_dropped_as_missing():
    files = {"docs/a.txt": b"a", "top.txt": b"t"}
    with serve(FakeGitHub(files=files)) as gh:
        accessor = GitHubAccessor(
            GitHubConfig(token="t", base_url=gh.url), "o", "r", "main"
        )
        del gh.files["docs/a.txt"]
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"
                ),
            )
