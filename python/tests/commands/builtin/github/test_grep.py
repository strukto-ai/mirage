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

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.github import COMMANDS
from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.io import IO as BACKEND_IO
from mirage.commands.builtin.github.rg import rg
from mirage.commands.config import CommandOpts, registered_commands
from mirage.io.stream import materialize
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):
    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


def _scope(path: str, resolved: bool = True) -> PathSpec:
    norm = "/" + path.lstrip("/")
    directory = norm.rsplit("/", 1)[0] + "/"
    return PathSpec(
        vfs_path=(norm).strip("/"),
        virtual=norm,
        directory=directory,
        resolved=resolved,
    )


async def _run(accessor, index, paths, pattern, **kwargs):
    scopes = [_scope(p, resolved=("." in p.split("/")[-1])) for p in paths]
    stdout, io = await grep(
        BACKEND_IO,
        accessor,
        scopes,
        [pattern],
        CommandOpts(index=index, flags={**kwargs}),
    )
    data = await materialize(stdout)
    return data.decode(errors="replace"), io


@pytest.mark.asyncio
async def test_single_file_grep(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/main.py"], "import")
    assert io.exit_code == 0
    lines = text.strip().splitlines()
    assert len(lines) == 3
    assert "import os" in lines[0]
    assert "import sys" in lines[1]
    assert "import helper" in lines[2]


@pytest.mark.asyncio
@pytest.mark.parametrize("command", [grep, rg])
async def test_search_reads_warm_bytes_through_its_adapter(
    mock_github_api, github_env, command
):
    accessor, index = github_env
    cache = RAMFileCacheStore()
    await cache.set("/src/main.py", b"cached match\n")
    prev = push_cache_manager(CacheManager(cache, None, "/", True))
    try:
        stdout, io = await next(
            c.fn
            for c in registered_commands(COMMANDS)
            if c.name == command.__name__
        )(
            accessor,
            [_scope("src/main.py")],
            ["cached"],
            CommandOpts(index=index),
        )
        assert await materialize(stdout) == b"cached match\n"
        assert io.exit_code == 0
    finally:
        push_cache_manager(prev)


@pytest.mark.asyncio
async def test_grep_with_line_numbers(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/main.py"], "import", n=True)
    assert io.exit_code == 0
    lines = text.strip().splitlines()
    assert lines[0].startswith("1:")
    assert lines[1].startswith("2:")


@pytest.mark.asyncio
async def test_grep_case_insensitive(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/main.py"], "IMPORT", i=True)
    assert io.exit_code == 0
    lines = text.strip().splitlines()
    assert len(lines) >= 2


@pytest.mark.asyncio
async def test_grep_invert(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/utils.py"], "import", v=True)
    assert io.exit_code == 0
    lines = text.strip().splitlines()
    for line in lines:
        assert "import" not in line


@pytest.mark.asyncio
async def test_grep_count(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/main.py"], "import", c=True)
    assert io.exit_code == 0
    assert text.strip() == "3"


@pytest.mark.asyncio
async def test_grep_no_match(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["src/main.py"], "zzz_no_match_zzz")
    assert io.exit_code == 1
