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

from mirage import MountMode, RAMResource, Workspace
from mirage.shell.errors import ArithError, ExitSignal
from mirage.workspace.expand.node import arith_exit


def test_arith_exit_shape():
    sig = arith_exit(" 1 / 0 ", ArithError("division by 0"))
    assert isinstance(sig, ExitSignal)
    assert sig.exit_code == 1
    assert sig.contained_code == 1
    assert sig.stderr == b"bash: 1 / 0: division by 0\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("line,err", [
    ("echo $((1/0)); echo after", "bash: 1/0: division by 0\n"),
    ("x=0; echo $((1/$x)); echo after", "bash: 1/0: division by 0\n"),
    ("echo $((2**-1)); echo after", "bash: 2**-1: exponent less than 0\n"),
    ("x=$((1%0)); echo after", "bash: 1%0: division by 0\n"),
])
async def test_arithmetic_error_aborts_the_line(line, err):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute(line)
    assert io.exit_code == 1
    assert await io.stdout_str() == ""
    assert await io.stderr_str() == err


@pytest.mark.asyncio
async def test_arithmetic_error_is_contained_by_a_subshell():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("(echo $((1/0))); echo sub=$?")
    assert await io.stdout_str() == "sub=1\n"
    assert io.exit_code == 0
