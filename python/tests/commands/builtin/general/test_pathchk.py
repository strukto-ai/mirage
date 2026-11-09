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
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        ("pathchk a/b", "", "", 0),
        (
            "pathchk -p 'a b'",
            "",
            "pathchk: non-portable character ' ' in file name 'a b'\n",
            1,
        ),
        (
            "pathchk -P -- -a",
            "",
            "pathchk: leading '-' in a component of file name '-a'\n",
            1,
        ),
        ("pathchk ''", "", "pathchk: '': No such file or directory\n", 1),
        ("pathchk -p ''", "", "pathchk: empty file name\n", 1),
        (
            "pathchk -p aaaaaaaaaaaaaaa",
            "",
            "pathchk: limit 14 exceeded by length 15 of file name component "
            "'aaaaaaaaaaaaaaa'\n",
            1,
        ),
        (
            "pathchk",
            "",
            "pathchk: missing operand\nTry 'pathchk --help' for more information.\n",
            1,
        ),
    ],
)
async def test_pathchk(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code
