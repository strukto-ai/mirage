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


# With no terminal to page on. Pinned on less 668, util-linux 2.41.5 and gzip 1.13.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        ("echo one > /d/a; less /d/a", "one\n", "", 0),
        ("echo one > /d/a; less /d/a /d/a", "one\n", "", 0),
        (
            "echo one > /d/a; less /d/nosuch /d/a",
            "/d/nosuch: No such file or directory\none\n",
            "",
            0,
        ),
        ("mkdir /d/s; less /d/s", "/d/s is a directory\n", "", 0),
        (
            "echo one > /d/a; more /d/a",
            "::::::::::::::\n/d/a\n::::::::::::::\none\n",
            "",
            0,
        ),
        (
            "more /d/nosuch",
            "",
            "more: cannot open /d/nosuch: No such file or directory\n",
            0,
        ),
        ("mkdir /d/s; more /d/s", "\n*** /d/s: directory ***\n\n", "", 0),
        ("echo one > /d/a; gzip /d/a; zless /d/a.gz", "one\n", "", 0),
        (
            "zless /d/nosuch",
            "/d/nosuch: No such file or directory\n",
            "gzip: /d/nosuch.gz: No such file or directory\n",
            0,
        ),
        ("echo one > /d/a; gzip /d/a; zmore /d/a.gz", "one\n", "", 0),
        (
            "zmore -x /d/a.gz",
            "",
            "/usr/bin/zmore: -x: unknown option; try '/usr/bin/zmore --help' for "
            "help\n",
            1,
        ),
        (
            "less --bogus",
            "",
            'There is no bogus option ("less --help" for help)\n',
            0,
        ),
        ("less -p", "", "Value is required after -p (--pattern)\n", 0),
    ],
)
async def test_pagers(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code
