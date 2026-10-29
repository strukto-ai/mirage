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
from mirage.version import __version__

_KERNEL_VERSION = f"#1 Mirage {__version__}"
_ALL = f"Linux mirage mirage {_KERNEL_VERSION} x86_64 GNU/Linux\n"


async def _run(ws: Workspace, line: str) -> tuple[str, str, int]:
    io = await ws.shell(line)
    return await io.stdout_str(), await io.stderr_str(), io.exit_code


# GNU's layout, measured on coreutils 9.7 (debian:stable-slim): no option
# is -s, fields print in one fixed order whatever order they were typed
# in, and -a drops the processor and hardware platform when unknown.
# The values are mirage's fixed identity. Mirrored in uname.test.ts.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("uname", "Linux\n"),
        ("uname -s", "Linux\n"),
        ("uname --kernel-name", "Linux\n"),
        ("uname -n", "mirage\n"),
        ("uname -r", "mirage\n"),
        ("uname -v", f"{_KERNEL_VERSION}\n"),
        ("uname -m", "x86_64\n"),
        ("uname -p", "unknown\n"),
        ("uname -i", "unknown\n"),
        ("uname -o", "GNU/Linux\n"),
        ("uname -a", _ALL),
        ("uname --all", _ALL),
        ("uname -a -p", _ALL),
        (
            "uname -snrvmpio",
            f"Linux mirage mirage {_KERNEL_VERSION} x86_64 unknown unknown GNU/Linux\n",
        ),
        ("uname -ms", "Linux x86_64\n"),
        ("uname -o -n", "mirage GNU/Linux\n"),
        ("uname -s -s", "Linux\n"),
    ],
)
async def test_uname_fields(line, expected):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == (expected, "", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stderr",
    [
        (
            "uname x",
            "uname: extra operand 'x'\n"
            "Try 'uname --help' for more information.\n",
        ),
        (
            "uname -s x",
            "uname: extra operand 'x'\n"
            "Try 'uname --help' for more information.\n",
        ),
        (
            "uname -z",
            "uname: invalid option -- 'z'\n"
            "Try 'uname --help' for more information.\n",
        ),
    ],
)
async def test_uname_refusals(line, stderr):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert await _run(ws, line) == ("", stderr, 1)
    finally:
        await ws.close()
