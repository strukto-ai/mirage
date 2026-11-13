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


# Pinned on gettext-runtime 0.23.1.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        (
            "printf 'a ${X} $$ $1 \\\\$X\\n' | X=val envsubst",
            "a val $$ $1 \\val\n",
            "",
            0,
        ),
        ("printf '$X $Y\\n' | X=1 Y=2 envsubst '$Y'", "$X 2\n", "", 0),
        ("printf '$NOPE!\\n' | envsubst", "!\n", "", 0),
        ("envsubst -v 'a $X ${Y} $X'", "X\nY\nX\n", "", 0),
        ("envsubst -v", "", "envsubst: missing arguments\n", 1),
        ("envsubst a b", "", "envsubst: too many arguments\n", 1),
    ],
)
async def test_envsubst(line, stdout, stderr, code):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == stderr
    assert io.exit_code == code


@pytest.mark.asyncio
async def test_envsubst_split_references_and_byte_values():
    data = b"${X} / $X / $MISSING / ${ / \xff"
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    for split in range(len(data) + 1):

        async def source():
            yield data[:split]
            yield data[split:]

        io = await ws.shell("envsubst", stdin=source(), env={"X": "\udcff"})
        assert await io.materialize_stdout() == b"\xff / \xff /  / ${ / \xff"
        assert io.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_envsubst_large_expansion_and_listing_without_reading_stdin():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("envsubst", stdin=b"${X}", env={"X": "z" * 100000})
    assert await io.materialize_stdout() == b"z" * 100000
    reads = 0

    async def source():
        nonlocal reads
        reads += 1
        yield b"ignored"

    io = await ws.shell("envsubst -v '$X ${Y} $X'", stdin=source())
    assert await io.stdout_str() == "X\nY\nX\n"
    assert reads == 0
    await ws.close()
