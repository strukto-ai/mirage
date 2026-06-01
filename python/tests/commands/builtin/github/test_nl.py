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

from mirage.commands.builtin.github.nl import nl
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


async def _run(accessor, index, paths, **kwargs):
    stdout, io = await nl(accessor, [_scope(p) for p in paths],
                          index=index,
                          **kwargs)
    return (await materialize(stdout)).decode(), io


@pytest.mark.asyncio
async def test_nl_single_file_numbers_nonblank_lines(mock_github_api,
                                                     github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, ["README.md"])
    assert io.exit_code == 0
    lines = text.splitlines()
    # README.md = "# Mock Repo\n\nA test repository.\n": two non-blank lines
    # numbered 1 and 2, the blank line unnumbered.
    assert lines[0].endswith("# Mock Repo")
    assert lines[0].lstrip().startswith("1")
    assert lines[-1].lstrip().startswith("2")
    assert "A test repository." in lines[-1]


@pytest.mark.asyncio
async def test_nl_multiple_files_includes_all(mock_github_api, github_env):
    accessor, index = github_env
    text, _io = await _run(accessor, index, ["README.md", "src/config.py"])
    # Both files must be present (the bug dropped everything after the first).
    assert "# Mock Repo" in text
    assert 'DB_URL = "localhost"' in text
    assert "DEBUG = True" in text
    # Numbering restarts per file (matches the generic nl contract): the
    # config file's first line is renumbered from 1.
    cfg_line = next(ln for ln in text.splitlines() if "DB_URL" in ln)
    assert cfg_line.lstrip().startswith("1")
