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

from unittest.mock import patch

import pytest

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import Evicted
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.readdir import readdir
from mirage.core.hf_hub.tree import (
    collect,
    deletions_for,
    fetch_path,
    fetch_tree,
    filter_repo_paths,
    next_cursor,
    parse_entry,
    paths_info_url,
    row_of,
    tree_rows,
    tree_url,
)
from mirage.types import FileType, PathSpec
from mirage.vfs.hf_buckets.config import HfRepoConfig
from mirage.workspace.mount.listing import keep_listing
from tests.core.hf_hub.conftest import FakeAccessor, dir_row, file_row, page


def test_parse_entry_keeps_the_lfs_content_size_not_the_pointer():
    """The pointer size is the trap this backend must never report.

    An LFS row carries both: `size` is the real content length and
    `lfs.pointerSize` is the 135-byte stub git actually stores. Reporting
    the stub makes wc -c and ls -l lie and risks a truncated copy.
    """
    entry = parse_entry(
        {
            "type": "file",
            "oid": "abc",
            "size": 4798702184,
            "path": "model.safetensors",
            "lfs": {
                "oid": "sha256hex",
                "size": 4798702184,
                "pointerSize": 135,
            },
            "xetHash": "xethash",
        }
    )
    assert entry.size == 4798702184
    assert entry.lfs_oid == "sha256hex"
    assert entry.xet_hash == "xethash"


def test_parse_entry_reads_the_last_commit_when_expanded():
    entry = parse_entry(
        {
            "type": "file",
            "oid": "abc",
            "size": 1,
            "path": "f",
            "lastCommit": {
                "id": "c1",
                "title": "t",
                "date": "2025-01-01T00:00:00.000Z",
            },
        }
    )
    assert entry.last_modified == "2025-01-01T00:00:00.000Z"
    assert entry.last_commit == "c1"


def test_parse_entry_leaves_mtime_empty_without_expansion():
    entry = parse_entry(file_row("f"))
    assert entry.last_modified == ""


def test_next_cursor_reads_the_link_header():
    assert (
        next_cursor({"link": '<https://h/next>; rel="next"'})
        == "https://h/next"
    )


def test_next_cursor_is_empty_on_the_last_page():
    assert next_cursor({}) == ""
    assert next_cursor({"link": '<https://h/prev>; rel="prev"'}) == ""


def test_tree_url_appends_the_key_prefix(accessor, prefixed):
    """The prefix is normalized with a trailing slash, and the tree
    endpoint reads a trailing slash as another path segment."""
    assert tree_url(accessor).endswith("/api/models/acme/widget/tree/main")
    assert prefixed.key_prefix == "sub/dir/"
    assert tree_url(prefixed).endswith("/tree/main/sub/dir")


def test_collect_strips_the_key_prefix():
    into = {}
    collect([file_row("sub/dir/a.txt")], "sub/dir/", into)
    assert list(into) == ["a.txt"]


def test_collect_drops_the_row_naming_the_prefix_itself():
    """A prefix mount's own directory is not a child of anything."""
    into = {}
    collect([dir_row("sub/dir"), file_row("sub/dir/a.txt")], "sub/dir/", into)
    assert list(into) == ["a.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_keeps_one_expanded_page(mock_get, accessor):
    """A repo that fits one expanded page gets mtimes for the same cost."""
    mock_get.return_value = page(
        [
            {
                **file_row("a.txt"),
                "lastCommit": {"id": "c", "date": "2025-01-01T00:00:00.000Z"},
            },
        ]
    )
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 1
    assert mock_get.await_args.args[2]["expand"] == "true"
    assert tree["a.txt"].last_modified == "2025-01-01T00:00:00.000Z"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_falls_back_to_a_bare_walk_when_it_does_not_fit(
    mock_get, accessor
):
    """Expansion drops the page from 1000 rows to 50, so a repo too big
    for one expanded page re-walks bare rather than paying twenty times
    the requests for mtimes."""
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        page([file_row("a.txt"), file_row("b.txt")]),
    ]
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 2
    assert mock_get.await_args_list[1].args[2]["expand"] == "false"
    assert sorted(tree) == ["a.txt", "b.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_forced_expansion_pages_through(mock_get, accessor):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": True}
    )
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        page([file_row("b.txt")]),
    ]
    tree = await fetch_tree(accessor)
    assert mock_get.await_count == 2
    # The second call follows the cursor and sends no params of its own.
    assert mock_get.await_args_list[1].args[1] == "https://h/p2"
    assert mock_get.await_args_list[1].args[2] is None
    assert sorted(tree) == ["a.txt", "b.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_forced_bare_never_expands(mock_get, accessor):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": False}
    )
    mock_get.return_value = page([file_row("a.txt")])
    await fetch_tree(accessor)
    assert mock_get.await_count == 1
    assert mock_get.await_args.args[2]["expand"] == "false"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_reads_a_missing_subtree_as_empty(mock_get, accessor):
    # A key_prefix that names no folder: the Hub answers 404 EntryNotFound,
    # and there really is nothing under it (measured against huggingface.co,
    # 2026-09-24).
    mock_get.side_effect = HfHubError("nope", 404, "EntryNotFound")
    assert await fetch_tree(accessor) == {}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
