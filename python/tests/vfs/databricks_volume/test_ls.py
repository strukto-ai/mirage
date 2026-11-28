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
import pytest_asyncio

from mirage import MountMode, Workspace
from tests.fixtures.databricks_volume import ROOT
from tests.vfs.databricks_volume.test_databricks_volume import make_vfs


@pytest_asyncio.fixture
async def ws(volume) -> Workspace:
    await volume.put(f"{ROOT}/words.txt", b"beta\nalpha\nalpha\n")
    await volume.put(f"{ROOT}/.hidden", b"h\n")
    await volume.put(f"{ROOT}/sub/inner.txt", b"gamma\nalpha\n")
    return Workspace({"/dbx/": make_vfs(volume)}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_ls_lists_entries(ws):
    io = await ws.shell("ls /dbx/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "sub" in out
    assert ".hidden" not in out


@pytest.mark.asyncio
async def test_ls_a_includes_hidden(ws):
    io = await ws.shell("ls -a /dbx/")

    assert io.exit_code == 0
    assert ".hidden" in io.stdout.decode()
