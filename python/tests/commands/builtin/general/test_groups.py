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


# Pinned on coreutils 9.7.
@pytest.mark.asyncio
async def test_groups():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("groups nosuch; echo rc=$?")
    assert await io.stdout_str() == "rc=1\n"
    assert await io.stderr_str() == "groups: 'nosuch': no such user\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_groups_reads_an_operand_as_a_name_never_a_uid():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("groups 0 root")
    assert await io.stdout_str() == "root : root\n"
    assert await io.stderr_str() == "groups: '0': no such user\n"