@pytest.mark.parametrize(
    "status,code",
    [
        (401, ""),
        (403, ""),
        (404, "RevisionNotFound"),
        (404, "RepoNotFound"),
    ],
)
async def test_fetch_tree_raises_for_a_repo_it_cannot_see(
    mock_get, accessor, status, code
):
    # The tree is seeded as the whole index, so an empty one for a repo the
    # token cannot see would read every file as deleted; an error does not.
    mock_get.side_effect = HfHubError("nope", status, code)
    with pytest.raises(HfHubError):
        await fetch_tree(accessor)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_raises_for_a_missing_subtree_on_a_later_page(
    mock_get, accessor
):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": False}
    )
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        HfHubError("gone", 404, "EntryNotFound"),
    ]
    # Folding here would keep page one as if it were the whole listing.
    with pytest.raises(HfHubError):
        await fetch_tree(accessor)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_raises_for_a_missing_subtree_on_the_continuation(
    mock_get, accessor
):
    # The expanded walk continues in a second walk_pages call, whose first
    # request is already a cursor page; "first page" is the request that
    # carries the first page's params, not the first turn of a loop.
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": True}
    )
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        HfHubError("gone", 404, "EntryNotFound"),
    ]
    with pytest.raises(HfHubError):
        await fetch_tree(accessor)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_folds_a_missing_subtree_on_the_bare_restart(
    mock_get, accessor
):
    mock_get.side_effect = [
        page([file_row("a.txt")], next_url="https://h/p2"),
        HfHubError("gone", 404, "EntryNotFound"),
    ]
    # The bare walk restarts from the first page with fresh params and an
    # empty result, so a subtree gone by then is truthfully empty.
    assert await fetch_tree(accessor) == {}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_reraises_a_real_failure(mock_get, accessor):
    mock_get.side_effect = HfHubError("boom", 500)
    with pytest.raises(HfHubError):
        await fetch_tree(accessor)


def test_tree_rows_give_the_root_a_listing_for_an_empty_repo():
    """Without it an empty repository lists as missing."""
    assert tree_rows({}) == {"": []}


def test_tree_rows_imply_a_parent_a_page_boundary_split_off():
    """A cursor can deliver a child before its own directory row.

    The implied folder gets a row of its own and a place in its parent's
    listing, so every folder lists and every listed name has a row.
    """
    rows = tree_rows({"d/e/a.txt": parse_entry(file_row("d/e/a.txt"))})
    assert {k: [r.name for r in v] for k, v in rows.items()} == {
        "": ["d"],
        "d": ["e"],
        "d/e": ["a.txt"],
    }
    assert rows[""][0].type is FileType.DIRECTORY


def test_a_folder_row_replaces_the_one_its_child_implied():
    rows = tree_rows(
        {
            "d/b.txt": parse_entry(file_row("d/b.txt")),
            "d": parse_entry(
                dir_row("d") | {"lastCommit": {"date": "2025-01-01"}}
            ),
        }
    )
    assert [(r.name, r.modified) for r in rows[""]] == [("d", "2025-01-01")]


