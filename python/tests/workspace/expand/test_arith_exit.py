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
from mirage.shell.errors import ArithError, DiscardSignal


def test_an_expansion_error_discards_the_line():
    sig = ArithError("division by 0", "1 / 0 ", "0 ").signal()
    assert isinstance(sig, DiscardSignal)
    assert sig.exit_code == 1
    assert sig.contained_code == 1
    assert sig.stderr == b'bash: 1 / 0 : division by 0 (error token is "0 ")\n'


def test_an_integer_value_error_ends_the_shell_in_its_builtin_voice():
    sig = ArithError("division by 0", "1/0", "0").signal("read", fatal=True)
    assert not isinstance(sig, DiscardSignal)
    assert (sig.exit_code, sig.contained_code) == (1, 1)
    assert (
        sig.stderr == b'bash: read: 1/0: division by 0 (error token is "0")\n'
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,err",
    [
        (
            "echo $((1/0)); echo after",
            'bash: 1/0: division by 0 (error token is "0")\n',
        ),
        (
            "x=0; echo $((1/$x)); echo after",
            'bash: 1/0: division by 0 (error token is "0")\n',
        ),
        (
            "echo $((2**-1)); echo after",
            'bash: 2**-1: exponent less than 0 (error token is "1")\n',
        ),
        (
            "x=$((1%0)); echo after",
            'bash: 1%0: division by 0 (error token is "0")\n',
        ),
    ],
)
async def test_arithmetic_error_aborts_the_line(line, err):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert io.exit_code == 1
    assert await io.stdout_str() == ""
    assert await io.stderr_str() == err


@pytest.mark.asyncio
async def test_arithmetic_error_is_contained_by_a_subshell():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("(echo $((1/0))); echo sub=$?")
    assert await io.stdout_str() == "sub=1\n"
    assert io.exit_code == 0
