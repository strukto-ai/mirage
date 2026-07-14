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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.read import read as github_read
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


@pytest.mark.asyncio
async def test_read_valid_blob(github_env):
    accessor, index = github_env
    data = await github_read(accessor, PathSpec.from_str_path("/README.md"),
                             index)
    assert isinstance(data, bytes)
    assert b"Mock Repo" in data


@pytest.mark.asyncio
async def test_read_missing_path(github_env):
    accessor, index = github_env
    with pytest.raises(FileNotFoundError):
        await github_read(accessor, PathSpec.from_str_path("/nonexistent.txt"),
                          index)


@pytest.mark.asyncio
async def test_read_empty_index(github_env):
    accessor, _ = github_env
    empty_index = RAMIndexCacheStore()
    with pytest.raises(FileNotFoundError):
        await github_read(accessor, PathSpec.from_str_path("/README.md"),
                          empty_index)


@pytest.mark.asyncio
async def test_read_directory_path(github_env):
    accessor, index = github_env
    with pytest.raises(IsADirectoryError):
        await github_read(accessor, PathSpec.from_str_path("/src"), index)
