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

from mirage.core.github.config import GitHubConfig
from mirage.core.github.search import SearchResult, narrow_paths, search_code
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.search.github_get", new_callable=AsyncMock)
async def test_search_code_basic(mock_get, config):
    mock_get.return_value = {
        "items": [
            {
                "path": "src/main.py",
                "sha": "aaa"
            },
            {
                "path": "src/utils.py",
                "sha": "bbb"
            },
        ]
    }
    result = await search_code(config, "acme", "proj", "import os")
    assert len(result) == 2
    assert result[0] == SearchResult(path="src/main.py", sha="aaa")
    mock_get.assert_awaited_once_with(config.token,
                                      "/search/code",
                                      params={"q": "import os repo:acme/proj"})


@pytest.mark.asyncio
@patch("mirage.core.github.search.github_get", new_callable=AsyncMock)
async def test_search_code_empty_results(mock_get, config):
    mock_get.return_value = {"items": []}
    result = await search_code(config, "acme", "proj", "nonexistent")
    assert result == []


@pytest.mark.asyncio
@patch("mirage.core.github.search.github_get", new_callable=AsyncMock)
async def test_search_code_with_path_filter(mock_get, config):
    mock_get.return_value = {"items": [{"path": "src/main.py", "sha": "aaa"}]}
    await search_code(config, "acme", "proj", "import os", path_filter="src/")
    mock_get.assert_awaited_once_with(
        config.token,
        "/search/code",
        params={"q": "import os repo:acme/proj path:src/"})


@pytest.mark.asyncio
@patch("mirage.core.github.search.search_code", new_callable=AsyncMock)
async def test_narrow_paths_strips_leading_slash_in_filter(
        mock_search, config):
    mock_search.return_value = [SearchResult(path="src/main.py", sha="aaa")]
    paths = [PathSpec(resource_path="src", virtual="/src", directory="/src")]
    await narrow_paths(config, "acme", "proj", "import", paths)
    _, kwargs = mock_search.await_args
    assert kwargs["path_filter"] == "src"


@pytest.mark.asyncio
@patch("mirage.core.github.search.search_code", new_callable=AsyncMock)
async def test_narrow_paths_root_uses_no_filter(mock_search, config):
    mock_search.return_value = [SearchResult(path="src/main.py", sha="aaa")]
    paths = [PathSpec(resource_path="", virtual="/", directory="/")]
    await narrow_paths(config, "acme", "proj", "import", paths)
    _, kwargs = mock_search.await_args
    assert kwargs["path_filter"] is None


@pytest.mark.asyncio
@patch("mirage.core.github.search.search_code", new_callable=AsyncMock)
async def test_narrow_paths_normalizes_results_with_leading_slash(
        mock_search, config):
    mock_search.return_value = [
        SearchResult(path="src/main.py", sha="aaa"),
        SearchResult(path="src/utils.py", sha="bbb"),
    ]
    paths = [
        PathSpec(resource_path=mount_key("/gh", "/gh"),
                 virtual="/gh",
                 directory="/gh")
    ]
    out = await narrow_paths(config, "acme", "proj", "import", paths)
    assert [p.virtual for p in out] == ["/gh/src/main.py", "/gh/src/utils.py"]
    assert [p.resource_path for p in out] == ["src/main.py", "src/utils.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.search.search_code", new_callable=AsyncMock)
async def test_narrow_paths_logs_and_continues_on_error(mock_search, config):
    mock_search.side_effect = RuntimeError("boom")
    paths = [PathSpec(resource_path="src", virtual="/src", directory="/src")]
    out = await narrow_paths(config, "acme", "proj", "import", paths)
    assert out == []
