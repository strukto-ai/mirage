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

from mirage import RAMVFS, MountMode, Workspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_tail_default_n_10(workspace):
    body = b"\n".join(f"line{i}".encode() for i in range(1, 21)) + b"\n"
    await workspace.vfs.write("/f.txt", body)
    io = await workspace.shell("tail /f.txt")
    assert io.exit_code == 0
    expected = b"\n".join(f"line{i}".encode() for i in range(11, 21)) + b"\n"
    assert io.stdout == expected
