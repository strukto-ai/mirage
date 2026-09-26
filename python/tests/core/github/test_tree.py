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
from urllib.parse import unquote

import aiohttp
import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree import (ensure_live_index, ensure_tree,
                                     fetch_dir_page, fetch_dir_tree,
                                     fetch_tree, index_rows, point_row,
                                     refill_index)
from mirage.core.github.tree_entry import TreeEntry
from tests.fixtures.github_api import FakeGitHub, blob_sha, serve


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_parses_entries(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "src",
                "type": "tree",
                "sha": "aaa",
                "size": None
            },
            {
                "path": "src/main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 120
            },
        ],
    }
    tree, truncated = await fetch_tree(config, "acme", "proj", "main")
    assert "src" in tree
    assert "src/main.py" in tree
    assert tree["src"] == TreeEntry(path="src",
                                    type="tree",
                                    sha="aaa",
                                    size=None)
    assert tree["src/main.py"] == TreeEntry(path="src/main.py",
                                            type="blob",
                                            sha="bbb",
                                            size=120)


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ],
    }
    tree, _ = await fetch_tree(config, "acme", "proj", "main")
    assert "extern" not in tree
    assert list(tree) == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_dir_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ]
    }
    entries = await fetch_dir_tree(config, "acme", "proj", "sha1")
    assert [e.path for e in entries] == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_truncation_warning(mock_get, config, caplog):
    mock_get.return_value = {"truncated": True, "tree": []}
    with caplog.at_level(logging.WARNING):
        await fetch_tree(config, "acme", "proj", "main")
    assert "truncated" in caplog.text


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_passes_params(mock_get, config):
    mock_get.return_value = {"tree": []}
    await fetch_tree(config, "acme", "proj", "v1")
    mock_get.assert_awaited_once_with(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=None,
        session=None,
        owner="acme",
        repo="proj",
        ref="v1",
    )


def _tree_payload() -> dict:
    return {
        "truncated":
        False,
        "tree": [
            {
                "path": "data",
                "type": "tree",
                "sha": "t1",
                "size": None
            },
            {
                "path": "data/keep.txt",
                "type": "blob",
                "sha": "b1",
                "size": 4
            },
        ],
    }


