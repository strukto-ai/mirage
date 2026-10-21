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
from unittest.mock import AsyncMock, patch
from urllib.parse import quote, unquote

import aiohttp
import pytest

from mirage.accessor.github import GitHubAccessor, GitHubAccount
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import Evicted
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
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
from tests.fixtures.github_api import FakeGitHub, blob_sha, serve


@pytest.fixture
def account():
    return GitHubAccount(GhConfig(token="ghp_test"))


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
@patch("mirage.core.github.client.api_request")
async def test_tree_requests_encode_reference_once(mock_request, account, ref):
    mock_request.return_value = {"tree": [], "truncated": False}
    await fetch_tree(account, "o", "r", ref)
    await fetch_dir_page(account, "o", "r", ref)
    await fetch_dir_tree(account, "o", "r", ref)
    encoded = quote(ref, safe="")
    expected = f"https://api.github.com/repos/o/r/git/trees/{encoded}"
    assert [call.args[1] for call in mock_request.await_args_list] == [
        expected
    ] * 3
    assert mock_request.await_args_list[0].kwargs["params"] == {
        "recursive": "1"
    }
    assert mock_request.await_args_list[1].kwargs["params"] is None
    assert mock_request.await_args_list[2].kwargs["params"] is None


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_parses_entries(mock_get, account):
    mock_get.return_value = {
        "truncated": False,
        "tree": [
            {"path": "src", "type": "tree", "sha": "aaa", "size": None},
            {"path": "src/main.py", "type": "blob", "sha": "bbb", "size": 120},
        ],
    }
    tree, truncated, _ = await fetch_tree(account, "acme", "proj", "main")
    assert "src" in tree
    assert "src/main.py" in tree
    assert tree["src"] == TreeEntry(
        path="src", type="tree", sha="aaa", size=None
    )
    assert tree["src/main.py"] == TreeEntry(
        path="src/main.py", type="blob", sha="bbb", size=120
    )


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_excludes_submodule_gitlinks(mock_get, account):
    mock_get.return_value = {
        "truncated": False,
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc",
            },
            {"path": "main.py", "type": "blob", "sha": "bbb", "size": 7},
        ],
    }
    tree, _, _ = await fetch_tree(account, "acme", "proj", "main")
    assert "extern" not in tree
    assert list(tree) == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_dir_tree_excludes_submodule_gitlinks(mock_get, account):
    mock_get.return_value = {
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc",
            },
            {"path": "main.py", "type": "blob", "sha": "bbb", "size": 7},
        ]
    }
    entries = await fetch_dir_tree(account, "acme", "proj", "sha1")
    assert [e.path for e in entries] == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_truncation_warning(mock_get, account, caplog):
    mock_get.return_value = {"truncated": True, "tree": []}
    with caplog.at_level(logging.WARNING):
        await fetch_tree(account, "acme", "proj", "main")
    assert "truncated" in caplog.text


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_passes_params(mock_get, account):
    mock_get.return_value = {"tree": []}
    await fetch_tree(account, "acme", "proj", "v1")
    mock_get.assert_awaited_once_with(
        account,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        owner="acme",
        repo="proj",
        ref="v1",
    )


def _tree_payload() -> dict:
    return {
        "truncated": False,
        "tree": [
            {"path": "data", "type": "tree", "sha": "t1", "size": None},
            {"path": "data/keep.txt", "type": "blob", "sha": "b1", "size": 4},
        ],
    }


def _accessor(account):
    tree = {
        "data": TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt": TreeEntry(
            path="data/keep.txt", type="blob", sha="b1", size=4
        ),
    }
    return GitHubAccessor(account, "acme", "proj", "main", "main", tree=tree)


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_listing_refetches_the_build_tree(mock_get, account):
    # The build tree is only true at build time: a mount's first listing
    # can come long after it, so reusing it would answer a repository
    # several external writes ago.
    mock_get.return_value = _tree_payload()
    accessor = _accessor(account)
    listing = await readdir(accessor, _root("/gh"))
    mock_get.assert_awaited_once()
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
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_an_unpinned_mount_reads_the_repos_default_branch(
    mock_tree_get, mock_repo_get, account
):
    """An unresolved ref must be settled before the tree is fetched.

    ``accessor.ref`` is None until something resolves it, so reading it
    straight sends `ref=None` to the one request the whole mount is built
    on. This pins the resolution, not the config default -- the mount that
    supplies the default lives a layer up, in
    tests/vfs/github/test_lazy_hydration.py.
    """
    mock_repo_get.return_value = {"default_branch": "master"}
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(account, "acme", "proj")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "master"


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_a_pinned_mount_reads_its_ref_and_never_asks_for_the_branch(
    mock_tree_get, mock_repo_get, account
):
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(account, "acme", "proj", "release-2")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "release-2"
    mock_repo_get.assert_not_awaited()


# A drop while GitHub answered may be for the very write the tree predates:
# the caller gets the tree, and the accessor does not keep it.
@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_tree_answered_after_a_drop_reaches_its_caller_unkept(
    mock_tree_get, account
):
    accessor = GitHubAccessor(account, "acme", "proj", "main")

    async def answer(*args, **kwargs):
        accessor.forget()
        return {
            "truncated": False,
            "tree": [
                {"path": "a.txt", "type": "blob", "sha": "b1", "size": 1}
            ],
        }

    mock_tree_get.side_effect = answer
    fetched = await refresh_tree(accessor)
    assert fetched is not None and list(fetched[0]) == ["a.txt"]
    assert (accessor.tree, accessor.tree_loaded) == ({}, False)


