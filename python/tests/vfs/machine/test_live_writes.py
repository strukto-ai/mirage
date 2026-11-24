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

import asyncio
from functools import partial

import pytest

from mirage.context.session_context import (
    CallerToken,
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.machine.types import Landing
from mirage.execution.types import MachineName
from mirage.io.types import ByteSource
from mirage.runtime.types import OutputFn, RunAnswer, RunResult
from mirage.types import PathSpec
from mirage.vfs.machine.config import MachineVFSConfig
from mirage.vfs.machine.live_writes import LiveWrites
from mirage.vfs.machine.machine import MachineVFS
from tests.fixtures.machine import ScriptedMachine, failed, table_of
from tests.fixtures.machine_files import FakeFiles, shared, spec


def running_on(name: str) -> CallerToken:
    """Bind a program running on machine ``name`` as the caller.

    Args:
        name (str): the machine.
    """
    return bind_caller(
        current_caller().changed({"machine": MachineName("scripted", name)})
    )


async def write_on(
    name: str,
    vfs: MachineVFS,
    path: PathSpec,
    data: ByteSource,
    *,
    append: bool = False,
) -> None:
    """Write a name as a program's ``>`` (or ``>>``) on machine ``name``
    does.

    Args:
        name (str): the program's machine.
        vfs (MachineVFS): the mount.
        path (PathSpec): the name.
        data (ByteSource): what the program writes.
        append (bool): add to the end instead (``>>``).
    """
    token = running_on(name)
    try:
        if append:
            await vfs.append(path, data)
        else:
            await vfs.write(path, data)
    finally:
        reset_caller(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("landing", ["write", "copy"])
async def test_a_landing_leaves_another_machine_s_live_write(landing):
    a = FakeFiles({"/tmp/src": b"from a\n"})
    b = FakeFiles({"/tmp/k": b"old\n"})
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    writing = asyncio.create_task(write_on("b", vfs, spec("/k"), slow()))
    await pulled.wait()
    if landing == "write":
        await write_on("a", vfs, spec("/k"), b"from a\n")
    else:
        await vfs.copy(spec("/src"), spec("/k"))
    assert (a.files["/tmp/k"], "/tmp/k" in b.files) == (b"from a\n", True)
    released.set()
    await writing
    assert ("/tmp/k" in a.files, b.files["/tmp/k"]) == (False, b"from b\n")


@pytest.mark.asyncio
async def test_a_live_write_that_fails_leaves_the_copy_landed_meanwhile():
    a, b = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    b.written["/tmp/k"] = 2 * 10**9
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def failing():
        pulled.set()
        await released.wait()
        raise OSError(5, "Input/output error")
        yield b""

    writing = asyncio.create_task(write_on("b", vfs, spec("/k"), failing()))
    await pulled.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    released.set()
    with pytest.raises(OSError):
        await writing
    assert (a.files["/tmp/k"], "/tmp/k" in b.files) == (b"from a\n", False)


@pytest.mark.asyncio
async def test_the_write_ending_last_is_the_copy_kept():
    a, b = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    writing = asyncio.create_task(vfs.write(spec("/k"), slow()))
    await pulled.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    released.set()
    await writing
    assert ("/tmp/k" in a.files, b.files["/tmp/k"]) == (False, b"from b\n")


@pytest.mark.asyncio
async def test_writes_ending_together_on_two_machines_leave_one_copy():
    machines = {"a": FakeFiles(), "b": FakeFiles()}
    vfs = shared(*machines.values())
    released = asyncio.Event()
    pulled = {name: asyncio.Event() for name in machines}

    async def held(name):
        pulled[name].set()
        await released.wait()
        yield f"from {name}\n".encode()

    writes = [
        asyncio.create_task(write_on(name, vfs, spec("/k"), held(name)))
        for name in machines
    ]
    await asyncio.gather(*(event.wait() for event in pulled.values()))
    released.set()
    await asyncio.gather(*writes)
    kept = {
        name: files.files["/tmp/k"]
        for name, files in machines.items()
        if "/tmp/k" in files.files
    }
    assert len(kept) == 1
    ((name, data),) = kept.items()
    assert data == f"from {name}\n".encode()


class Gated(ScriptedMachine):
    """A machine whose next line holding every part ``armed`` names waits
    for ``go``, setting ``held`` as it starts to wait."""

    def __init__(self, name: str, answer) -> None:
        super().__init__(name, answer)
        self.armed: tuple[str, ...] = ()
        self.held = asyncio.Event()
        self.go = asyncio.Event()

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        line = " ".join(argv)
        if self.armed and all(part in line for part in self.armed):
            self.armed = ()
            self.held.set()
            await self.go.wait()
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


@pytest.mark.asyncio
async def test_a_settling_keeps_a_copy_landed_while_it_looks():
    a_files, b_files = FakeFiles(), FakeFiles()
    a = Gated("a", a_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(a, ScriptedMachine("b", b_files.answer)), "a")
    a.armed = ("/tmp/k", "-maxdepth 0")
    first = asyncio.create_task(write_on("b", vfs, spec("/k"), b"from b\n"))
    await a.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    a.go.set()
    await first
    assert (a_files.files["/tmp/k"], "/tmp/k" in b_files.files) == (
        b"from a\n",
        False,
    )


@pytest.mark.asyncio
async def test_a_removal_never_takes_a_copy_written_after_it_began():
    a_files, b_files = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "a")
    b.armed = ("rm --", "/tmp/k")
    first = asyncio.create_task(write_on("a", vfs, spec("/k"), b"from a\n"))
    await b.held.wait()
    second = asyncio.create_task(write_on("b", vfs, spec("/k"), b"from b\n"))
    await asyncio.wait({second}, timeout=0.2)
    b.go.set()
    await asyncio.gather(first, second)
    assert ("/tmp/k" in a_files.files, b_files.files.get("/tmp/k")) == (
        False,
        b"from b\n",
    )


@pytest.mark.asyncio
async def test_a_settling_marks_a_name_another_machine_is_still_writing():
    a, b = FakeFiles(), FakeFiles()
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    appending = asyncio.create_task(
        write_on("b", vfs, spec("/k"), slow(), append=True)
    )
    await pulled.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    released.set()
    await appending
    assert ("/tmp/k" in a.files, b.files["/tmp/k"]) == (False, b"from b\n")


def _refusing_rm(files: FakeFiles):
    """An answer that refuses every ``rm`` on a machine, else ``files``'.

    Args:
        files (FakeFiles): the machine's files.
    """

    def answer(line: str, data: bytes | None) -> RunAnswer:
        if line.startswith("rm "):
            return failed(b"rm: cannot remove '/tmp/k': Permission denied\n")
        return files.answer(line, data)

    return answer


@pytest.mark.asyncio
async def test_a_settling_shares_the_failure_of_a_removal_under_way():
    a_files, b_files = FakeFiles(), FakeFiles()
    c_files = FakeFiles({"/tmp/k": b"old\n"})
    c = Gated("c", _refusing_rm(c_files))
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(
        table_of(
            ScriptedMachine("a", a_files.answer),
            ScriptedMachine("b", b_files.answer),
            c,
        ),
        "a",
    )
    c.armed = ("rm --", "/tmp/k")
    first = asyncio.create_task(write_on("a", vfs, spec("/k"), b"from a\n"))
    await c.held.wait()
    second = asyncio.create_task(write_on("b", vfs, spec("/k"), b"from b\n"))
    await asyncio.wait({second}, timeout=0.2)
    c.go.set()
    with pytest.raises(PermissionError):
        await first
    with pytest.raises(PermissionError):
        await second
    assert c_files.files["/tmp/k"] == b"old\n"


@pytest.mark.asyncio
async def test_a_settling_marks_a_name_a_write_is_still_choosing_a_machine_for():
    a_files, b_files = FakeFiles(), FakeFiles()
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "a")
    b.armed = ("/tmp/k", "-maxdepth 0")
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    appending = asyncio.create_task(
        write_on("b", vfs, spec("/k"), slow(), append=True)
    )
    await b.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    b.go.set()
    await pulled.wait()
    released.set()
    await appending
    assert ("/tmp/k" in a_files.files, b_files.files["/tmp/k"]) == (
        False,
        b"from b\n",
    )


