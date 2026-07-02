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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.readdir import readdir
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/teams"]


@pytest.mark.asyncio
async def test_readdir_teams(accessor, index):
    teams = [{
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
        "updatedAt": "2026-04-05T00:00:00Z",
        "states": {
            "nodes": []
        },
    }]
    with patch("mirage.core.linear.readdir.list_teams",
               new_callable=AsyncMock,
               return_value=teams):
        result = await readdir(
            accessor,
            PathSpec(resource_path="teams",
                     virtual="/teams",
                     directory="/teams"), index)
    assert result == ["/teams/ENG__Engineering__TEAM1"]


@pytest.mark.asyncio
async def test_readdir_teams_keeps_prefix_on_warm_cache_hit(accessor, index):
    teams = [{
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
        "updatedAt": "2026-04-05T00:00:00Z",
        "states": {
            "nodes": []
        },
    }]
    spec = PathSpec(resource_path=mount_key("/linear/teams", "/linear"),
                    virtual="/linear/teams",
                    directory="/linear/teams")
    with patch("mirage.core.linear.readdir.list_teams",
               new_callable=AsyncMock,
               return_value=teams):
        cold = await readdir(accessor, spec, index)
        warm = await readdir(accessor, spec, index)
    assert cold == ["/linear/teams/ENG__Engineering__TEAM1"]
    assert warm == cold


@pytest.mark.asyncio
async def test_readdir_team_members(accessor, index):
    await index.put(
        "/teams/ENG__Engineering__TEAM1",
        IndexEntry(
            id="TEAM1",
            name="Engineering",
            resource_type="linear/team",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG__Engineering__TEAM1",
        ),
    )
    users = [{
        "id": "USER1",
        "name": "Alice",
        "displayName": "Alice",
        "email": "alice@example.com",
        "updatedAt": "2026-04-05T00:00:00Z",
    }]
    with patch("mirage.core.linear.readdir.list_team_members",
               new_callable=AsyncMock,
               return_value=users):
        result = await readdir(
            accessor,
            PathSpec(resource_path="teams/ENG__Engineering__TEAM1/members",
                     virtual="/teams/ENG__Engineering__TEAM1/members",
                     directory="/teams/ENG__Engineering__TEAM1/members"),
            index,
        )
    assert result == [
        "/teams/ENG__Engineering__TEAM1/members/Alice__USER1.json"
    ]


@pytest.mark.asyncio
async def test_readdir_issue_folder(accessor, index):
    await index.put(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1",
        IndexEntry(
            id="ISSUE1",
            name="ENG-123",
            resource_type="linear/issue",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG-123__ISSUE1",
        ),
    )
    result = await readdir(
        accessor,
        PathSpec(
            resource_path=(
                "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"
            ).strip("/"),
            virtual="/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1",
            directory="/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"),
        index,
    )
    assert result == [
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json",
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/comments.jsonl",
    ]
