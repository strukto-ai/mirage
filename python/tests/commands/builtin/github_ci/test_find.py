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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.github_ci.find import find
from mirage.commands.errors import FindParseError
from mirage.io.stream import materialize
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GitHubCIAccessor(
        config=GitHubCIConfig(token="t", owner="o", repo="r"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path)


@pytest.mark.asyncio
async def test_find_runs_root_rejected(accessor, index):
    with pytest.raises(ValueError, match="across runs is disabled"):
        await find(accessor, [_scope("/runs")], name="*.log", index=index)


@pytest.mark.asyncio
async def test_find_root_rejected(accessor, index):
    with pytest.raises(ValueError, match="across runs is disabled"):
        await find(accessor, [], name="*.log", index=index)


@pytest.mark.asyncio
async def test_find_invalid_maxdepth_raises_find_parse_error(accessor, index):
    with pytest.raises(FindParseError,
                       match=r"invalid argument 'abc' to '-maxdepth'"):
        await find(accessor, [_scope("/runs/wf_1")],
                   maxdepth="abc",
                   index=index)


@pytest.mark.asyncio
async def test_find_single_run_allowed(accessor, index):

    async def fake_readdir(_acc, p, index=None):
        if p.virtual == "/runs/wf_1":
            return ["/runs/wf_1/run.json", "/runs/wf_1/jobs"]
        if p.virtual == "/runs/wf_1/jobs":
            return ["/runs/wf_1/jobs/build_1.log"]
        return []

    with patch("mirage.commands.builtin.github_ci.find._readdir",
               new=AsyncMock(side_effect=fake_readdir)), \
            patch("mirage.core.github_ci.stat._readdir",
                  new=AsyncMock(side_effect=fake_readdir)):
        out, io = await find(
            accessor,
            [_scope("/runs/wf_1")],
            name="*.log",
            index=index,
        )
        data = await materialize(out)
        assert b"/runs/wf_1/jobs/build_1.log" in data


@pytest.mark.asyncio
async def test_find_path_pattern_is_honored(accessor, index):

    async def fake_readdir(_acc, p, index=None):
        if p.virtual == "/runs/wf_1":
            return ["/runs/wf_1/run.json", "/runs/wf_1/jobs"]
        if p.virtual == "/runs/wf_1/jobs":
            return ["/runs/wf_1/jobs/build_1.log"]
        return []

    with patch("mirage.commands.builtin.github_ci.find._readdir",
               new=AsyncMock(side_effect=fake_readdir)), \
            patch("mirage.core.github_ci.stat._readdir",
                  new=AsyncMock(side_effect=fake_readdir)):
        out, _io = await find(accessor, [_scope("/runs/wf_1")],
                              path="*jobs*",
                              index=index)
        data = await materialize(out)
        assert data.decode().splitlines() == [
            "/runs/wf_1/jobs", "/runs/wf_1/jobs/build_1.log"
        ]


@pytest.mark.asyncio
async def test_find_size_counts_sizeless_entries_as_zero(accessor, index):

    async def fake_readdir(_acc, p, index=None):
        if p.virtual == "/runs/wf_1":
            return ["/runs/wf_1/run.json", "/runs/wf_1/jobs"]
        if p.virtual == "/runs/wf_1/jobs":
            return ["/runs/wf_1/jobs/build_1.log"]
        return []

    async def fake_stat(_acc, p, _idx=None):
        virtual = p.virtual if isinstance(p, PathSpec) else p
        name = virtual.rsplit("/", 1)[-1]
        if "." in name:
            return FileStat(name=name, type=FileType.TEXT, size=None)
        return FileStat(name=name, type=FileType.DIRECTORY)

    with patch("mirage.commands.builtin.github_ci.find._readdir",
               new=AsyncMock(side_effect=fake_readdir)), \
         patch("mirage.commands.builtin.github_ci.find._stat",
               new=AsyncMock(side_effect=fake_stat)):
        out, _io = await find(accessor, [_scope("/runs/wf_1")],
                              size="+0c",
                              index=index)
        data = await materialize(out)
        assert data == b""
