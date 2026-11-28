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

import logging
from urllib.parse import unquote

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import Evicted
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.api.errors import ApiError
from mirage.core.github.client import GitHubApiError
from mirage.core.github.readdir import readdir
from mirage.core.github.tree import (
    ensure_tree,
    fetch_dir_page,
    fetch_dir_tree,
    fetch_tree,
    point_row,
    refresh_tree,
    tree_rows,
)
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec
from mirage.workspace.mount.listing import keep_listing
from tests.core.github.conftest import TREES, GitHubRepo, blob_sha

# A commit no tree holds, for a submodule to pin.
PINNED = "c" * 40


async def _folder_sha(repo: GitHubRepo, folder: str) -> str:
    return (await repo.tree(f"main:{folder}"))["sha"]


# Each request carries the ref quoted once, as one segment: GitHub reads it
# back as written, and only the recursive tree asks with a query.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ref",
    [
        "feature/topic",
        "release#1",
        "literal%2Fref",
        "feature/topic:docs/nested",
    ],
)
async def test_tree_requests_encode_reference_once(repo, ref):
    await repo.create({"a.txt": b"a"})
    account = repo.accessor().account
    for fetch in (fetch_tree, fetch_dir_page, fetch_dir_tree):
        with pytest.raises(ApiError):
            await fetch(account, repo.owner, repo.name, ref)
    listed = await repo.run.call("GET", "/_kit/requests")
    sent = []
    for r in listed["requests"]:
        # A slash sent unencoded would arrive as a slash of the path.
        raw = r["path"].split("/git/trees/", 1)[1]
        assert "/" not in raw, raw
        sent.append((unquote(raw), r["query"]))
    assert sent == [(ref, "recursive=1"), (ref, ""), (ref, "")]


@pytest.mark.asyncio
async def test_fetch_tree_parses_entries(repo):
    await repo.create({"src/main.py": b"m" * 120})
    tree, truncated, _ = await fetch_tree(
        repo.accessor().account, repo.owner, repo.name, "main"
    )
    assert truncated is False
    assert set(tree) == {"src", "src/main.py"}
    assert tree["src"] == TreeEntry(
        path="src", type="tree", sha=await _folder_sha(repo, "src"), size=None
    )
    assert tree["src/main.py"] == TreeEntry(
        path="src/main.py", type="blob", sha=blob_sha(b"m" * 120), size=120
    )


@pytest.mark.asyncio
async def test_fetch_tree_excludes_submodule_gitlinks(repo):
    await repo.create({"main.py": b"x = 1\n"})
    await repo.link("extern", PINNED)
    assert "extern" in [
        row["path"] for row in (await repo.tree("main", True))["tree"]
    ]
    tree, _, _ = await fetch_tree(
        repo.accessor().account, repo.owner, repo.name, "main"
    )
    assert list(tree) == ["main.py"]


@pytest.mark.asyncio
async def test_fetch_dir_tree_excludes_submodule_gitlinks(repo):
    await repo.create({"pkg/main.py": b"x = 1\n"})
    await repo.link("pkg/extern", PINNED)
    entries = await fetch_dir_tree(
        repo.accessor().account,
        repo.owner,
        repo.name,
        await _folder_sha(repo, "pkg"),
    )
    assert [e.path for e in entries] == ["main.py"]


@pytest.mark.asyncio
async def test_fetch_tree_truncation_warning(repo, caplog):
    await repo.create({"a/b.txt": b"b"})
    await repo.truncate()
    with caplog.at_level(logging.WARNING):
        await fetch_tree(
            repo.accessor().account, repo.owner, repo.name, "main"
        )
    assert "truncated" in caplog.text


@pytest.mark.asyncio
async def test_fetch_tree_asks_the_recursive_tree_of_its_ref(repo):
    await repo.create({"a.txt": b"a"})
    await repo.branch("v1")
    await fetch_tree(repo.accessor().account, repo.owner, repo.name, "v1")
    assert await repo.log() == [("recursive", "v1")]


@pytest.mark.asyncio
async def test_a_listing_refetches_the_build_tree(repo):
    # The build tree is only true at build time: a mount's first listing
    # can come long after it, so reusing it would answer a repository
    # several external writes ago.
    await repo.create({"data/keep.txt": b"keep"})
    built = {
        "data": TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/old.txt": TreeEntry(
            path="data/old.txt", type="blob", sha="b1", size=4
        ),
    }
    accessor = GitHubAccessor(
        repo.accessor().account,
        repo.owner,
        repo.name,
        "main",
        "main",
        tree=built,
    )
    listing = await readdir(accessor, _root("/gh"))
    assert await repo.count("recursive") == 1
    assert [row.name for row in listing.seeds["data"]] == ["keep.txt"]
    assert accessor.tree_loaded


