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
from mirage.commands.builtin.github_ci.grep import grep
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
async def test_grep_single_file_match(accessor, index):
    file_stat = FileStat(name="run.json", type=FileType.JSON)
    with (
            patch("mirage.commands.builtin.github_ci.grep._stat",
                  new=AsyncMock(return_value=file_stat)),
            patch("mirage.commands.builtin.github_ci.grep.ci_read",
                  new=AsyncMock(return_value=b"hello world\nbye world\n")),
    ):
        out, io = await grep(
            accessor,
            [_scope("/runs/wf_1/run.json")],
            "hello",
            index=index,
        )
        data = await materialize(out)
        assert b"hello world" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_no_match_exit_one(accessor, index):
    file_stat = FileStat(name="run.json", type=FileType.JSON)
    with (
            patch("mirage.commands.builtin.github_ci.grep._stat",
                  new=AsyncMock(return_value=file_stat)),
            patch("mirage.commands.builtin.github_ci.grep.ci_read",
                  new=AsyncMock(return_value=b"abc\ndef\n")),
    ):
        out, io = await grep(
            accessor,
            [_scope("/runs/wf_1/run.json")],
            "missing",
            index=index,
        )
        await materialize(out)
        assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_recursive_directory(accessor, index):
    dir_stat = FileStat(name="workflows", type=FileType.DIRECTORY)
    file_stat = FileStat(name="ci.json", type=FileType.JSON)

    async def fake_stat(_acc, p, index=None):
        if p.virtual.endswith(".json"):
            return file_stat
        return dir_stat

    async def fake_readdir(_acc, p, index=None):
        if p.virtual == "/workflows":
            return ["/workflows/ci_1.json", "/workflows/build_2.json"]
        return []

    async def fake_read(_acc, p, index=None):
        if "ci_1" in p.virtual:
            return b"name: Test\non: push\n"
        return b"name: Build\non: push\n"

    with (
            patch("mirage.commands.builtin.github_ci.grep._stat",
                  new=AsyncMock(side_effect=fake_stat)),
            patch("mirage.commands.builtin.github_ci.grep._readdir",
                  new=AsyncMock(side_effect=fake_readdir)),
            patch("mirage.commands.builtin.github_ci.grep.ci_read",
                  new=AsyncMock(side_effect=fake_read)),
    ):
        out, io = await grep(
            accessor,
            [_scope("/workflows")],
            "Test",
            r=True,
            index=index,
        )
        data = await materialize(out)
        assert b"name: Test" in data
        assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_recursive_runs_rejected(accessor, index):
    with pytest.raises(ValueError, match="across runs is disabled"):
        await grep(accessor, [_scope("/runs")], "x", r=True, index=index)


@pytest.mark.asyncio
async def test_grep_stdin(accessor, index):
    out, io = await grep(
        accessor,
        [],
        "two",
        stdin=b"line one\nline two\nline three\n",
        index=index,
    )
    data = await materialize(out)
    assert b"line two" in data
    assert io.exit_code == 0
