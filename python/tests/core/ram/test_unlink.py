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

import asyncio
import errno

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.unlink import unlink
from mirage.types import MountMode, PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

FD = PathSpec(vfs_path="fd/63", virtual="/dev/fd/63", directory="/dev/fd/")


@pytest.mark.asyncio
async def test_unlink_of_a_live_descriptor_is_eperm_and_keeps_it():
    store = DevStore(DevFiles("owner"))
    endpoint = DevicePipe(True)
    store.files.allocate_input(endpoint)
    with pytest.raises(PermissionError) as caught:
        await unlink(RAMAccessor(store), FD)
    assert caught.value.errno == errno.EPERM
    assert caught.value.filename == "/dev/fd/63"
    assert store.files.pipe_of("/fd/63") is endpoint


@pytest.mark.asyncio
async def test_rm_of_a_substitution_leaves_it_readable():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(
            ws.shell(
                'f() { rm "$1"; echo "st=$?"; cat "$1"; }; f <(echo still)'
            ),
            5,
        )
        assert (io.exit_code, await io.stdout_str()) == (0, "st=1\nstill\n")
        assert "/dev/fd/63" in await io.stderr_str()
    finally:
        await ws.close()
