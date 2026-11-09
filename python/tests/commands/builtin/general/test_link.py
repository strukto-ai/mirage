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


# A hard link is a byte copy. Pinned on coreutils 9.7.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        ("echo hi > /d/a; link /d/a /d/b; cat /d/b", "hi\n", "", 0),
        (
            "echo hi > /d/a; link /d/a /d/a",
            "",
            "link: cannot create link '/d/a' to '/d/a': File exists\n",
            1,
        ),
        (
            "link /d/nosuch /d/z",
            "",
            "link: cannot create link '/d/z' to '/d/nosuch': No such file or "
            "directory\n",
            1,
        ),
        (
            "mkdir /d/s; link /d/s /d/t",
            "",
            "link: cannot create link '/d/t' to '/d/s': Operation not permitted\n",
            1,
        ),
        (
            "link",
            "",
            "link: missing operand\nTry 'link --help' for more information.\n",
            1,
        ),
    ],
)
async def test_link(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code
