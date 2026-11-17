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
from mirage.core.machine.write import stage_name, write, write_command
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
    assert name.startswith("'/tmp/.mirage-")
    assert staged == (
        f"cat > {name} && mv -f -- {name} '/tmp/x'"
        f" || {{ rm -f -- {name}; exit 1; }}"
    )


def test_a_stage_name_stays_short_beside_a_long_name():
    name = stage_name("/tmp/" + "n" * 250)
    assert name.startswith("/tmp/.mirage-")
    assert len(name.rsplit("/", 1)[1]) == 40
    assert stage_name("/x").startswith("/.mirage-")


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
async def test_a_machine_without_input_writes_through_its_file_api():
    box = InputlessMachine("box", lambda line, data: ok())
    accessor = bound(box)
    await write(accessor, "box", spec("/x"), b"new")
    await write(accessor, "box", spec("/y"), b"+", append=True)
    await pwrite(accessor, "box", spec("/z"), b"AB", 5)
    _, y, z = box.put
    assert [*box.put.values()] == [b"new", b"+", b"AB"]
    assert box.put["/tmp/x"] == b"new"
    assert y.startswith("/tmp/.mirage-") and z.startswith("/tmp/.mirage-")
    assert box.lines == [
        f"cat -- '{y}' >> '/tmp/y'; s=$?; rm -f -- '{y}'; exit $s",
        f"dd if='{z}' of='/tmp/z' seek=5 oflag=seek_bytes conv=notrunc"
        f" status=none; s=$?; rm -f -- '{z}'; exit $s",
    ]
    assert all(f is None for f in box.fed)


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
