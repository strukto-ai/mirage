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

import json
import os
import re
import time
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass

from mirage.core.jq.errors import JqCompileError
from mirage.core.jq.types import JqError, JqHalt
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import memory_room
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, close_stream, open_stream
from mirage.utils.timezone import TZ_VAR

FRAME_OUTPUT = 1
FRAME_ERROR = 2
FRAME_HALT = 3
FRAME_DEBUG = 4
FRAME_STDERR = 5

# The last line of jq's report of a program it refuses, which jq_eval's
# refusal to compile such a program ends in.
COMPILE_REPORT = re.compile(r"(?:\A|\n)jq: [0-9]+ compile errors?\Z")

# The error jq_eval ends a run with once it holds more than its memory.
MEMORY_REPORT = "jq memory limit of {} bytes exceeded"


def local_zone(env: Mapping[str, str] | None) -> str | None:
    """The time zone jq's local time reads, as a `TZ` value: the command
    environment's, else the process's, else the tz database zone
    /etc/localtime links to; None for a host zone with no name, which
    jq_eval reads as UTC.

    Args:
        env (Mapping[str, str] | None): the command's environment.
    """
    for zone in ((env or {}).get(TZ_VAR), os.environ.get(TZ_VAR)):
        if zone is not None:
            return zone
    _, marker, key = os.path.realpath("/etc/localtime").partition("/zoneinfo/")
    return key if marker else None


@dataclass
class Ending:
    """How a run whose outputs went out as it made them ended: the error
    or halt that stopped it, if one did."""

    stop: JqError | JqHalt | None = None


def read_frames(wire: bytes, outputs: list[bytes]) -> JqError | JqHalt | None:
    """Fold one drain of mirage-rs's jq_eval into a run: each output frame
    is a compact dump, appended to ``outputs``, a `debug` or `stderr`
    frame is dropped, and an error or a halt frame is what stopped the
    run. An error's flag byte says whether it is a string (bit 0) and
    whether the program raised it with `error` itself (bit 1).

    Args:
        wire (bytes): the frames, a tag byte and a little-endian u32
            length before each payload.
        outputs (list[bytes]): the run's outputs so far.
    """
    stop: JqError | JqHalt | None = None
    at = 0
    while at < len(wire):
        tag = wire[at]
        size = int.from_bytes(wire[at + 1 : at + 5], "little")
        payload = wire[at + 5 : at + 5 + size]
        at += 5 + size
        if tag == FRAME_OUTPUT:
            outputs.append(payload)
        elif tag == FRAME_ERROR:
            flags = payload[0]
            stop = JqError(
                payload[1:].decode(), bool(flags & 1), bool(flags & 2)
            )
        elif tag == FRAME_HALT:
            halt = json.loads(payload)
            stop = JqHalt(halt["message"], halt["string"], halt["code"])
        elif tag not in (FRAME_DEBUG, FRAME_STDERR):
            raise ValueError(f"unknown jq_eval frame {tag}")
    return stop


class Engine:
    """A program compiled once by mirage-rs's jq_eval and run on one value
    at a time on the loop's own thread, a bounded number of VM steps per
    drain, so a program that never ends still yields and its task can be
    cancelled. `input` finds no more input, `$ENV` is the given
    environment, and what `debug` and `stderr` write is dropped, as
    `gh --jq` evaluates.

    Args:
        stream (OpenStream): the compiled program.
        memory (int | None): the bytes the run may hold, what the
            workspace's ``max_memory`` had left; None for jq_eval's own.
    """

    def __init__(self, stream: OpenStream, memory: int | None) -> None:
        self._stream = stream
        self._memory = memory
        self._budget = YieldBudget()

    @classmethod
    def open(cls, expr: str, env: str, zone: str | None) -> "Engine":
        """Compile `expr`.

        Args:
            expr (str): jq program text, as typed.
            env (str): the environment `$ENV` and `env` read, as text.
            zone (str | None): the `TZ` local time reads (local_zone).

        Raises:
            JqCompileError: a program jq itself refuses, with jq's report.
        """
        limit = memory_room()
        try:
            stream = open_stream(
                "jq_eval",
                {
                    "program": expr,
                    "env": env,
                    "zone": zone,
                    **({} if limit is None else {"memory": limit}),
                },
            )
        except StreamRefusal as exc:
            if COMPILE_REPORT.search(exc.message):
                raise JqCompileError(exc.message) from exc
            raise
        return cls(stream, limit)

    async def run(self, doc: str, ending: Ending) -> AsyncGenerator[str, None]:
        """Run the program on one value, yielding each output's compact dump
        as a drain decodes it, and leave on `ending` how the run stopped.
        A run its caller stops reading is cancelled, so the next can begin.

        Args:
            doc (str): the value's JSON text.
            ending (Ending): set once the run ends.
        """
        stream = self._stream
        stream.begin({"filename": None, "line": 0})
        outputs: list[bytes] = []
        try:
            stop = read_frames(stream.feed(doc.encode()), outputs)
            stop = read_frames(stream.finish(), outputs) or stop
            while True:
                for output in outputs:
                    yield output.decode()
                outputs.clear()
                if stream.busy():
                    await self._budget.run()
                    wire = stream.drain()
                elif (asked := stream.request()) is not None:
                    op = asked[0].get("op")
                    if op == "now":
                        wire = stream.respond(
                            {"kind": "now", "now": time.time()}, b""
                        )
                    elif op == "input":
                        wire = stream.respond({"kind": "end"}, b"")
                    else:
                        raise ValueError(
                            f"jq_eval: unknown host request {asked[0]}"
                        )
                else:
                    break
                stop = read_frames(wire, outputs) or stop
        except GeneratorExit:
            if stream.cancel():
                while stream.busy():
                    await self._budget.run()
                    stream.drain()
            raise
        if (
            self._memory is not None
            and isinstance(stop, JqError)
            and stop.text == MEMORY_REPORT.format(self._memory)
        ):
            raise MemoryExhausted()
        ending.stop = stop

    async def close(self) -> None:
        """Retire a run cut short a bounded slice at a time."""
        await close_stream(self._stream)
