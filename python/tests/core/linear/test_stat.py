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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.stat import stat
from mirage.resource.linear.config import LinearConfig
from mirage.types import FileType, PathSpec

_COMMENTS_PATH = ("/teams/ENG__Engineering__TEAM1/issues"
                  "/ENG-123__ISSUE1/comments.jsonl")

_ISSUE_PATH = ("/teams/ENG__Engineering__TEAM1/issues"
               "/ENG-123__ISSUE1/issue.json")


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, PathSpec.from_str_path("/"), index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_teams(accessor, index):
    result = await stat(accessor, PathSpec.from_str_path("/teams"), index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_team_entry(accessor, index):
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
    result = await stat(
        accessor, PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1"),
        index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["team_id"] == "TEAM1"
    assert result.modified == "2026-04-05T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_directory(accessor, index):
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
    result = await stat(
        accessor,
        PathSpec.from_str_path(
            "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"),
        index,
    )
    assert result.type == FileType.DIRECTORY
    assert result.extra["issue_id"] == "ISSUE1"
    assert result.modified == "2026-04-05T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_json(accessor, index):
    result = await stat(
        accessor,
        PathSpec.from_str_path(
            "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json"
        ),
        index,
    )
    assert result.type == FileType.JSON


@pytest.mark.asyncio
async def test_stat_comments_jsonl(accessor, index):
    result = await stat(
        accessor,
        PathSpec.from_str_path(_COMMENTS_PATH),
        index,
    )
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_missing_path(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec.from_str_path("/nonexistent/path"),
                   index)