def test_tree_rows_key_each_folder_by_its_repo_path():
    tree = {
        "data": TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt": TreeEntry(
            path="data/keep.txt", type="blob", sha="b1", size=4
        ),
    }
    rows = tree_rows(tree)
    assert {
        folder: [r.name for r in found] for folder, found in rows.items()
    } == {
        "": ["data"],
        "data": ["keep.txt"],
    }
    assert rows["data"][0].extra == {"sha": "b1"}


def test_tree_rows_give_an_empty_repo_a_root_listing():
    assert tree_rows({}) == {"": []}


@pytest.mark.asyncio
async def test_an_unpinned_mount_reads_the_repos_default_branch(repo):
    """An unresolved ref must be settled before the tree is fetched.

    ``accessor.ref`` is None until something resolves it, so reading it
    straight sends `ref=None` to the one request the whole mount is built
    on. This pins the resolution, not the config default -- the mount that
    supplies the default lives a layer up, in
    tests/vfs/github/test_lazy_hydration.py.
    """
    await repo.create({"a.txt": b"a"})
    await repo.branch("master")
    await repo.set_default_branch("master")
    accessor = GitHubAccessor(repo.accessor().account, repo.owner, repo.name)
    await ensure_tree(accessor)
    assert await repo.log() == [("repo", ""), ("recursive", "master")]


@pytest.mark.asyncio
async def test_a_pinned_mount_reads_its_ref_and_never_asks_for_the_branch(
    repo,
):
    await repo.create({"a.txt": b"a"})
    await repo.branch("release-2")
    await ensure_tree(repo.accessor("release-2"))
    assert await repo.log() == [("recursive", "release-2")]


# A drop while GitHub answered may be for the very write the tree predates:
# the caller gets the tree, and the accessor does not keep it.
@pytest.mark.asyncio
async def test_a_tree_answered_after_a_drop_reaches_its_caller_unkept(repo):
    await repo.create({"a.txt": b"a"})
    accessor = repo.accessor()
    await repo.run.before_next([("GET", TREES)], accessor.forget)
    fetched = await refresh_tree(accessor)
    assert fetched is not None and list(fetched[0]) == ["a.txt"]
    assert (accessor.tree, accessor.tree_loaded) == ({}, False)


