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
from mirage.core.api.errors import ApiError
from mirage.core.github.client import GitHubApiError
from mirage.core.github.readdir import readdir
from mirage.types import DirListing, FileType, PathSpec
from tests.core.github.conftest import TREES, GitHubRepo, blob_sha

FILES = {
    "src/main.py": b"m" * 120,
    "src/utils/helpers.py": b"h" * 80,
    "README.md": b"r" * 50,
}


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
async def test_readdir_lists_a_folder_of_the_tree(repo, rel, names):
    await repo.create(FILES)
    assert _names(await readdir(repo.accessor(), _spec(rel))) == names


# Two listings on one accessor whose trees answer at different heads: the
# first fetch is answered with the tree from before a push, and lands only
# after the second listing, fetched after the push, has reseated the
# accessor. Each listing keeps the head its own tree answered.
@pytest.mark.asyncio
async def test_each_listing_is_versioned_by_its_own_trees_head(repo):
    first_head = await repo.create(FILES)
    before_push = await repo.tree("main", recursive=True)
    shared = repo.accessor()
    second: dict[str, DirListing] = {}
    heads: list[str] = []

    async def push_and_list() -> None:
        heads.append(await repo.commit({"src/new.py": b"n"}))
        second["listing"] = await readdir(shared, _spec(""))
        await repo.run.answer_next(
            "GET", TREES, 200, before_push, query="recursive=1"
        )

    await repo.run.before_next([("GET", TREES)], push_and_list)
    first = await readdir(shared, _spec("src"))
    assert [first.version, second["listing"].version] == [
        first_head,
        heads[0],
    ]


@pytest.mark.asyncio
async def test_one_tree_seeds_every_folder_below_at_its_head(repo):
    head = await repo.create(FILES)
    utils_sha = next(
        row["sha"]
        for row in (await repo.tree("main:src"))["tree"]
        if row["path"] == "utils"
    )
    listing = await readdir(repo.accessor(), _spec(""))

    assert listing.version == head
    assert {k: [r.name for r in v] for k, v in listing.seeds.items()} == {
        "src": ["main.py", "utils"],
        "src/utils": ["helpers.py"],
    }
    utils = next(row for row in listing.seeds["src"] if row.name == "utils")
    assert (utils.type, utils.extra) == (
        FileType.DIRECTORY,
        {"sha": utils_sha},
    )
    main = listing.seeds["src"][0]
    assert (main.size, main.fingerprint) == (120, blob_sha(b"m" * 120))


@pytest.mark.asyncio
async def test_readdir_refuses_what_is_no_folder(repo):
    await repo.create(FILES)
    accessor = repo.accessor()
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, _spec("nonexistent"))
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, _spec("README.md"))


def _truncated(repo: GitHubRepo) -> GitHubAccessor:
    accessor = repo.accessor()
    return GitHubAccessor(
        accessor.account,
        repo.owner,
        repo.name,
        "main",
        tree={},
        truncated=True,
    )


@pytest.mark.asyncio
async def test_a_truncated_tree_lists_each_folder_by_its_sha(repo):
    await repo.create({"top.txt": b"t", "docs/sub/b.txt": b"b"})
    await repo.truncate()
    accessor = _truncated(repo)
    root = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/gh", directory="/gh")
    )
    assert _names(root) == ["docs", "top.txt"]
    docs = await readdir(
        accessor,
        PathSpec(vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"),
        root.entries[0],
    )
    assert _names(docs) == ["sub"]
    assert await repo.count("recursive") == 0
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"
            ),
        )


@pytest.mark.asyncio
async def test_a_truncated_folder_is_no_miss_while_its_repository_is_lost(
    repo,
):
    # GitHub answers a repository the token can no longer read as it
    # answers a missing path; only a ref that still resolves makes a miss.
    await repo.create({"top.txt": b"t", "docs/sub/b.txt": b"b"})
    await repo.truncate()
    accessor = _truncated(repo)
    root = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/gh", directory="/gh")
    )
    docs = PathSpec(vfs_path="docs", virtual="/gh/docs", directory="/gh/docs")
    await repo.refuse("dir", 404, "Not Found")
    with pytest.raises(ApiError):
        await readdir(accessor, docs, root.entries[0])
    await repo.run.clear_answers()
    await repo.commit({"docs/sub/b.txt": None})
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, docs, root.entries[0])


@pytest.mark.asyncio
async def test_the_truncated_walk_refuses_a_directory_github_cut_short(repo):
    await repo.create({"top.txt": b"t", "big/a.txt": b"a", "big/b.txt": b"b"})
    await repo.truncate()
    await repo.cut_short("big", 1)
    accessor = _truncated(repo)
    root = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/gh", directory="/gh")
    )
    big = next(row for row in root.entries if row.name == "big")
    path = PathSpec(vfs_path="big", virtual="/gh/big", directory="/gh/big")
    with pytest.raises(GitHubApiError, match="truncated the tree listing"):
        await readdir(accessor, path, big)


@pytest.mark.asyncio
async def test_readdir_reports_a_folder_the_fresh_tree_dropped_as_missing(
    repo,
):
    await repo.create({"docs/a.txt": b"a", "top.txt": b"t"})
    accessor = repo.accessor()
    await repo.commit({"docs/a.txt": None})
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="docs", virtual="/gh/docs", directory="/gh/docs"
            ),
        )
