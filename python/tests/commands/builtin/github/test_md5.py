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

import hashlib

import pytest

from mirage.commands.builtin.github.md5 import md5
from mirage.io.types import materialize
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


def _scope(path: str) -> PathSpec:
    norm = "/" + path.lstrip("/")
    directory = norm.rsplit("/", 1)[0] + "/"
    return PathSpec(original=norm, directory=directory, resolved=True)


async def _run(accessor, index, paths):
    stdout, io = await md5(accessor, [_scope(p) for p in paths], index=index)
    return (await materialize(stdout)).decode(), io


def _digest(sha: str) -> str:
    return hashlib.md5(MOCK_BLOBS[sha]).hexdigest()


@pytest.mark.asyncio
async def test_md5_single_file_gnu_format(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["README.md"])
    assert io.exit_code == 0
    assert text == f"{_digest('aaa111')}  /README.md"


@pytest.mark.asyncio
async def test_md5_multiple_files_one_hash_each(mock_github_api, github_env):
    accessor, index = github_env
    text, _io = await _run(accessor, index, ["README.md", "src/config.py"])
    assert text.splitlines() == [
        f"{_digest('aaa111')}  /README.md",
        f"{_digest('bbb444')}  /src/config.py",
    ]


@pytest.mark.asyncio
async def test_md5_missing_operand_raises(mock_github_api, github_env):
    accessor, index = github_env
    with pytest.raises(ValueError):
        await md5(accessor, [], index=index)
