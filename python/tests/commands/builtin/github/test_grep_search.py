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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.narrow import narrow_scope
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS

_GLOBALS = grep.__wrapped__.__globals__
_NGLOBALS = narrow_scope.__globals__


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


def _root() -> PathSpec:
    return PathSpec(original="/", directory="/", prefix="", resolved=False)


def _subdir() -> PathSpec:
    return PathSpec(original="/src",
                    directory="/src",
                    prefix="",
                    resolved=False)


@pytest.mark.asyncio
async def test_grep_root_large_tree_uses_search(mock_github_api, github_env,
                                                monkeypatch):
    accessor, index = github_env
    narrowed = [
        PathSpec(original="/src/main.py",
                 directory="",
                 prefix="",
                 resolved=True),
    ]
    spy = AsyncMock(return_value=narrowed)
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await grep(accessor, [_root()], "import", r=True, index=index)
    spy.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_subdir_uses_search(mock_github_api, github_env,
                                       monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await grep(accessor, [_subdir()], "import", r=True, index=index)
    spy.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_regex_with_literal_uses_search(mock_github_api, github_env,
                                                   monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await grep(accessor, [_root()], "import.*os", r=True, index=index)
    spy.assert_awaited_once()
    assert spy.await_args.args[3] == "import"


@pytest.mark.asyncio
async def test_grep_regex_without_literal_skips_search(mock_github_api,
                                                       github_env,
                                                       monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await grep(accessor, [_root()], "import|export", r=True, index=index)
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_grep_small_tree_skips_search(mock_github_api, github_env,
                                            monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await grep(accessor, [_root()], "import", r=True, index=index)
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_grep_scope_error_when_too_many_files(mock_github_api,
                                                    github_env, monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_GLOBALS, "SCOPE_ERROR", 1)
    stdout, io = await grep(accessor, [_root()], "import", r=True, index=index)
    assert io.exit_code == 1
    assert b"narrow the path" in (io.stderr or b"")
