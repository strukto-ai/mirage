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

from mirage.core.machine.create import create
from mirage.core.machine.pwrite import pwrite
from mirage.core.machine.truncate import truncate
from mirage.core.machine.write import write, write_command
from mirage.errors.types import OperationNotSupportedError
from tests.fixtures.machine import (
    InputlessMachine,
    ScriptedMachine,
    failed,
    ok,
)
from tests.fixtures.machine_files import bound, spec


def test_write_command_replaces_appends_or_stages():
    assert write_command("/tmp/x", append=False, atomic=False) == (
        "cat > '/tmp/x'"
    )
    assert write_command("/tmp/x", append=True, atomic=False) == (
        "cat >> '/tmp/x'"
    )
    staged = write_command("/tmp/x", append=False, atomic=True)
    name = staged.split()[2]
    assert name.startswith("'/tmp/x.mirage-")
    assert staged == (
        f"cat > {name} && mv -f -- {name} '/tmp/x'"
        f" || {{ rm -f -- {name}; exit 1; }}"
    )


@pytest.mark.asyncio
async def test_write_streams_the_bytes_to_cat():
    box = ScriptedMachine("box", lambda line, data: ok())
    await write(bound(box), "box", spec("/x"), b"hello")
    assert (box.lines, box.fed) == (["cat > '/tmp/x'"], [b"hello"])


@pytest.mark.asyncio
async def test_a_write_the_machine_refuses_raises_its_error():
    said = b"sh: 1: cannot create /tmp/d: Is a directory\n"
    box = ScriptedMachine("box", lambda line, data: failed(said, 2))
    with pytest.raises(IsADirectoryError):
        await write(bound(box), "box", spec("/d"), b"x")


@pytest.mark.asyncio
async def test_a_machine_without_input_refuses_a_write():
    box = InputlessMachine("box", lambda line, data: ok())
    for op in (
        write(bound(box), "box", spec("/x"), b"new"),
        pwrite(bound(box), "box", spec("/z"), b"AB", 5),
    ):
        with pytest.raises(OperationNotSupportedError):
            await op
    assert box.lines == []


@pytest.mark.asyncio
async def test_pwrite_create_and_truncate_lines():
    box = ScriptedMachine("box", lambda line, data: ok())
    accessor = bound(box)
    await pwrite(accessor, "box", spec("/x"), b"ab", 7)
    await create(accessor, "box", spec("/x"))
    await truncate(accessor, "box", spec("/x"), 4, no_create=True)
    assert box.lines == [
        "dd of='/tmp/x' seek=7 oflag=seek_bytes conv=notrunc status=none",
        ": >> '/tmp/x'",
        "truncate -c -s 4 -- '/tmp/x'",
    ]
