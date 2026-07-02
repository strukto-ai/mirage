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
"""sed over the read-only GitHub mount (factory-built command).

GitHub is read-only: `sed` is a read-transform (output to stdout) and `-i` is
rejected. Exercises the make_sed factory wiring for github (index-gated glob,
index-aware read, inplace_error).
"""

import pytest

from mirage.commands.builtin.github.sed import sed
from mirage.io.stream import materialize
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
    return PathSpec(resource_path=(norm).strip("/"),
                    virtual=norm,
                    directory=directory,
                    resolved=True)


async def _run(accessor, index, path, expr, **kwargs):
    stdout, io = await sed(accessor, [_scope(path)],
                           expr,
                           index=index,
                           **kwargs)
    data = await materialize(stdout) if stdout is not None else b""
    return data.decode(errors="replace"), io


@pytest.mark.asyncio
async def test_sed_read_transform(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, "src/main.py", "s/import/IMPORT/")
    assert io.exit_code == 0
    # First match on each line (non-global), matching GNU sed.
    assert text == ("IMPORT os\nIMPORT sys\n"
                    "from src.utils IMPORT helper\n"
                    "\nasync def main():\n    pass\n")


@pytest.mark.asyncio
async def test_sed_global(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, "src/utils.py", "s/e/E/g")
    assert io.exit_code == 0
    assert "dEf hElpEr():" in text
    assert "rEturn 42" in text


@pytest.mark.asyncio
async def test_sed_address_delete(mock_github_api, github_env):
    accessor, index = github_env
    text, io = await _run(accessor, index, "src/main.py", "/^import/d")
    assert io.exit_code == 0
    # The two leading `import` lines are dropped; `from ... import` stays.
    assert "import os" not in text
    assert "import sys" not in text
    assert "from src.utils import helper" in text


@pytest.mark.asyncio
async def test_sed_inplace_rejected(mock_github_api, github_env):
    accessor, index = github_env
    with pytest.raises(PermissionError, match="read-only GitHub mount"):
        await _run(accessor, index, "src/main.py", "s/import/X/", i=True)
