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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.readdir import readdir
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/workspaces"]


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor, index):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="__nf_missing__",
                     virtual="/__nf_missing__",
                     directory="/__nf_missing__"), index)


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="workspaces/w/nope/deeper",
                     virtual="/workspaces/w/nope/deeper",
                     directory="/workspaces/w/nope/deeper"), index)
