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

import os
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.python.wasi.runtime import WASI_HOME_ENV
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.table import build_runtime
from mirage.runtime.types import RunArgs
from mirage.types import ContentType, FileStat, FileType


def _wasi_available() -> bool:
    root = os.environ.get(WASI_HOME_ENV)
    return bool(root) and (Path(root) / "python.wasm").is_file()


def _quickjs_available() -> bool:
    root = os.environ.get(QUICKJS_HOME_ENV)
    return bool(root) and (Path(root) / "qjs-wasi.wasm").is_file()


wasi_live = pytest.mark.skipif(
    not _wasi_available(),
    reason=f"{WASI_HOME_ENV} does not point at a CPython WASI build",
)
quickjs_live = pytest.mark.skipif(
    not _quickjs_available(),
    reason=f"{QUICKJS_HOME_ENV} does not point at a quickjs WASI build",
)


@dataclass
class CountingDispatch:
    """Dispatch stub that records every op and the bytes it carried.

    The seam for the append row: every runtime takes the dispatch as an
    injected callable, so byte accounting needs no new hook. Supports
    the full op vocabulary the runtimes emit, which both tiers now
    reach through RuntimeFiles.

    Args:
        files (dict[str, bytes]): initial virtual file contents.
    """

    files: dict[str, bytes]
    dirs: set[str] = field(default_factory=set)
    ops: list[tuple[str, str, int]] = field(default_factory=list)

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        payload = kwargs.get("data")
        size = len(payload) if payload is not None else 0
        self.ops.append((op, virtual, size))
        if op == "read":
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "stat":
            return self._stat(virtual), None
        if op == "readdir":
            prefix = virtual.rstrip("/") + "/"
            names = {
                p[len(prefix) :].split("/")[0]
                for p in self.files
                if p.startswith(prefix)
            }
            return sorted(names), None
        if op == "write":
            self.files[virtual] = bytes(payload)
            return None, None
        if op == "append":
            self.files[virtual] = self.files.get(virtual, b"") + bytes(payload)
            return None, None
        if op == "create":
            self.files.setdefault(virtual, b"")
            return None, None
        if op == "truncate":
            self.files[virtual] = b""
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            return None, None
        if op == "mkdir":
            self.dirs.add(virtual)
            return None, None
        if op == "rmdir":
            self.dirs.discard(virtual)
            return None, None
        if op == "rename":
            dst = kwargs["dst"].virtual
            self.files[dst] = self.files.pop(virtual)
            return None, None
        raise ValueError(f"unexpected op {op}")

    def _stat(self, virtual: str) -> FileStat:
        if virtual in self.files:
            return FileStat(
                name=virtual.rsplit("/", 1)[-1],
                size=len(self.files[virtual]),
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        trimmed = virtual.rstrip("/")
        is_dir = trimmed in self.dirs or any(
            p.startswith(trimmed + "/") for p in self.files
        )
        if not is_dir:
            raise FileNotFoundError(virtual)
        return FileStat(
            name=trimmed.rsplit("/", 1)[-1], type=FileType.DIRECTORY
        )

    def mutation_bytes(self) -> int:
        return sum(
            size
            for op, _, size in self.ops
            if op in ("write", "append", "create", "truncate")
        )

    def mutation_ops(self) -> list[str]:
        return [
            op
            for op, _, _ in self.ops
            if op in ("write", "append", "create", "truncate")
        ]


APPEND_LOOP_PY = (
    "for i in range(8):\n"
    "    with open('/data/log.txt', 'a') as f:\n"
    "        f.write('xyz')"
)
APPEND_LOOP_JS = (
    "for (let i = 0; i < 8; i++) { "
    "const w = std.open('/data/log.txt', 'a'); "
    "w.puts('xyz'); w.close() }"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime",
    [
        pytest.param("monty"),
        pytest.param("wasi", marks=wasi_live),
        pytest.param("quickjs", marks=quickjs_live),
    ],
)
async def test_append_ships_only_the_deltas(runtime: str):
    """Eight appends of three bytes must ship 24 bytes, not O(n^2).

    The dispatch is counted rather than the outcome compared: every
    amplifying runtime still produces the right final content, so the
    file alone cannot distinguish one append from a full rewrite per
    close.

    Args:
        runtime (str): registry name of the runtime under test.
    """
    dispatch = CountingDispatch({"/data/log.txt": b"S" * 64})
    rt = build_runtime(runtime)
    rt.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: ["/data/"])))
    code = APPEND_LOOP_JS if runtime == "quickjs" else APPEND_LOOP_PY
    result = await rt.run(RunArgs(code=code))
    await rt.close()
    assert result.exit_code == 0, result.stderr
    assert dispatch.files["/data/log.txt"] == b"S" * 64 + b"xyz" * 8
    assert dispatch.mutation_bytes() == 24, dispatch.mutation_ops()