# The same rows as tree.test.ts: a parent Octokit would rewrite unencoded
# (two or more lowercase letters), its uppercase control, a nested parent a
# raw slash would split, characters that truncate or template a URL, and a
# ref with a slash in it.
ENCODED = [
    ("main", "src"),
    ("main", "Src"),
    ("main", "docs/sub"),
    ("main", "a b"),
    ("main", "a#b"),
    ("main", "a?b"),
    ("main", "a%b"),
    ("main", "ü"),
    ("main", "x:y"),
    ("main", "a{b}"),
    ("release/1.80", "docs/sub"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("ref,parent", ENCODED)
async def test_a_point_request_sends_ref_and_parent_as_one_segment(
    repo, ref, parent
):
    data = b"payload"
    await repo.create({parent + "/f.txt": data})
    if ref != "main":
        await repo.branch(ref)
    found = await point_row(repo.accessor(ref), parent + "/f.txt")
    assert found is not None and found[0] is not None
    assert found[0].sha == blob_sha(data)
    # A raw "/" inside the segment would arrive as a slash of the path.
    ((route, raw),) = await repo.log()
    assert route == "dir"
    assert "/" not in raw
    assert unquote(raw) == f"{ref}:{parent}"


@pytest.mark.asyncio
async def test_a_root_child_asks_for_the_ref_itself(repo):
    await repo.create({"a.txt": b"a"})
    found = await point_row(repo.accessor(), "a.txt")
    assert found is not None and found[0] is not None
    assert await repo.log() == [("dir", "main")]


@pytest.mark.asyncio
async def test_a_directory_page_carries_truncation(repo):
    await repo.create({"pkg/a.py": b"a"})
    await repo.link("pkg/vendor", PINNED)
    await repo.cut_short("pkg", 2)
    account = repo.accessor().account
    pkg = await _folder_sha(repo, "pkg")
    entries, truncated = await fetch_dir_page(
        account, repo.owner, repo.name, pkg
    )
    assert truncated is True
    # A gitlink has no blob and no size; the page drops it like the tree.
    assert [e.path for e in entries] == ["a.py"]
    await repo.run.clear_answers()
    assert await fetch_dir_tree(account, repo.owner, repo.name, pkg) == entries


@pytest.mark.asyncio
async def test_a_directory_page_without_a_tree_is_refused(repo):
    await repo.create({"pkg/a.py": b"a"})
    await repo.answer("dir", {"message": "something else"})
    with pytest.raises(GitHubApiError, match="carries no tree"):
        await fetch_dir_page(
            repo.accessor().account,
            repo.owner,
            repo.name,
            await _folder_sha(repo, "pkg"),
        )


@pytest.mark.asyncio
async def test_a_directory_tree_github_cut_short_is_refused(repo):
    # The fallback walk caches what it gets as the whole directory; a name
    # past GitHub's cut would read as absent, and a fresh probe as gone.
    await repo.create({"pkg/a.py": b"a", "pkg/b.py": b"b"})
    await repo.cut_short("pkg", 1)
    with pytest.raises(GitHubApiError, match="truncated the tree listing"):
        await fetch_dir_tree(
            repo.accessor().account,
            repo.owner,
            repo.name,
            await _folder_sha(repo, "pkg"),
        )


@pytest.mark.asyncio
async def test_the_point_answers(repo):
    await repo.create({"docs/a.txt": b"alpha", "docs/b.txt": b"bravo"})
    accessor = repo.accessor()
    row, truncated = await point_row(accessor, "docs/a.txt")
    assert (row.sha, truncated) == (blob_sha(b"alpha"), False)
    assert await point_row(accessor, "docs/nope.txt") == (None, False)
    await repo.cut_short("docs", 1)
    assert await point_row(accessor, "docs/b.txt") == (None, True)
    await repo.run.clear_answers()
    # A missing directory, a deleted ref and a path through a file all
    # defer to the tree rather than answering absent.
    assert await point_row(accessor, "gone/a.txt") is None
    assert await point_row(accessor, "docs/a.txt/x") is None
    assert await point_row(repo.accessor("deleted"), "docs/a.txt") is None
    for status in (401, 403, 409, 429, 500):
        await repo.refuse("dir", status, "refused")
        with pytest.raises(ApiError) as caught:
            await point_row(accessor, "docs/a.txt")
        assert caught.value.status == status
        await repo.run.clear_answers()
    await repo.refuse("dir", 404, "Not Found")
    assert await point_row(accessor, "docs/a.txt") is None


@pytest.mark.asyncio
async def test_a_malformed_point_answer_is_refused(repo):
    await repo.create({"docs/a.txt": b"a"})
    await repo.answer("dir", {})
    with pytest.raises(GitHubApiError, match="carries no tree"):
        await point_row(repo.accessor(), "docs/a.txt")


def _root(prefix: str) -> PathSpec:
    return PathSpec(virtual=prefix, directory=prefix, vfs_path="")


def _recording(store: RAMIndexCacheStore) -> tuple[list[Evicted], IndexView]:
    gone: list[Evicted] = []

    async def on_gone(children: list[Evicted]) -> None:
        gone.extend(children)

    return gone, IndexView(
        store, RAMFileCacheStore(), "/gh", lambda _key: True, on_gone=on_gone
    )


async def _relist(accessor: GitHubAccessor, index: IndexView) -> None:
    await keep_listing(index, "/gh", await readdir(accessor, _root("/gh")))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "removed, reported",
    [
        (["d1/a.txt"], [Evicted("/gh/d1/a.txt", folder=False)]),
        (["d1/a.txt", "d1/b.txt"], [Evicted("/gh/d1", folder=True)]),
    ],
)
async def test_a_relisting_reports_what_left_the_repository(
    repo, removed, reported
):
    # The seeds replace each folder's listing, so without the diff a file
    # removed upstream keeps its cached bytes and overlay.
    await repo.create({"d1/a.txt": b"a", "d1/b.txt": b"b", "top.txt": b"t"})
    accessor = repo.accessor()
    gone, index = _recording(RAMIndexCacheStore())
    await _relist(accessor, index)
    assert gone == []
    await repo.commit(dict.fromkeys(removed))
    await _relist(accessor, index)
    assert gone == reported


# A tree that is truncated, or that names no top-level sha, is no whole
# answer at one head. The second is GitHub's tree with its sha left out.
@pytest.mark.asyncio
@pytest.mark.parametrize("truncated", [True, False])
async def test_a_listing_with_no_whole_head_names_no_version(repo, truncated):
    await repo.create({"d1/a.txt": b"a", "top.txt": b"t"})
    if truncated:
        await repo.truncate()
    else:
        whole = await repo.tree("main", recursive=True)
        await repo.answer(
            "recursive", {k: v for k, v in whole.items() if k != "sha"}
        )
    listing = await readdir(repo.accessor(), _root("/gh"))
    assert listing.version is None


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [{}, {"tree": None}, {"tree": {}}])
async def test_recursive_tree_requires_a_listing(repo, reply):
    await repo.create({"a.txt": b"a"})
    await repo.answer("recursive", reply)
    with pytest.raises(GitHubApiError, match="carries no tree"):
        await fetch_tree(
            repo.accessor().account, repo.owner, repo.name, "main"
        )
