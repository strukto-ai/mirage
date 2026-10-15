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

from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.readdir import readdir
from mirage.types import DirListing
from tests.core.hf_hub.conftest import dir_row, file_row, ps, seed


def _names(listing: DirListing) -> list[str]:
    return [row.name for row in listing.entries]


@pytest.mark.asyncio
async def test_readdir_lists_the_root(loaded):
    assert _names(await readdir(loaded, ps(""))) == ["a.txt", "d"]


@pytest.mark.asyncio
async def test_readdir_lists_a_subdirectory(loaded):
    assert _names(await readdir(loaded, ps("d"))) == ["b.txt"]


@pytest.mark.asyncio
async def test_one_walk_seeds_every_folder_below(loaded):
    listing = await readdir(loaded, ps(""))
    assert {k: [r.name for r in v] for k, v in listing.seeds.items()} == {
        "d": ["b.txt"]
    }


@pytest.mark.asyncio
async def test_readdir_of_a_file_is_enotdir(loaded):
    with pytest.raises(NotADirectoryError):
        await readdir(loaded, ps("a.txt"))


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(loaded):
    """GNU `ls /f.txt/x` reports Not a directory, not absence."""
    with pytest.raises(NotADirectoryError):
        await readdir(loaded, ps("a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_of_a_missing_path_is_enoent(loaded):
    with pytest.raises(FileNotFoundError):
        await readdir(loaded, ps("nope"))


@pytest.mark.asyncio
async def test_readdir_below_a_missing_path_is_enoent(loaded):
    """A component that does not exist is ENOENT however deep it is."""
    with pytest.raises(FileNotFoundError):
        await readdir(loaded, ps("nope/deeper"))


@pytest.mark.asyncio
async def test_readdir_of_an_empty_repo_lists_nothing(accessor, tree):
    assert _names(await readdir(accessor, ps(""))) == []


@pytest.mark.asyncio
async def test_readdir_under_a_mount_prefix(accessor, tree):
    seed(tree, file_row("a.txt"))
    assert _names(await readdir(accessor, ps("", "/m"))) == ["a.txt"]


@pytest.mark.asyncio
async def test_a_directory_only_a_path_implies_is_listed(accessor, tree):
    # A page boundary can deliver a child before its parent's own row.
    seed(tree, file_row("d/e/b.txt"), dir_row("d"))
    listing = await readdir(accessor, ps(""))
    assert _names(listing) == ["d"]
    assert [row.name for row in listing.seeds["d"]] == ["e"]


@pytest.mark.asyncio
async def test_a_listing_is_walked_at_its_head_and_versioned(
    accessor, tree, head
):
    # The head first, and the tree walked at the commit it names, so the
    # version is the one these rows are at.
    head.return_value = "c0ffee"
    seed(tree, file_row("a.txt"))
    listing = await readdir(accessor, ps(""))
    assert tree.await_args.args[1] == "c0ffee"
    assert listing.version == "c0ffee"


@pytest.mark.asyncio
async def test_a_listing_with_no_head_walks_the_branch_unversioned(
    accessor, tree
):
    listing = await readdir(accessor, ps(""))
    assert tree.await_args.args[1] is None
    assert listing.version is None


@pytest.mark.asyncio
async def test_a_listing_whose_head_fails_raises(accessor, tree, head):
    head.side_effect = HfHubError("boom", 500)
    with pytest.raises(HfHubError, match="boom"):
        await readdir(accessor, ps(""))
    tree.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_refused_tree_walk_is_permission_denied(accessor, head):
    refused = AsyncMock(side_effect=HfHubError("nope", 401))
    with patch("mirage.core.hf_hub.tree.hub_get_response", refused):
        with pytest.raises(PermissionError):
            await readdir(accessor, ps(""))
