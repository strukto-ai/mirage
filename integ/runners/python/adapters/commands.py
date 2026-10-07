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
from dataclasses import replace

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.aggregators import concat_aggregate
from mirage.commands.builtin.generic_bind.adapter import CommandIO, command_io
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.config import (
    RegisteredCommand,
    command,
    registered_commands,
)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import Operand
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


class Gate:
    started = 0
    active = 0
    peak = 0
    ready: asyncio.Event | None = None


GATE = Gate()


class CommandService(RAMVFS):
    def __init__(self, metadata_only: bool = False) -> None:
        super().__init__()
        calls: list[str] = []
        handlers: list[RegisteredCommand] = []
        dropped = {"grep", "rg", "find", "du"} if metadata_only else set()
        # The service's own handlers read through a plain RAM view of its
        # store; every other read reaches the refusal below.
        view = RAMVFS()
        view.accessor = self.accessor
        own = command_io(view)
        for original in registered_commands(RAM_COMMANDS):
            if original.name in {"grep", "rg", "rev"} - dropped:
                handlers.extend(self._search(original, calls, own))
        self.overrides = frozenset(dropped | {"grep", "rg", "rev"})

        @command("calls", vfs="ram", spec=SPECS["cat"])
        async def show_calls(accessor, paths, texts, opts):
            body = "".join(line + "\n" for line in calls).encode()
            calls.clear()
            return body, IOResult()

        @command(
            "meter", vfs="ram", spec=SPECS["cat"], aggregate=concat_aggregate
        )
        async def meter(accessor, paths, texts, opts):
            return "".join(
                p.raw_path + "\n" for p in paths
            ).encode(), IOResult()

        @command("gate-status", vfs="ram", spec=SPECS["cat"])
        async def gate_status(accessor, paths, texts, opts):
            return (
                (
                    f"started={GATE.started} peak={GATE.peak} "
                    f"active={GATE.active}\n"
                ).encode(),
                IOResult(),
            )

        self._commands = handlers + registered_commands(
            [show_calls, meter, gate_status]
        )

    def _search(
        self, original: RegisteredCommand, calls: list[str], own: CommandIO
    ) -> list[RegisteredCommand]:
        @command(original.name, vfs="ram", spec=SPECS[original.name])
        async def search(accessor, paths, texts, opts):
            calls.extend(original.name + " " + p.virtual for p in paths)
            if original.name == "rev" and paths[0].virtual.endswith(".gated"):
                if GATE.ready is None:
                    GATE.ready = asyncio.Event()
                GATE.started += 1
                GATE.active += 1
                GATE.peak = max(GATE.peak, GATE.active)
                if GATE.started >= 4:
                    GATE.ready.set()
                await GATE.ready.wait()

                async def gated():
                    try:
                        yield (paths[0].raw_path + "\n").encode()
                    finally:
                        GATE.active -= 1

                return gated(), IOResult()
            if original.name == "rev" and paths[0].virtual.endswith(".slow"):

                async def slow():
                    try:
                        yield (paths[0].raw_path + "\n").encode()
                        await asyncio.Event().wait()
                    finally:
                        calls.append("closed " + paths[0].virtual)

                return slow(), IOResult()
            if original.name == "rev" and paths[0].virtual.endswith(".broken"):

                async def stream():
                    yield b"partial\n"
                    raise PermissionError(
                        13, "Permission denied", paths[0].virtual
                    )

                return stream(), IOResult()
            return await original.fn(
                accessor, paths, texts, replace(opts, io=own)
            )

        return registered_commands([search])

    def commands(self) -> list[RegisteredCommand]:
        return self._commands

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        raise PermissionError(13, "service exposes search only", path.virtual)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        if path.virtual.endswith(".deny"):
            raise PermissionError(13, "Permission denied", path.virtual)
        return await super().readdir(path, index)


async def scope_probe(inv: CLIInvocation):
    size = 0
    for path in inv.paths:
        stat, _ = await inv.doors.dispatch("stat", path)
        size += stat.size or 0
    return (
        str(size) + ":" + ",".join(p.virtual for p in inv.paths) + "\n"
    ).encode(), IOResult()


CLI = CLISpec(name="scope-probe", rest=Operand(type="path"), fn=scope_probe)