def _accessor(config):
    tree = {
        "data":
        TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt":
        TreeEntry(path="data/keep.txt", type="blob", sha="b1", size=4),
    }
    return GitHubAccessor(config, "acme", "proj", "main", "main", tree=tree)


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_refetches_the_build_tree(mock_get, config):
    # The build tree is only true at build time: a mount's first read can
    # come long after it, so reusing it would key an index built from a
    # repository several external writes ago.
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    assert await ensure_live_index(accessor, index, "/gh") is True
    mock_get.assert_awaited_once()
    assert (await index.list_dir("/gh/data")).entries == ["/gh/data/keep.txt"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_refetches_a_dropped_listing(mock_get, config):
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    await ensure_live_index(accessor, index, "/gh")
    # What invalidation does: drop the row rather than expire it, which
    # is why the readers' EXPIRED probe never fires.
    await index.invalidate_dir("/gh")
    await index.invalidate_dir("/gh/data")
    assert await ensure_live_index(accessor, index, "/gh") is True
    assert mock_get.await_count == 2
    assert (await index.list_dir("/gh/data")).entries == ["/gh/data/keep.txt"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_leaves_a_live_index_alone(mock_get, config):
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    await ensure_live_index(accessor, index, "/gh")
    mock_get.reset_mock()
    assert await ensure_live_index(accessor, index, "/gh") is False
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_skips_a_truncated_tree(mock_get, config):
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    accessor.truncated = True
    assert await ensure_live_index(accessor, index, "/gh") is False
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_live_index_skips_the_null_index(config):
    assert await ensure_live_index(_accessor(config), NULL_INDEX, "") is False


def test_index_rows_key_by_mount_absolute_path():
    # Every other backend keys its index this way, which is what lets the
    # shared CacheManager spell an eviction without knowing the backend.
    tree = {
        "data":
        TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt":
        TreeEntry(path="data/keep.txt", type="blob", sha="b1", size=4),
    }
    entries, children = index_rows(tree, "/gh")
    assert sorted(entries) == ["/gh/data", "/gh/data/keep.txt"]
    assert sorted(children) == ["/gh", "/gh/data"]


def test_index_rows_root_mount_keeps_bare_paths():
    entries, children = index_rows(
        {"a.txt": TreeEntry(path="a.txt", type="blob", sha="b", size=1)}, "")
    assert sorted(entries) == ["/a.txt"]
    assert sorted(children) == ["/"]


def test_index_rows_gives_an_empty_repo_a_root_row():
    _entries, children = index_rows({}, "/gh")
    assert children == {"/gh": []}


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_an_unpinned_mount_reads_the_repos_default_branch(
        mock_tree_get, mock_repo_get, config):
    """An unresolved ref must be settled before the tree is fetched.

    ``accessor.ref`` is None until something resolves it, so reading it
    straight sends `ref=None` to the one request the whole mount is built
    on. This pins the resolution, not the config default -- the mount that
    supplies the default lives a layer up, in
    tests/vfs/github/test_lazy_hydration.py.
    """
    mock_repo_get.return_value = {"default_branch": "master"}
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(config, "acme", "proj")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "master"


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_a_pinned_mount_reads_its_ref_and_never_asks_for_the_branch(
        mock_tree_get, mock_repo_get, config):
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(config, "acme", "proj", "release-2")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "release-2"
    mock_repo_get.assert_not_awaited()


def _served_accessor(gh: FakeGitHub, ref: str = "main") -> GitHubAccessor:
    return GitHubAccessor(GitHubConfig(token="t", base_url=gh.url), "o", "r",
                          ref)


@pytest.mark.asyncio
async def test_a_refill_counts_itself():
    with serve(FakeGitHub(files={"a.txt": b"a"})) as gh:
        accessor = _served_accessor(gh)
        assert accessor.refills == 0
        await refill_index(accessor, RAMIndexCacheStore(), "/gh")
        await refill_index(accessor, RAMIndexCacheStore(), "/gh")
        assert accessor.refills == 2
        # No index means nothing was listed into one.
        await refill_index(accessor, NULL_INDEX, "/gh")
        assert accessor.refills == 2


@pytest.mark.asyncio
async def test_a_failed_refill_does_not_count():
    with serve(FakeGitHub(files={"a.txt": b"a"})) as gh:
        accessor = _served_accessor(gh)
        gh.fail["recursive"] = (500, "boom")
        with pytest.raises(aiohttp.ClientResponseError) as caught:
            await refill_index(accessor, RAMIndexCacheStore(), "/gh")
        assert caught.value.status == 500
        assert accessor.refills == 0


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
        ref, parent):
    data = b"payload"
    with serve(FakeGitHub(files={parent + "/f.txt": data}, ref=ref)) as gh:
        found = await point_row(_served_accessor(gh, ref), parent + "/f.txt")
        # The fake routes only a single segment; a raw "/" inside it is
        # never routed, so the row would be missing and the request unlogged.
        assert found is not None and found[0] is not None
        assert found[0].sha == blob_sha(data)
        (route, raw), = gh.log
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
async def test_a_directory_page_carries_truncation(mock_get, config):
    mock_get.return_value = {
        "truncated":
        True,
        "tree": [
            {
                "path": "a.py",
                "type": "blob",
                "sha": "a",
                "size": 1
            },
            {
                "path": "vendor",
                "type": "commit",
                "sha": "c"
            },
        ],
    }
    entries, truncated = await fetch_dir_page(config, "o", "r", "sha")
    assert truncated is True
    # A gitlink has no blob and no size; the page drops it like the tree.
    assert [e.path for e in entries] == ["a.py"]
    mock_get.return_value = {**mock_get.return_value, "truncated": False}
    assert await fetch_dir_tree(config, "o", "r", "sha") == entries


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_directory_page_without_a_tree_is_refused(mock_get, config):
    mock_get.return_value = {"message": "something else"}
    with pytest.raises(GitHubApiError, match="carries no tree"):
        await fetch_dir_page(config, "o", "r", "sha")


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_a_directory_tree_github_cut_short_is_refused(mock_get, config):
    # The fallback walk caches what it gets as the whole directory; a name
    # past GitHub's cut would read as absent, and a fresh probe as gone.
    mock_get.return_value = {
        "truncated": True,
        "tree": [{
            "path": "a.py",
            "type": "blob",
            "sha": "a",
            "size": 1
        }],
    }
    with pytest.raises(GitHubApiError, match="truncated the tree listing"):
        await fetch_dir_tree(config, "o", "r", "sha")


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
        assert await point_row(_served_accessor(gh, "deleted"),
                               "docs/a.txt") is None
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
        with patch("mirage.core.github.tree.github_get",
                   AsyncMock(return_value={})):
            with pytest.raises(GitHubApiError, match="carries no tree"):
                await point_row(accessor, "docs/a.txt")