async def lands_on(machine: str, origin: bool = False) -> Landing:
    """Choose ``machine`` for a write, as a mount does.

    Args:
        machine (str): the machine.
        origin (bool): the bytes come from it, so the write replaces the
            name.
    """
    return Landing(machine, origin=origin)


@pytest.mark.asyncio
async def test_a_settling_marks_a_name_a_write_begins_on_while_it_looks():
    a_files, b_files = FakeFiles({"/tmp/k": b"from a\n"}), FakeFiles()
    a = Gated("a", a_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(a, ScriptedMachine("b", b_files.answer)), "a")
    writes = LiveWrites(vfs.accessor)
    a.armed = ("/tmp/k", "-maxdepth 0")

    async def replace():
        async with writes.landing(
            spec("/k"), partial(lands_on, "a", origin=True)
        ):
            pass

    replacing = asyncio.create_task(replace())
    await a.held.wait()
    with pytest.raises(OSError):
        async with writes.landing(spec("/k"), partial(lands_on, "b")):
            b_files.files["/tmp/k"] = b"part of b\n"
            raise OSError(5, "Input/output error")
    a.go.set()
    await replacing
    assert (a_files.files["/tmp/k"], "/tmp/k" in b_files.files) == (
        b"from a\n",
        False,
    )


@pytest.mark.asyncio
async def test_a_settling_marks_a_name_another_machine_is_still_creating():
    a_files, b_files = FakeFiles(), FakeFiles()
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "a")
    b.armed = (": >>", "/tmp/k")

    async def create_on_b():
        token = running_on("b")
        try:
            await vfs.create(spec("/k"))
        finally:
            reset_caller(token)

    creating = asyncio.create_task(create_on_b())
    await b.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    b.go.set()
    await creating
    assert ("/tmp/k" in a_files.files, b_files.files["/tmp/k"]) == (False, b"")


