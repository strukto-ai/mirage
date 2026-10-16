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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.ram import ListingCheckStore
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.readdir import readdir
from mirage.core.hf_hub.stat import stat, tree
from mirage.core.hf_hub.tree import parse_entry
from mirage.types import FileStat, FileType, PathSpec
from tests.core.hf_hub.conftest import dir_row, file_row, page, ps, seed
from tests.fixtures.handed import entry_at


async def _stat_at(accessor, path: PathSpec) -> FileStat:
    return await stat(accessor, path, await entry_at(readdir, accessor, path))


@pytest.mark.asyncio
async def test_stat_of_the_mount_root_is_a_directory(accessor):
    result = await stat(accessor, ps(""))
    assert result.type is FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_reports_size_and_the_oid_as_fingerprint(loaded):
    result = await _stat_at(loaded, ps("a.txt"))
    assert result.size == 7
    assert result.type is FileType.FILE
    assert result.fingerprint == "oid-a.txt"


@pytest.mark.asyncio
async def test_stat_of_a_directory_with_no_row_of_its_own(accessor, tree):
    seed(tree, file_row("d/b.txt"))
    result = await _stat_at(accessor, ps("d"))
    assert result.type is FileType.DIRECTORY
    assert result.name == "d"


@pytest.mark.asyncio
async def test_stat_of_a_missing_path_is_enoent(loaded):
    with pytest.raises(FileNotFoundError):
        await _stat_at(loaded, ps("nope"))


@pytest.mark.asyncio
async def test_stat_reports_the_lfs_object_size(accessor, tree):
    """The 135-byte pointer is what git stores; the content size is what
    every reader needs, and reporting the pointer risks a short copy."""
    seed(
        tree,
        file_row(
            "w.bin",
            4798702184,
            lfs={"oid": "sha", "size": 4798702184, "pointerSize": 135},
        ),
    )
    result = await _stat_at(accessor, ps("w.bin"))
    assert result.size == 4798702184
    assert result.extra["lfs_oid"] == "sha"


# An LFS row whose git oid, LFS sha and xet hash all differ: the stat's
# token has to be the oid, the same kind a tree row carries.
LFS_ROW = {
    "type": "file",
    "oid": "O",
    "size": 7,
    "path": "a.txt",
    "lfs": {"oid": "L"},
    "xetHash": "X",
}


def _point(rows):
    return patch(
        "mirage.core.hf_hub.tree.hub_post", AsyncMock(return_value=rows)
    )


def _walk(*rows):
    return patch(
        "mirage.core.hf_hub.tree.hub_get_response",
        AsyncMock(return_value=page(list(rows))),
    )


async def _checked(accessor, path: PathSpec) -> FileStat:
    return await stat(accessor, path, None, ListingCheckStore())


@pytest.mark.asyncio
async def test_a_check_asks_for_one_path(accessor):
    # The gate's check is handed no listed row: one paths-info call, no
    # tree walk.
    with _point([LFS_ROW]) as post, _walk() as walk:
        result = await _checked(accessor, ps("a.txt"))
    assert post.await_count == 1
    walk.assert_not_awaited()
    assert post.await_args.args[2] == {"paths": ["a.txt"], "expand": False}
    assert (result.size, result.fingerprint) == (7, "O")


@pytest.mark.asyncio
async def test_an_unhanded_path_outside_a_check_asks_nothing(accessor):
    with _point([LFS_ROW]) as post, _walk() as walk:
        with pytest.raises(FileNotFoundError):
            await stat(accessor, ps("a.txt"))
    post.assert_not_awaited()
    walk.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_check_of_a_missing_path_is_enoent_without_a_walk(accessor):
    with _point([]) as post, _walk() as walk:
        with pytest.raises(FileNotFoundError):
            await _checked(accessor, ps("nope"))
    assert post.await_count == 1
    walk.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_check_of_a_directory(accessor):
    with _point([dir_row("d")]) as post, _walk() as walk:
        result = await _checked(accessor, ps("d"))
    assert result.type is FileType.DIRECTORY
    assert post.await_count == 1
    walk.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [None, {}, {"error": "unavailable"}, ""])
