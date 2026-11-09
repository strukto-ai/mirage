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
async def test_nproc():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "nproc; nproc --all; nproc --ignore=9; OMP_NUM_THREADS=4 "
        "nproc; OMP_NUM_THREADS=4 OMP_THREAD_LIMIT=2 nproc; "
        "OMP_NUM_THREADS=abc nproc; OMP_NUM_THREADS=4 nproc --all; "
        "nproc --ignore=x; echo rc=$?; nproc a; echo rc=$?"
    )
    assert await io.stdout_str() == "1\n1\n1\n4\n2\n1\n1\nrc=1\nrc=1\n"
    assert await io.stderr_str() == (
        "nproc: invalid number: 'x'\nnproc: extra operand 'a'\nTry "
        "'nproc --help' for more information.\n"
    )
    assert io.exit_code == 0
