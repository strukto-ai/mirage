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

import gzip
import json
from functools import cache
from pathlib import Path
from typing import Any, TypedDict

from mirage.commands.cli.builtin.ast_grep.config import INITIAL, PAGE
from mirage.commands.errors import UsageError
from mirage.io.errors import MemoryExhausted
from mirage.runtime.wasm.loader import wasmtime


@cache
def _module() -> tuple[Any, Any]:
    if wasmtime is None:
        raise ImportError("ast-grep requires mirage-ai[ast-grep]")
    engine = wasmtime.Engine()
    image = gzip.decompress(
        Path(__file__).with_name("engine.wasm.gz").read_bytes()
    )
    return engine, wasmtime.Module(engine, image)


class Reply(TypedDict, total=False):
    values: list[str]
    output: str
    updated: str | None
    count: int
    errors: int
    applied: int
    error: str


def process(
    options: dict[str, str | bool | None],
    data: bytes,
    room: int,
    max_memory: int,
) -> Reply:
    """Run one file with a hard limit on the guest's linear memory."""
    header = json.dumps(options).encode()
    available = room - len(header) * 3 - len(data)
    maximum = min(max_memory, available) // PAGE
    if maximum < INITIAL:
        raise MemoryExhausted()
    engine, module = _module()
    with wasmtime.Store(engine) as store:
        memory = wasmtime.Memory(
            store, wasmtime.MemoryType(wasmtime.Limits(INITIAL, maximum))
        )
        exports = wasmtime.Instance(store, module, [memory]).exports(store)
        try:
            address = exports["input"](store, len(header) + len(data))
            memory.write(store, header, address)
            if data:
                memory.write(store, data, address + len(header))
            size = exports["process"](store, len(header))
            address = exports["output"](store)
        except wasmtime.Trap as exc:
            raise UsageError(
                "ast-grep: parser resource limit exceeded", 1
            ) from exc
        if size * 4 > available - memory.data_len(store):
            raise MemoryExhausted()
        result: Reply = json.loads(memory.read(store, address, address + size))
    if "error" in result:
        raise UsageError(f"ast-grep: {result['error']}")
    return result
