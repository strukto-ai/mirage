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


# Pinned on gzip 1.13.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        (
            "printf 'a\\nb\\n' > /d/p; printf 'a\\nc\\n' > /d/q; gzip -k /d/p /d/q; "
            "zcmp /d/p.gz /d/q.gz",
            "/dev/fd/5 - differ: char 3, line 2\n",
            "",
            1,
        ),
        (
            "printf 'a\\nb\\n' > /d/p; printf 'a\\nc\\n' > /d/q; gzip -k /d/p /d/q; "
            "zdiff -q /d/p.gz /d/q.gz",
            "Files /dev/fd/5 and - differ\n",
            "",
            1,
        ),
        ("printf 'a\\nb\\n' > /d/p; gzip -k /d/p; zdiff /d/p.gz", "", "", 0),
        (
            "echo a > /d/p; zdiff /d/p",
            "",
            "/usr/bin/zdiff: /d/p: unknown compressed file extension\n",
            2,
        ),
        ("zdiff", "", "/usr/bin/zdiff: missing operand\n", 2),
        (
            "zdiff /d/nosuch.gz /d/q",
            "",
            "/usr/bin/zdiff: 92: cannot open /d/nosuch.gz: No such file\n",
            2,
        ),
        (
            "echo a > /d/p; zdiff /d/p /d/nosuch",
            "",
            "/usr/bin/zdiff: 96: cannot open /d/nosuch: No such file\n",
            2,
        ),
        (
            "zcmp --bogus",
            "",
            "cmp: unrecognized option '--bogus'\ncmp: Try 'cmp --help' for more "
            "information.\n",
            2,
        ),
    ],
)
async def test_zcmp_zdiff(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code