@pytest.mark.asyncio
async def test_a_settling_takes_no_copy_away_while_a_write_chooses_its_machine():
    a_files = FakeFiles()
    b_files = FakeFiles({"/tmp/k": b"prefix\n"})
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "b")
    b.armed = ("/tmp/k", "-maxdepth 0")
    appending = asyncio.create_task(vfs.append(spec("/k"), b"suffix\n"))
    await b.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    b.go.set()
    await appending
    assert ("/tmp/k" in a_files.files, b_files.files["/tmp/k"]) == (
        False,
        b"prefix\nsuffix\n",
    )


@pytest.mark.asyncio
async def test_a_write_whose_copy_is_being_removed_chooses_again():
    a_files = FakeFiles()
    b_files = FakeFiles({"/tmp/k": b"prefix\n"})
    b_files.written["/tmp/k"] = 2 * 10**9
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "a")
    b.armed = ("rm --", "/tmp/k")
    replacing = asyncio.create_task(
        write_on("a", vfs, spec("/k"), b"from a\n")
    )
    await b.held.wait()
    appending = asyncio.create_task(vfs.append(spec("/k"), b"suffix\n"))
    await asyncio.wait({appending}, timeout=0.2)
    b.go.set()
    await asyncio.gather(replacing, appending)
    assert (a_files.files["/tmp/k"], "/tmp/k" in b_files.files) == (
        b"from a\nsuffix\n",
        False,
    )


@pytest.mark.asyncio
async def test_a_truncate_that_makes_no_file_takes_no_copy_away():
    a_files, b_files = FakeFiles(), FakeFiles()
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "b")
    b.armed = ("/tmp/k", "-maxdepth 0")
    truncating = asyncio.create_task(
        vfs.truncate(spec("/k"), 0, no_create=True)
    )
    await b.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    b.go.set()
    await truncating
    assert (a_files.files["/tmp/k"], "/tmp/k" in b_files.files) == (
        b"from a\n",
        False,
    )