def test_row_of_leaves_a_directory_size_unset():
    row = row_of(parse_entry(dir_row("d")), "d")
    assert (row.type, row.size) == (FileType.DIRECTORY, None)


def test_row_of_leaves_mtime_unset_when_the_row_has_none():
    """A Hub file's only mtime is its last commit, and a bare listing
    carries none. None is the honest answer; a repo-wide timestamp
    stamped on every file would be a confident lie."""
    assert row_of(parse_entry(file_row("f")), "f").modified is None


def test_row_of_reports_an_expanded_mtime():
    entry = parse_entry(
        file_row("f", lastCommit={"date": "2025-01-01T00:00:00.000Z"})
    )
    assert row_of(entry, "f").modified == "2025-01-01T00:00:00.000Z"


def test_row_of_an_empty_id_carries_no_token():
    entry = parse_entry({"type": "file", "oid": "", "path": "a.txt"})
    assert row_of(entry, "a.txt").fingerprint is None


def test_row_of_keeps_the_ids_a_read_stamps_by():
    row = row_of(parse_entry(file_row("a.txt", lfs={"oid": "L"})), "a.txt")
    assert (row.fingerprint, row.extra["lfs_oid"]) == ("oid-a.txt", "L")


def test_tree_url_encodes_a_revision_holding_a_slash():
    """A git ref may hold a slash, and the Hub reads the segment after
    /tree as the whole revision: unencoded, `feature/foo` names revision
    `feature` and subtree `foo`, so the mount reads the wrong place."""
    acc = FakeAccessor(
        HfRepoConfig(repo_id="acme/widget", revision="feature/foo")
    )
    assert tree_url(acc).endswith("/tree/feature%2Ffoo")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_get_response")
async def test_fetch_tree_refuses_a_listing_it_could_not_finish(
    mock_get, accessor
):
    """The listing is seeded as the mount's whole index, so a partial one
    reads as complete and every file past the ceiling becomes a confident
    false absence."""
    mock_get.return_value = page(
        [file_row("a.txt")], next_url="https://h/next"
    )
    with pytest.raises(HfHubError, match="listing exceeds"):
        await fetch_tree(accessor)


class _DatasetAccessor(FakeAccessor):
    REPO_TYPE = "dataset"
    VFS_NAME = "hf_datasets"


class _SpaceAccessor(FakeAccessor):
    REPO_TYPE = "space"
    VFS_NAME = "hf_spaces"


@pytest.mark.parametrize(
    "cls,segment",
    [
        (FakeAccessor, "models"),
        (_DatasetAccessor, "datasets"),
        (_SpaceAccessor, "spaces"),
    ],
)
def test_paths_info_url_names_the_repo_type(cls, segment):
    accessor = cls(HfRepoConfig(repo_id="acme/widget"))
    assert paths_info_url(accessor) == (
        f"https://huggingface.co/api/{segment}/acme/widget/paths-info/main"
    )


def test_paths_info_url_encodes_a_revision_and_carries_no_prefix():
    accessor = FakeAccessor(
        HfRepoConfig(
            repo_id="acme/widget", revision="refs/pr/1", key_prefix="sub/dir"
        )
    )
    # The prefix belongs in the requested path, not the route: the route's
    # trailing segment is the whole revision.
    assert paths_info_url(accessor) == (
        "https://huggingface.co/api/models/"
        "acme/widget/paths-info/refs%2Fpr%2F1"
    )


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_post")
async def test_fetch_path_asks_for_the_prefixed_path(mock_post, prefixed):
    decoy = {**file_row("a.txt"), "oid": "decoy"}
    real = {**file_row("sub/dir/a.txt"), "oid": "real"}
    mock_post.return_value = [decoy, real]
    found = await fetch_path(prefixed, "a.txt")
    assert mock_post.await_args.args[2]["paths"] == ["sub/dir/a.txt"]
    assert list(found) == ["a.txt"]
    assert found["a.txt"].oid == "real"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_post")