def _served_accessor(gh: FakeGitHub, ref: str = "main") -> GitHubAccessor:
    return GitHubAccessor(
        GitHubAccount(GhConfig(token="t", base_url=gh.url)), "o", "r", ref
    )


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
    ref, parent
):
    data = b"payload"
    with serve(FakeGitHub(files={parent + "/f.txt": data}, ref=ref)) as gh:
        found = await point_row(_served_accessor(gh, ref), parent + "/f.txt")
        # The fake routes only a single segment; a raw "/" inside it is
        # never routed, so the row would be missing and the request unlogged.
        assert found is not None and found[0] is not None
        assert found[0].sha == blob_sha(data)
        ((route, raw),) = gh.log
        assert route == "dir"
        assert "/" not in raw
        assert unquote(raw) == f"{ref}:{parent}"


@pytest.mark.asyncio
async def test_a_root_child_asks_for_the_ref_itself():
    with serve(FakeGitHub(files={"a.txt": b"a"})) as gh:
        found = await point_row(_served_accessor(gh), "a.txt")
        assert found is not None and found[0] is not None
        assert gh.log == [("dir", "main")]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_directory_page_carries_truncation(mock_get, account):
    mock_get.return_value = {
        "truncated": True,
        "tree": [
            {"path": "a.py", "type": "blob", "sha": "a", "size": 1},
            {"path": "vendor", "type": "commit", "sha": "c"},
        ],
    }
    entries, truncated = await fetch_dir_page(account, "o", "r", "sha")
    assert truncated is True
    # A gitlink has no blob and no size; the page drops it like the tree.
    assert [e.path for e in entries] == ["a.py"]
    mock_get.return_value = {**mock_get.return_value, "truncated": False}
    assert await fetch_dir_tree(account, "o", "r", "sha") == entries


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_directory_page_without_a_tree_is_refused(mock_get, account):
    mock_get.return_value = {"message": "something else"}
    with pytest.raises(GitHubApiError, match="carries no tree"):
        await fetch_dir_page(account, "o", "r", "sha")


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_directory_tree_github_cut_short_is_refused(mock_get, account):
    # The fallback walk caches what it gets as the whole directory; a name
    # past GitHub's cut would read as absent, and a fresh probe as gone.
    mock_get.return_value = {
        "truncated": True,
        "tree": [{"path": "a.py", "type": "blob", "sha": "a", "size": 1}],
    }
    with pytest.raises(GitHubApiError, match="truncated the tree listing"):
        await fetch_dir_tree(account, "o", "r", "sha")


@pytest.mark.asyncio
async def test_the_point_answers():
    files = {"docs/a.txt": b"alpha", "docs/b.txt": b"bravo"}
    with serve(FakeGitHub(files=dict(files))) as gh:
        accessor = _served_accessor(gh)
        row, truncated = await point_row(accessor, "docs/a.txt")
        assert (row.sha, truncated) == (blob_sha(b"alpha"), False)
        assert await point_row(accessor, "docs/nope.txt") == (None, False)
        gh.truncated_dirs["docs"] = 1
        assert await point_row(accessor, "docs/b.txt") == (None, True)
        gh.truncated_dirs.clear()
        # A missing directory, a deleted ref and a path through a file all
        # defer to the tree rather than answering absent.
        assert await point_row(accessor, "gone/a.txt") is None
        assert await point_row(accessor, "docs/a.txt/x") is None
        assert (
            await point_row(_served_accessor(gh, "deleted"), "docs/a.txt")
            is None
        )
        for status in (401, 403, 409, 429, 500):
            gh.fail["dir"] = (status, "refused")
            with pytest.raises(aiohttp.ClientResponseError) as caught:
                await point_row(accessor, "docs/a.txt")
            assert caught.value.status == status
        gh.fail["dir"] = (404, "Not Found")
        assert await point_row(accessor, "docs/a.txt") is None


@pytest.mark.asyncio
async def test_a_malformed_point_answer_is_refused():
    with serve(FakeGitHub(files={"docs/a.txt": b"a"})) as gh:
        accessor = _served_accessor(gh)
        with patch(
            "mirage.core.github.tree.github_get", AsyncMock(return_value={})
        ):
            with pytest.raises(GitHubApiError, match="carries no tree"):
                await point_row(accessor, "docs/a.txt")


def _root(prefix: str) -> PathSpec:
    return PathSpec(virtual=prefix, directory=prefix, vfs_path="")


def _ledgered(store: RAMIndexCacheStore) -> tuple[list[Evicted], IndexView]:
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
async def test_a_relisting_reports_what_left_the_repository(removed, reported):
    # The seeds replace each folder's listing, so without the diff a file
    # removed upstream keeps its cached bytes and overlay.
    files = {"d1/a.txt": b"a", "d1/b.txt": b"b", "top.txt": b"t"}
    with serve(FakeGitHub(files=dict(files))) as gh:
        accessor = _served_accessor(gh)
        gone, index = _ledgered(RAMIndexCacheStore())
        await _relist(accessor, index)
        assert gone == []
        for path in removed:
            del gh.files[path]
        await _relist(accessor, index)
        assert gone == reported


@pytest.mark.asyncio
@pytest.mark.parametrize("truncated,drop_sha", [(True, False), (False, True)])
async def test_a_listing_with_no_whole_head_names_no_version(
    truncated, drop_sha
):
    files = {"d1/a.txt": b"a", "top.txt": b"t"}
    with serve(
        FakeGitHub(
            files=dict(files), truncated_recursive=truncated, drop_sha=drop_sha
        )
    ) as gh:
        accessor = _served_accessor(gh)
        listing = await readdir(accessor, _root("/gh"))
        assert listing.version is None
