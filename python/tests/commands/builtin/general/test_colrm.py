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


# Pinned on util-linux 2.41.5.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        ("printf 'abcdefgh\\n' | colrm 3 5", "abfgh\n", "", 0),
        ("printf 'abcdefgh\\n' | colrm 3", "ab\n", "", 0),
        ("printf 'abcdefgh\\n' | colrm", "abcdefgh\n", "", 0),
        ("printf 'a\\tb\\n' | colrm 2 3", "a     b\n", "", 0),
        ("printf 'abc\\n' | colrm x", "", "colrm: first argument: 'x'\n", 1),
        (
            "printf 'abc\\n' | colrm 1 x",
            "",
            "colrm: second argument: 'x'\n",
            1,
        ),
        (
            "printf 'a\\377b\\n' | colrm 1",
            "",
            "colrm: fgetwc() failed: Invalid or incomplete multibyte or wide "
            "character\n",
            1,
        ),
    ],
)
async def test_colrm(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code


async def _arriving(*parts):
    for part in parts:
        yield part


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "parts,start,stop,stdout,code",
    [
        ((b"x\xc3", b"\xa9y\n"), 2, 2, b"xy\n", 0),
        ((b"x\xe2", b"\x82", b"\xacy\n"), 2, 2, b"xy\n", 0),
        ((b"a\xc3",), 2, None, b"a", 0),
        ((b"a\xc3", b"b"), 2, None, b"a", 1),
    ],
)
async def test_colrm_character_split_between_chunks(
    parts, start, stop, stdout, code
):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    args = str(start) if stop is None else f"{start} {stop}"
    io = await ws.shell(
        f"colrm {args}", stdin=_arriving(*parts), env={"LC_ALL": "C.UTF-8"}
    )
    assert await io.materialize_stdout() == stdout
    assert io.exit_code == code
    await ws.close()


@pytest.mark.asyncio
async def test_colrm_reports_invalid_bytes_before_early_reader_closes():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "set -o pipefail; printf 'ab\\377' | LC_ALL=C colrm 3 | head -c 1"
    )
    assert await io.stdout_str() == "a"
    assert io.exit_code == 1
    assert "Invalid or incomplete multibyte" in await io.stderr_str()
    await ws.close()
