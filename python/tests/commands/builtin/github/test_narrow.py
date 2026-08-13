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

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.commands.builtin.github.du import _du_size
from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.narrow import narrow_scope
from mirage.commands.builtin.github.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS

_NGLOBALS = narrow_scope.__globals__


class EntryOnlyIndex(IndexCacheStore):

    async def entries(self) -> dict[str, IndexEntry]:
        return {
            "/src/main.py":
            IndexEntry(id="main", name="main.py", resource_type="file", size=7)
        }


@pytest.fixture
def counting_read(monkeypatch):
    reads: list[str] = []

    async def _read_bytes(config, owner, repo, sha):
        reads.append(sha)
        return MOCK_BLOBS.get(sha, b"")

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)
    return reads


def _root() -> PathSpec:
    return PathSpec(resource_path="",
                    virtual="/",
                    directory="/",
                    resolved=False)


def _subdir() -> PathSpec:
    return PathSpec(resource_path="src",
                    virtual="/src",
                    directory="/src",
                    resolved=False)


@pytest.mark.asyncio
async def test_du_uses_store_interface_not_ram_implementation():
    assert await _du_size(EntryOnlyIndex(), _subdir()) == 7


@pytest.mark.asyncio
async def test_subdir_narrows_and_fetches_fewer(mock_github_api, github_env,
                                                counting_read, monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    await grep(accessor, [_subdir()], ['import'],
               CommandOpts(index=index, flags={
                   'r': True,
                   'w': True
               }))
    # /src holds 7 files; code search narrows to the import-matching subset.
    assert 0 < len(counting_read) < 7


@pytest.mark.asyncio
async def test_regex_scans_every_file(mock_github_api, github_env,
                                      counting_read, monkeypatch):
    # A regex narrows on an extracted literal, so the searched term is only
    # part of the match; a whole-word search for it can miss real matches.
    # Excluded even under -w.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    await grep(accessor, [_root()], ['import.*os'],
               CommandOpts(index=index, flags={
                   'r': True,
                   'w': True
               }))
    assert len(counting_read) == len(MOCK_BLOBS)


@pytest.mark.asyncio
async def test_rg_shortcircuit_no_match_exit_1(mock_github_api, github_env,
                                               monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    stdout, io = await rg(
        accessor, [_root()], ['import'],
        CommandOpts(index=index,
                    flags={
                        'args_l': True,
                        'glob': '*.nomatch',
                        'w': True
                    }))
    body = (await materialize(stdout)).decode()
    assert io.exit_code == 1
    assert body == ""
