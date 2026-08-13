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

from mirage.cache.index import IndexConfig
from mirage.core.github.config import GitHubConfig
from mirage.core.github.stat import stat
from mirage.core.github.tree_entry import TreeEntry
from mirage.resource.github.github import GitHubResource
from mirage.types import PathSpec, ResourceName

CONFIG = GitHubConfig(token="test-token")
OWNER = "test-owner"
REPO = "test-repo"


async def _make_resource(ref: str = "main",
                         default_branch: str = "main",
                         tree: dict | None = None,
                         truncated: bool = False) -> GitHubResource:
    if tree is None:
        tree = {}
    with patch("mirage.resource.github.github.fetch_default_branch",
               return_value=default_branch), \
         patch("mirage.resource.github.github.fetch_tree",
               return_value=(tree, truncated)):
        return await GitHubResource.build(
            config=CONFIG,
            owner=OWNER,
            repo=REPO,
            ref=ref,
        )


@pytest.mark.asyncio
async def test_name() -> None:
    resource = await _make_resource()
    assert resource.name == ResourceName.GITHUB


@pytest.mark.asyncio
async def test_caches_reads() -> None:
    resource = await _make_resource()
    assert resource.caches_reads is True


@pytest.mark.asyncio
async def test_bind_args() -> None:
    resource = await _make_resource()
    assert resource.accessor.config is CONFIG
    assert resource.accessor.owner == OWNER
    assert resource.accessor.repo == REPO
    assert resource.accessor.ref == "main"


@pytest.mark.asyncio
async def test_owner_repo_ref_fall_back_to_config() -> None:
    config = GitHubConfig(token="test-token",
                          owner="cfg-owner",
                          repo="cfg-repo",
                          ref="cfg-ref")
    with patch("mirage.resource.github.github.fetch_default_branch",
               return_value="main"), \
         patch("mirage.resource.github.github.fetch_tree",
               return_value=({}, False)):
        resource = await GitHubResource.build(config=config)
    assert resource.accessor.owner == "cfg-owner"
    assert resource.accessor.repo == "cfg-repo"
    assert resource.accessor.ref == "cfg-ref"


@pytest.mark.asyncio
async def test_kwargs_take_precedence_over_config() -> None:
    config = GitHubConfig(token="test-token",
                          owner="cfg-owner",
                          repo="cfg-repo",
                          ref="cfg-ref")
    with patch("mirage.resource.github.github.fetch_default_branch",
               return_value="main"), \
         patch("mirage.resource.github.github.fetch_tree",
               return_value=({}, False)):
        resource = await GitHubResource.build(config=config,
                                              owner="kw-owner",
                                              repo="kw-repo",
                                              ref="kw-ref")
    assert resource.accessor.owner == "kw-owner"
    assert resource.accessor.repo == "kw-repo"
    assert resource.accessor.ref == "kw-ref"


@pytest.mark.asyncio
async def test_missing_owner_repo_raises() -> None:
    with pytest.raises(ValueError, match="requires owner and repo"):
        await GitHubResource.build(config=GitHubConfig(token="test-token"))


@pytest.mark.asyncio
async def test_missing_owner_repo_refuses_before_any_fetch() -> None:
    # The guard runs first, so a misconfigured mount costs no API call.
    with patch("mirage.resource.github.github.fetch_default_branch") as branch:
        with pytest.raises(ValueError, match="requires owner and repo"):
            await GitHubResource.build(config=GitHubConfig(token="test-token"))
    branch.assert_not_called()


@pytest.mark.asyncio
async def test_is_default_branch_true() -> None:
    resource = await _make_resource(ref="main", default_branch="main")
    assert resource.is_default_branch is True


@pytest.mark.asyncio
async def test_is_default_branch_false() -> None:
    resource = await _make_resource(ref="feature-branch",
                                    default_branch="main")
    assert resource.is_default_branch is False


@pytest.mark.asyncio
async def test_stat_returns_sha_fingerprint() -> None:
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    resource = await _make_resource(tree=tree)
    result = await stat(resource.accessor,
                        PathSpec.from_str_path("/src/main.py"), resource.index)
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_replacing_index_preserves_preloaded_tree() -> None:
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    resource = await _make_resource(tree=tree)
    resource.set_index(IndexConfig())

    result = await stat(resource.accessor,
                        PathSpec.from_str_path("/src/main.py"), resource.index)
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_stat_raises_when_path_not_in_tree() -> None:
    resource = await _make_resource()
    with pytest.raises(FileNotFoundError):
        await stat(resource.accessor,
                   PathSpec.from_str_path("/nonexistent.py"), resource.index)


@pytest.mark.asyncio
@patch("mirage.resource.github.github.fetch_tree")
@patch("mirage.resource.github.github.fetch_default_branch")
async def test_create_fetches_default_branch(mock_fetch_branch,
                                             mock_fetch_tree) -> None:
    mock_fetch_branch.return_value = "develop"
    mock_fetch_tree.return_value = ({}, False)
    resource = await GitHubResource.build(config=CONFIG,
                                          owner=OWNER,
                                          repo=REPO,
                                          ref="main")
    assert resource.accessor.default_branch == "develop"
    mock_fetch_branch.assert_awaited_once_with(CONFIG, OWNER, REPO)


@pytest.mark.asyncio
async def test_the_constructor_reaches_no_network() -> None:
    # The whole point of the build() split: __init__ takes the fetched
    # tree, so building one never blocks the caller's event loop.
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    branch_target = "mirage.resource.github.github.fetch_default_branch"
    with patch(branch_target) as branch, \
         patch("mirage.resource.github.github.fetch_tree") as fetch:
        resource = GitHubResource(CONFIG, OWNER, REPO, "main", "main", tree)
    branch.assert_not_called()
    fetch.assert_not_called()
    assert resource.accessor.default_branch == "main"
    result = await stat(resource.accessor,
                        PathSpec.from_str_path("/src/main.py"), resource.index)
    assert result.fingerprint == "abc123"