@pytest.mark.parametrize(
    "expand,sent", [(True, True), (None, False), (False, False)]
)
async def test_fetch_path_expands_only_when_asked(
    mock_post, accessor, expand, sent
):
    accessor.config = accessor.config.model_copy(
        update={"expand_commits": expand}
    )
    mock_post.return_value = []
    await fetch_path(accessor, "a.txt")
    assert mock_post.await_args.args[2]["expand"] is sent


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_post")
async def test_fetch_path_refuses_an_answer_that_is_not_a_list(
    mock_post, accessor
):
    # Only an empty list says the path is missing; any other shape is an
    # answer the client cannot read, and must not become absence.
    mock_post.return_value = {"error": "unexpected"}
    with pytest.raises(HfHubError):
        await fetch_path(accessor, "a.txt")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.tree.hub_post")
async def test_fetch_path_reads_an_empty_list_as_absence(mock_post, accessor):
    mock_post.return_value = []
    assert await fetch_path(accessor, "a.txt") == {}


def _tree(*rows):
    return {row["path"]: parse_entry(row) for row in rows}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "after, reported",
    [
        (
            _tree(file_row("d/b.txt"), dir_row("d")),
            [Evicted("/m/a.txt", folder=False)],
        ),
        (_tree(file_row("a.txt")), [Evicted("/m/d", folder=True)]),
    ],
)
async def test_a_relisting_reports_what_left_the_repository(
    accessor, tree, after, reported
):
    # The seeds replace each folder's listing, so without the diff a file
    # removed upstream keeps its cached bytes and overlay.
    gone: list[Evicted] = []

    async def on_gone(children: list[Evicted]) -> None:
        gone.extend(children)

    index = IndexView(
        RAMIndexCacheStore(),
        RAMFileCacheStore(),
        "/m",
        lambda _key: True,
        on_gone=on_gone,
    )
    root = PathSpec(virtual="/m", directory="/m", vfs_path="")
    tree.return_value = _tree(
        file_row("a.txt"), file_row("d/b.txt"), dir_row("d")
    )
    await keep_listing(index, "/m", await readdir(accessor, root))
    assert gone == []
    tree.return_value = after
    await keep_listing(index, "/m", await readdir(accessor, root))
    assert gone == reported


HEAD = "c" * 40


def test_tree_url_takes_the_revision_it_is_given(accessor, prefixed):
    assert tree_url(accessor, HEAD).endswith(f"/tree/{HEAD}")
    assert tree_url(accessor).endswith("/tree/main")
    assert tree_url(prefixed, HEAD).endswith(f"/tree/{HEAD}/sub/dir")


TREE_FILES = [
    ".gitattributes",
    "a.txt",
    "data/b.json",
    "data/sub/c.json",
    "sub/d.bin",
]


@pytest.mark.parametrize(
    "include,exclude,kept",
    [
        (["*.txt"], [], ["a.txt"]),
        (["data/*.json"], [], ["data/b.json", "data/sub/c.json"]),
        (["data/"], [], ["data/b.json", "data/sub/c.json"]),
        (["**"], ["*.json"], [".gitattributes", "a.txt", "sub/d.bin"]),
        (
            [],
            ["sub/"],
            [".gitattributes", "a.txt", "data/b.json", "data/sub/c.json"],
        ),
    ],
)
def test_filter_repo_paths_is_upstreams_glob_rule(include, exclude, kept):
    assert filter_repo_paths(TREE_FILES, include, exclude) == kept


@pytest.mark.parametrize(
    "patterns,base,doomed",
    [
        (["**"], "", ["a.txt", "data/b.json", "data/sub/c.json", "sub/d.bin"]),
        (["*.json"], "", ["data/b.json", "data/sub/c.json"]),
        (["sub/"], "", ["sub/d.bin"]),
        (["*.json"], "data", ["data/b.json", "data/sub/c.json"]),
        (["sub/*"], "data", ["data/sub/c.json"]),
        (["nothing*"], "", []),
        ([], "", []),
    ],
)
def test_deletions_for_matches_the_listing(patterns, base, doomed):
    assert deletions_for(TREE_FILES, patterns, base) == doomed
