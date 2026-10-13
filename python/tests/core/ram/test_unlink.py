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

import errno

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.unlink import unlink
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore

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
