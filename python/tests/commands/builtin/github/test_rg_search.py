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

from mirage.commands.builtin.github.pushdown import narrow_scope
from mirage.commands.builtin.github.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.io.types import IOResult
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS

_GLOBALS = rg.__wrapped__.__globals__
_NGLOBALS = narrow_scope.__globals__


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


def _root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/", directory="/", resolved=False)


def _subdir() -> PathSpec:
    return PathSpec(vfs_path="src",
                    virtual="/src",
                    directory="/src",
                    resolved=False)


@pytest.mark.asyncio
async def test_rg_root_large_tree_uses_search(mock_github_api, github_env,
                                              monkeypatch):
    accessor, index = github_env
    narrowed = [
        PathSpec(vfs_path="src/main.py",
                 virtual="/src/main.py",
                 directory="",
                 resolved=True),
        PathSpec(vfs_path="src/utils.py",
                 virtual="/src/utils.py",
                 directory="",
                 resolved=True),
    ]
    spy = AsyncMock(return_value=narrowed)
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    stdout, io = await rg(
        accessor, [_root()], ['import'],
        CommandOpts(index=index, flags={
            'count': True,
            'word_regexp': True
        }))
    spy.assert_awaited_once()
    text = (await materialize(stdout)).decode()
    assert io.exit_code == 0
    assert "/src/main.py:3" in text
    assert "/src/utils.py:1" in text


@pytest.mark.asyncio
async def test_rg_subdir_uses_search(mock_github_api, github_env, monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await rg(accessor, [_subdir()], ['import'],
             CommandOpts(index=index, flags={'word_regexp': True}))
    spy.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_regex_skips_search(mock_github_api, github_env, monkeypatch):
    # A regex narrows on an extracted literal, so the searched term is only
    # part of the match; a whole-word search for it can miss real matches.
    # Excluded even under -w.
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await rg(accessor, [_root()], ['imp.*rt'],
             CommandOpts(index=index, flags={'word_regexp': True}))
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_rg_regex_without_literal_skips_search(mock_github_api,
                                                     github_env, monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await rg(accessor, [_root()], ['imp|exp'],
             CommandOpts(index=index, flags={'word_regexp': True}))
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_rg_small_tree_skips_search(mock_github_api, github_env,
                                          monkeypatch):
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await rg(accessor, [_root()], ['import'],
             CommandOpts(index=index, flags={'word_regexp': True}))
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_rg_scope_error_when_too_many_files(mock_github_api, github_env,
                                                  monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_GLOBALS, "SCOPE_ERROR", 1)
    stdout, io = await rg(
        accessor, [_root()], ['import'],
        CommandOpts(index=index, flags={'word_regexp': True}))
    assert io.exit_code == 1
    assert b"narrow the path" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_rg_without_word_flag_skips_search(mock_github_api, github_env,
                                                 monkeypatch):
    # See test_grep_without_word_flag_skips_search: whole-word search results
    # are a strict subset of substring matches.
    accessor, index = github_env
    spy = AsyncMock(return_value=[])
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", spy)
    await rg(accessor, [_root()], ['import'], CommandOpts(index=index))
    spy.assert_not_awaited()


# The narrowed run at the seam between narrow_scope and the generic scan,
# as tests/commands/builtin/dropbox/test_rg_search.py drives its wrapper.
def _narrowed(virtual: str) -> PathSpec:
    return PathSpec(vfs_path=virtual.removeprefix("/"),
                    virtual=virtual,
                    directory="",
                    resolved=True)


@pytest.fixture
def seam(monkeypatch):
    narrow = AsyncMock(return_value=([_subdir()], 3, False))
    generic = AsyncMock(return_value=(b"", IOResult()))
    monkeypatch.setitem(_GLOBALS, "narrow_scope", narrow)
    monkeypatch.setitem(_GLOBALS, "generic_rg", generic)
    return narrow, generic


@pytest.mark.asyncio
async def test_narrowed_run_forces_filename_labels(github_env, seam):
    # A walk labels every file it finds; one narrowed candidate arrives as
    # a lone explicit operand, which the generic scan would print bare.
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([_narrowed("/src/a.py")], 1, True)
    await rg(accessor, [_subdir()], ["needle"],
             CommandOpts(index=index, flags={"word_regexp": True}))
    assert generic.await_args.args[2].flags.get("with_filename") is True


@pytest.mark.asyncio
async def test_dash_upper_i_suppression_survives_narrowing(github_env, seam):
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([_narrowed("/src/a.py")], 1, True)
    await rg(
        accessor, [_subdir()], ["needle"],
        CommandOpts(index=index,
                    flags={
                        "word_regexp": True,
                        "no_filename": True
                    }))
    assert "with_filename" not in generic.await_args.args[2].flags


@pytest.mark.asyncio
async def test_walk_fallback_leaves_flags_alone(github_env, seam):
    accessor, index = github_env
    _, generic = seam
    await rg(accessor, [_subdir()], ["needle"],
             CommandOpts(index=index, flags={"word_regexp": True}))
    assert "with_filename" not in generic.await_args.args[2].flags


@pytest.mark.asyncio
async def test_hidden_candidates_are_pruned(github_env, seam):
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([
        _narrowed("/src/.env"),
        _narrowed("/src/.github/ci.yml"),
        _narrowed("/src/a.py"),
    ], 3, True)
    await rg(accessor, [_subdir()], ["needle"],
             CommandOpts(index=index, flags={"word_regexp": True}))
    assert [p.virtual for p in generic.await_args.args[0]] == ["/src/a.py"]


@pytest.mark.asyncio
async def test_hidden_flag_keeps_hidden_candidates(github_env, seam):
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([_narrowed("/src/.env"),
                            _narrowed("/src/a.py")], 2, True)
    await rg(
        accessor, [_subdir()], ["needle"],
        CommandOpts(index=index, flags={
            "word_regexp": True,
            "hidden": True
        }))
    assert [p.virtual
            for p in generic.await_args.args[0]] == ["/src/.env", "/src/a.py"]


@pytest.mark.asyncio
async def test_all_hidden_narrowed_set_exits_one(github_env, seam):
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([_narrowed("/src/.env")], 1, True)
    stdout, io = await rg(
        accessor, [_subdir()], ["needle"],
        CommandOpts(index=index, flags={"word_regexp": True}))
    assert stdout == b""
    assert io.exit_code == 1
    generic.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("file_type, want", [("py", ("/src/main.py:3\n", 0)),
                                             ("md", ("", 1))])
async def test_rg_narrowed_candidates_pass_the_walk_filters(
        mock_github_api, github_env, monkeypatch, file_type, want):
    # The candidates stand in for a walk, which --type filters, while a
    # file named on the line is never filtered, so the wrapper filters
    # them itself; none left is no match, not a stdin run.
    accessor, index = github_env
    narrowed = [
        PathSpec(vfs_path="src/main.py",
                 virtual="/src/main.py",
                 directory="",
                 resolved=True)
    ]
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths",
                        AsyncMock(return_value=narrowed))
    stdout, io = await rg(
        accessor, [_root()], ['import'],
        CommandOpts(index=index,
                    flags={
                        'count': True,
                        'word_regexp': True,
                        'type': file_type
                    }))
    assert ((await materialize(stdout)).decode(), io.exit_code) == want
