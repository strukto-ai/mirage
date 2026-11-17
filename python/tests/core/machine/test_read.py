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

from mirage.core.machine.read import (
    first_lines,
    last_lines,
    line_count,
    read,
    read_command,
)
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import bound, spec


@pytest.mark.parametrize(
    ("offset", "size", "line"),
    [
        (0, None, "cat -- '/tmp/a b'"),
        (0, 5, "head -c 5 -- '/tmp/a b'"),
        (3, None, "tail -c +4 -- '/tmp/a b'"),
        (3, 5, "tail -c +4 -- '/tmp/a b' | head -c 5"),
    ],
)
def test_read_command_prints_the_window(offset, size, line):
    assert read_command("/tmp/a b", offset, size) == line


@pytest.mark.asyncio
async def test_read_runs_on_the_machine_under_the_root():
    box = ScriptedMachine("box", lambda line, data: ok(b"bytes"))
    accessor = bound(box, root="/srv")
    assert await read(accessor, "box", spec("/x.txt"), 2, 3) == b"bytes"
    assert box.lines == ["tail -c +3 -- '/srv/x.txt' | head -c 3"]


@pytest.mark.asyncio
async def test_a_failed_read_raises_what_the_tool_said():
    said = b"cat: /tmp/x.txt: No such file or directory\n"
    box = ScriptedMachine("box", lambda line, data: failed(said))
    with pytest.raises(FileNotFoundError):
        await read(bound(box), "box", spec("/x.txt"))


@pytest.mark.asyncio
async def test_a_read_that_complains_on_stderr_fails_though_it_exits_0():
    said = b"tail: cannot open '/tmp/d' for reading: Is a directory\n"
    box = ScriptedMachine(
        "box",
        lambda line, data: type(failed(b""))(
            stdout=b"", stderr=said, exit_code=0
        ),
    )
    with pytest.raises(IsADirectoryError):
        await read(bound(box), "box", spec("/d"), 1, 1)


@pytest.mark.asyncio
async def test_lines_and_counts_run_where_the_file_is():
    box = ScriptedMachine("box", lambda line, data: ok(b"3\n"))
    accessor = bound(box)
    path = spec("/x.txt")
    await first_lines(accessor, "box", path, 2)
    await last_lines(accessor, "box", path, 4)
    assert await line_count(accessor, "box", path) == 3
    assert box.lines == [
        "head -n 2 -- '/tmp/x.txt'",
        "tail -n 4 -- '/tmp/x.txt'",
        "env LC_ALL=C wc -l < '/tmp/x.txt'",
    ]
