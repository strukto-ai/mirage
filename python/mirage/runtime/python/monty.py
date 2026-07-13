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

from __future__ import annotations

import asyncio
from pathlib import PurePosixPath
from typing import Callable

try:
    import pydantic_monty
    from pydantic_monty import MemoryFile, MontyFileHandle, OSAccess
    from pydantic_monty.os_access import path_from_arg
except ImportError:
    pydantic_monty = None  # type: ignore[assignment]
    MemoryFile = None  # type: ignore[misc, assignment]
    MontyFileHandle = None  # type: ignore[misc, assignment]
    OSAccess = object  # type: ignore[misc, assignment]
    path_from_arg = None  # type: ignore[assignment]

from mirage.runtime.python.base import (PythonRunArgs, PythonRunResult,
                                        PythonRuntime)
from mirage.types import PathSpec


class _MirageOS(OSAccess):
    """Monty OS bridge that lazily backfills files from the workspace.

    Reads materialize the file into the in-memory tree on first touch;
    writes go through the tree first (Monty's own open/append semantics)
    and are then flushed back through the dispatch. Runs on Monty's
    worker thread, so async dispatch calls hop to the workspace loop via
    `run_coroutine_threadsafe`.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop,
                 dispatch: Callable | None, environ: dict[str, str]) -> None:
        super().__init__([], environ=dict(environ))
        self._loop = loop
        self._workspace_dispatch = dispatch
        self._missing: set[str] = set()

    def _sync(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def _fetch(self, virtual: str) -> bytes | None:
        if self._workspace_dispatch is None or virtual in self._missing:
            return None
        try:
            data, _ = self._sync(
                self._workspace_dispatch("read",
                                         PathSpec.from_str_path(virtual)))
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            self._missing.add(virtual)
            return None
        if isinstance(data, str):
            return data.encode()
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        return None

    def _list_remote(self, virtual: str) -> list[str] | None:
        if self._workspace_dispatch is None:
            return None
        try:
            names, _ = self._sync(
                self._workspace_dispatch("readdir",
                                         PathSpec.from_str_path(virtual)))
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            return None
        return list(names)

    def _flush(self, path: PurePosixPath) -> None:
        if self._workspace_dispatch is None:
            return
        entry = self._get_entry(path)
        if entry is None or isinstance(entry, dict):
            return
        content = entry.read_content()
        data = content.encode() if isinstance(content, str) else bytes(content)
        self._sync(
            self._workspace_dispatch("write",
                                     PathSpec.from_str_path(str(path)),
                                     data=data))
        self._missing.discard(str(path))

    def _insert_tree_dir(self, path: PurePosixPath) -> dict | None:
        subtree = self._tree
        for part in path.parts:
            entry = subtree.setdefault(part, {})
            if not isinstance(entry, dict):
                return None
            subtree = entry
        return subtree

    def _ensure_file(self, path: PurePosixPath) -> None:
        if self._get_entry(path) is not None:
            return
        data = self._fetch(str(path))
        if data is None:
            return
        parent = self._insert_tree_dir(path.parent)
        if parent is None:
            return
        memory = MemoryFile(path, data)
        parent[path.name] = memory
        self.files.append(memory)

    def _ensure_dir(self, path: PurePosixPath) -> None:
        entry = self._get_entry(path)
        if entry is not None:
            return
        if self._list_remote(str(path)) is None:
            return
        self._insert_tree_dir(path)

    def path_exists(self, path: PurePosixPath) -> bool:
        self._ensure_file(path)
        if super().path_exists(path):
            return True
        self._ensure_dir(path)
        return super().path_exists(path)

    def path_is_file(self, path: PurePosixPath) -> bool:
        self._ensure_file(path)
        return super().path_is_file(path)

    def path_is_dir(self, path: PurePosixPath) -> bool:
        self._ensure_dir(path)
        return super().path_is_dir(path)

    def path_stat(self, path: PurePosixPath):
        self._ensure_file(path)
        self._ensure_dir(path)
        return super().path_stat(path)

    def path_iterdir(self, path: PurePosixPath) -> list[PurePosixPath]:
        remote = self._list_remote(str(path))
        if remote is None:
            return super().path_iterdir(path)
        self._insert_tree_dir(path)
        merged = {str(p): p for p in super().path_iterdir(path)}
        for name in remote:
            child = path / name.rstrip("/")
            merged.setdefault(str(child), child)
        return sorted(merged.values())

    def path_open(self, path: PurePosixPath, mode: str) -> MontyFileHandle:
        self._ensure_file(path)
        if any(c in mode for c in ("w", "a", "x", "+")):
            self._ensure_dir(path.parent)
        return super().path_open(path, mode)

    def path_read_text(self, path: PurePosixPath | MontyFileHandle) -> str:
        self._ensure_file(path_from_arg(path))
        return super().path_read_text(path)

    def path_read_bytes(self, path: PurePosixPath | MontyFileHandle) -> bytes:
        self._ensure_file(path_from_arg(path))
        return super().path_read_bytes(path)

    def path_write_text(self, path: PurePosixPath | MontyFileHandle,
                        data: str) -> int:
        self._ensure_dir(path_from_arg(path).parent)
        out = super().path_write_text(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_write_bytes(self, path: PurePosixPath | MontyFileHandle,
                         data: bytes) -> int:
        self._ensure_dir(path_from_arg(path).parent)
        out = super().path_write_bytes(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_append_text(self, path: PurePosixPath | MontyFileHandle,
                         data: str) -> int:
        self._ensure_file(path_from_arg(path))
        out = super().path_append_text(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_append_bytes(self, path: PurePosixPath | MontyFileHandle,
                          data: bytes) -> int:
        self._ensure_file(path_from_arg(path))
        out = super().path_append_bytes(path, data)
        self._flush(path_from_arg(path))
        return out

    def path_unlink(self, path: PurePosixPath) -> None:
        self._ensure_file(path)
        super().path_unlink(path)
        if self._workspace_dispatch is not None:
            self._sync(
                self._workspace_dispatch("unlink",
                                         PathSpec.from_str_path(str(path))))
            self._missing.add(str(path))


class MontyRuntime(PythonRuntime):
    """Run Python code on the Monty sandboxed interpreter.

    Code executes in Monty's Rust interpreter: no host filesystem,
    environment, or network access. File I/O and `os.environ` are
    serviced through the injected workspace dispatch, so the code sees
    the workspace mounts and nothing else. Command-line arguments are
    exposed as the `argv` global (`argv[0]` is the script name). Monty
    implements a Python subset; host-only features (`sys.stdin`,
    `sys.argv`, third-party imports) are unavailable — use the `local`
    runtime for those.
    """

    name = "monty"

    def __init__(self, dispatch: Callable | None = None) -> None:
        if pydantic_monty is None:
            raise ImportError(
                "the monty runtime requires the 'monty' extra. Install with: "
                "pip install mirage-ai[monty], or select the 'local' runtime")
        self._workspace_dispatch = dispatch

    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        loop = asyncio.get_running_loop()
        return await asyncio.to_thread(self._run_sync, args, loop)

    def _run_sync(self, args: PythonRunArgs,
                  loop: asyncio.AbstractEventLoop) -> PythonRunResult:
        collector = pydantic_monty.CollectStreams()
        bridge = _MirageOS(loop, self._workspace_dispatch, args.env)
        try:
            monty = pydantic_monty.Monty(args.code, inputs=["argv"])
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback") + "\n"
            return PythonRunResult(stdout=b"",
                                   stderr=trace.encode(),
                                   exit_code=1)
        argv = ["main.py", *args.args]
        try:
            monty.run(inputs={"argv": argv},
                      print_callback=collector,
                      os=bridge)
        except pydantic_monty.MontyRuntimeError as exc:
            stdout, stderr = _split_streams(collector)
            trace = exc.display(format="traceback") + "\n"
            return PythonRunResult(stdout=stdout,
                                   stderr=(stderr or b"") + trace.encode(),
                                   exit_code=1)
        stdout, stderr = _split_streams(collector)
        return PythonRunResult(stdout=stdout, stderr=stderr, exit_code=0)


def _split_streams(
        collector: pydantic_monty.CollectStreams
) -> tuple[bytes, bytes | None]:
    out: list[str] = []
    err: list[str] = []
    for stream, text in collector.output:
        if stream == "stderr":
            err.append(text)
        else:
            out.append(text)
    stderr = "".join(err).encode() if err else None
    return "".join(out).encode(), stderr
