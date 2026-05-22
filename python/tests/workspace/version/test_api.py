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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.version.api import snapshot_tree
from mirage.workspace.version.mapping import META_PATH
from mirage.workspace.version.store import VersionStore


@pytest.mark.asyncio
async def test_snapshot_tree_contains_files_and_meta(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")
    store = await VersionStore.open(tmp_path / ".mirage")

    tree = await snapshot_tree(store, ws)
    contents = await store.read_tree(tree)

    assert META_PATH in contents
    assert await store.read_blob(contents["m/a.txt"]) == b"hello\n"