async def test_a_malformed_check_is_not_absence(accessor, answer):
    with _point(answer):
        with pytest.raises(HfHubError):
            await _checked(accessor, ps("a.txt"))


@pytest.mark.asyncio
async def test_a_check_refuses_rows_for_another_path(accessor):
    # An answer about some other path is not an answer about this one; it
    # must not read as absence, which reconcile would turn into a delete.
    with _point([file_row("A.TXT")]):
        with pytest.raises(HfHubError):
            await _checked(accessor, ps("a.txt"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,code",
    [(401, ""), (403, ""), (404, "RepoNotFound"), (404, "RevisionNotFound")],
)
async def test_a_refused_check_is_permission_denied(accessor, status, code):
    # Not absence (which reconcile turns into a delete) and not a raw Hub
    # error (which a recursive walk cannot step past).
    refused = AsyncMock(side_effect=HfHubError("nope", status, code))
    with patch("mirage.core.hf_hub.tree.hub_post", refused), _walk() as walk:
        with pytest.raises(PermissionError):
            await _checked(accessor, ps("a.txt"))
    walk.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_failing_check_stays_a_hub_error(accessor):
    # A server failure is not a refusal; it keeps its own message.
    failed = AsyncMock(side_effect=HfHubError("boom", 500))
    with patch("mirage.core.hf_hub.tree.hub_post", failed), _walk():
        with pytest.raises(HfHubError, match="boom"):
            await _checked(accessor, ps("a.txt"))


def _walked(*rows):
    return patch(
        "mirage.core.hf_hub.stat.fetch_tree",
        AsyncMock(return_value={r["path"]: parse_entry(r) for r in rows}),
    )


ROWS = (file_row("a.txt", 7), file_row("d/b.txt", 3), dir_row("d"))


@pytest.mark.asyncio
async def test_tree_lists_every_entry_below_the_mount_root_in_one_walk(
    accessor, tree
):
    seed(tree, *ROWS)
    with _walked(*ROWS) as walk:
        rows = await tree_of(accessor, "")
    assert walk.await_count == 1
    assert sorted(rows) == ["a.txt", "d", "d/b.txt"]
    assert rows["a.txt"] == await _stat_at(accessor, ps("a.txt"))
    assert rows["d"].type is FileType.DIRECTORY
    assert rows["d/b.txt"].size == 3


async def tree_of(accessor, path: str):
    return await tree(accessor, ps(path))


@pytest.mark.asyncio
async def test_tree_keys_a_subtree_below_its_own_root(accessor):
    with _walked(*ROWS):
        rows = await tree_of(accessor, "d")
    assert list(rows) == ["b.txt"]
    assert rows["b.txt"].fingerprint == "oid-d/b.txt"


@pytest.mark.asyncio
async def test_tree_names_the_directories_the_listing_only_implies(
    accessor,
):
    with _walked(file_row("d/e/b.txt")):
        rows = await tree_of(accessor, "")
    assert sorted(rows) == ["d", "d/e", "d/e/b.txt"]
    assert rows["d/e"].type is FileType.DIRECTORY


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["a.txt", "nope"])
async def test_tree_of_a_file_or_nothing_leaves_the_walk(accessor, path):
    with _walked(*ROWS):
        assert await tree_of(accessor, path) is None


@pytest.mark.asyncio
async def test_tree_reports_a_refused_repository_as_denied(accessor):
    refused = AsyncMock(side_effect=HfHubError("gated", 403))
    with patch("mirage.core.hf_hub.stat.fetch_tree", refused):
        with pytest.raises(PermissionError):
            await tree_of(accessor, "")
