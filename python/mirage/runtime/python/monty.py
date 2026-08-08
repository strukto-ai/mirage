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
import errno
import logging
import os
import signal
from collections.abc import Sequence
from pathlib import PurePosixPath
from typing import Any, Callable

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import CrossMountError, EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import (DispatchFn, EvalResult, EvalValue,
                                  PrefixSource, RunArgs, RunResult,
                                  ScriptSource)
from mirage.runtime.vfs import RuntimeVFS

logger = logging.getLogger(__name__)

pydantic_monty: Any
MemoryFile: Any
MontyFileHandle: Any
OSAccess: Any
path_from_arg: Any
try:
    import pydantic_monty as _pydantic_monty
    from pydantic_monty import MemoryFile as _MemoryFile
    from pydantic_monty import MontyFileHandle as _MontyFileHandle
    from pydantic_monty import OSAccess as _OSAccess
    from pydantic_monty.os_access import path_from_arg as _path_from_arg
except ImportError:
    pydantic_monty = None
    MemoryFile = None
    MontyFileHandle = None
    OSAccess = object
    path_from_arg = None
else:
    pydantic_monty = _pydantic_monty
    MemoryFile = _MemoryFile
    MontyFileHandle = _MontyFileHandle
    OSAccess = _OSAccess
    path_from_arg = _path_from_arg


class MontyVFS:
    """Monty's mount view: the shared core plus a negative cache.

    Monty asks whether a path exists on nearly every guest expression,
    so a path the mount already answered "not there" for must not cost
    a second dispatch. Reads and listings return None for a miss rather
    than raising, which is the shape the encoder above wants, and every
    mutation keeps the cache honest.

    Args:
        core (RuntimeVFS | None): the shared op vocabulary, or None
            when the runtime was built without a workspace.
    """

    def __init__(self, core: RuntimeVFS | None) -> None:
        self._core = core
        self._missing: set[str] = set()

    @property
    def wired(self) -> bool:
        """True when a workspace dispatch is reachable."""
        return self._core is not None

    def mount_of(self, path: PurePosixPath) -> str | None:
        if self._core is None:
            return None
        return self._core.mount_of(str(path))

    def read(self, virtual: str) -> bytes | None:
        """The file's bytes, or None when the mount does not have it."""
        if self._core is None or virtual in self._missing:
            return None
        try:
            return self._core.read(virtual)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            self._missing.add(virtual)
            return None

    def readdir(self, virtual: str) -> list[str] | None:
        """The directory's entries, or None when it is not a directory."""
        if self._core is None:
            return None
        try:
            return self._core.readdir(virtual)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError,
                ValueError):
            return None

    def write(self, virtual: str, data: bytes) -> None:
        if self._core is None:
            return
        self._core.write(virtual, data)
        self._missing.discard(virtual)

    def append(self, virtual: str, data: bytes, whole: bytes) -> None:
        """Ship only `data`, falling back to writing `whole`.

        Args:
            virtual (str): the file being appended to.
            data (bytes): only the newly appended bytes.
            whole (bytes): full content, for a mount with no append op.
        """
        if self._core is None:
            return
        self._core.append(virtual, data, whole)
        self._missing.discard(virtual)

    def mkdir(self, virtual: str, parents: bool) -> None:
        if self._core is None:
            return
        self._core.call("mkdir", virtual, parents=parents)
        self._missing.discard(virtual)

    def rmdir(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.rmdir(virtual)
        self._missing.add(virtual)

    def unlink(self, virtual: str) -> None:
        if self._core is None:
            return
        self._core.unlink(virtual)
        self._missing.add(virtual)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): the source path.
            dst (str): the destination path.

        Raises:
            CrossMountError: the two ends live on different mounts.
        """
        if self._core is None:
            return
        self._core.rename(src, dst)
        self._missing.add(src)
        self._missing.discard(dst)


class _MirageOS(OSAccess):
    """Monty OS bridge that lazily backfills files from the workspace.

    Reads materialize the file into the in-memory tree on first touch;
    writes go through the tree first (Monty's own open/append semantics)
    and are then flushed back through `MontyVFS`. Runs on Monty's worker
    thread, so every op hops to the workspace loop inside the core.

    The binding only accepts sync callbacks (pydantic/monty#560), so the
    core's hop parks the tokio worker for the whole I/O wait. That caps
    concurrent I/O-waiting runs at Monty's worker pool size, which is
    the core count by default; TOKIO_WORKER_THREADS raises it, and
    parked workers cost stack pages, not CPU (measured: 100 concurrent
    1s-I/O runs finish in ~2s at 64 workers versus ~8s at 14).
    """

    def __init__(
            self,
            loop: asyncio.AbstractEventLoop,
            dispatch: Callable[..., Any] | None,
            environ: dict[str, str],
            mount_prefixes: Callable[[], list[str]] | None = None) -> None:
        super().__init__([], environ=dict(environ))
        core = (RuntimeVFS(dispatch, loop, mount_prefixes)
                if dispatch is not None else None)
        self._vfs = MontyVFS(core)

    def _mount_of(self, path: PurePosixPath) -> str | None:
        return self._vfs.mount_of(path)

    def _fetch(self, virtual: str) -> bytes | None:
        return self._vfs.read(virtual)

    def _list_remote(self, virtual: str) -> list[str] | None:
        return self._vfs.readdir(virtual)

    def _tree_bytes(self, path: PurePosixPath) -> bytes | None:
        entry = self._get_entry(path)
        if entry is None or isinstance(entry, dict):
            return None
        content = entry.read_content()
        return content.encode() if isinstance(content, str) else bytes(content)

    def _flush(self, path: PurePosixPath) -> None:
        data = self._tree_bytes(path)
        if data is None:
            return
        self._vfs.write(str(path), data)

    def _append_remote(self, path: PurePosixPath, data: bytes) -> None:
        """Send only the appended bytes when the mount can take them.

        Monty hands an append hook the new text alone, so a mount with
        its own append op carries just that. Flushing instead re-sends
        every byte written so far, which turns a write loop quadratic:
        200 appends of one short line shipped 164 KB to build a 1.7 KB
        file before this.

        Args:
            path (PurePosixPath): the file being appended to.
            data (bytes): only the newly appended bytes.
        """
        whole = self._tree_bytes(path)
        if whole is None:
            return
        self._vfs.append(str(path), data, whole)

    def _insert_tree_dir(self, path: PurePosixPath) -> dict[str, Any] | None:
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
        self._append_remote(path_from_arg(path), data.encode())
        return out

    def path_append_bytes(self, path: PurePosixPath | MontyFileHandle,
                          data: bytes) -> int:
        self._ensure_file(path_from_arg(path))
        out = super().path_append_bytes(path, data)
        self._append_remote(path_from_arg(path), bytes(data))
        return out

    def path_mkdir(self, path: PurePosixPath, parents: bool,
                   exist_ok: bool) -> None:
        """Create a directory on the mount, keeping pathlib's flags.

        `parents` rides through to the backend op, which takes it;
        `exist_ok` is answered here, since the op has no such argument
        and backends differ on whether creating an existing directory
        raises at all.

        `exist_ok` forgives an existing *directory* only. A file at the
        target still raises, which is pathlib's rule and monty's own
        base implementation's: `_is_file` is checked before `exist_ok`
        is consulted. The file is materialized first so one already
        read into the tree and one still only on the mount answer the
        same; the probe costs a read that `_missing` then caches.

        Args:
            path (PurePosixPath): the directory to create.
            parents (bool): create missing ancestors too.
            exist_ok (bool): stay quiet when it already exists.
        """
        self._ensure_dir(path.parent)
        if not self._vfs.wired:
            super().path_mkdir(path, parents, exist_ok)
            return
        self._ensure_file(path)
        entry = self._get_entry(path)
        if entry is not None and not isinstance(entry, dict):
            raise FileExistsError(f"[Errno 17] File exists: {str(path)!r}")
        if entry is not None or self._list_remote(str(path)) is not None:
            if exist_ok:
                self._insert_tree_dir(path)
                return
            raise FileExistsError(f"[Errno 17] File exists: {str(path)!r}")
        self._vfs.mkdir(str(path), parents)
        self._insert_tree_dir(path)

    def path_rmdir(self, path: PurePosixPath) -> None:
        self._ensure_dir(path)
        self._vfs.rmdir(str(path))
        super().path_rmdir(path)

    def path_rename(self, path: PurePosixPath, target: PurePosixPath) -> None:
        """Rename within one mount, refusing to cross mounts.

        The dispatcher picks the mount from the source alone and hands
        the destination to that same backend, which reads it against
        its own keyspace: a cross-mount rename would drop the source
        and write the target into the wrong store. EXDEV is what POSIX
        answers for a rename across filesystems, so the failure is the
        familiar one and the copy-and-delete workaround is the known
        one. Monty ships no `shutil`, so its own code has to write that
        fallback by hand; the runtimes with a real stdlib get it from
        `shutil.move`, which retries on exactly this errno.

        Args:
            path (PurePosixPath): the source path.
            target (PurePosixPath): the destination path.

        Raises:
            OSError: EXDEV when source and target live on different
                mounts.
        """
        self._ensure_file(path)
        self._ensure_dir(path)
        try:
            self._vfs.rename(str(path), str(target))
        except CrossMountError as exc:
            # pathlib's answer for a rename across filesystems, so the
            # failure is the familiar one and the copy-and-delete
            # workaround is the known one.
            raise OSError(errno.EXDEV, "Invalid cross-device link", str(path),
                          None, str(target)) from exc
        super().path_rename(path, target)

    def path_unlink(self, path: PurePosixPath) -> None:
        self._ensure_file(path)
        super().path_unlink(path)
        self._vfs.unlink(str(path))


class MontyRuntime(PythonRuntime, EvaluatorMixin):
    """Run Python code on the Monty sandboxed interpreter.

    Code executes in Monty's Rust interpreter, inside a pooled worker
    subprocess: no host filesystem, environment, or network access, and
    an interpreter crash costs a worker rather than this process. File
    I/O and `os.environ` are serviced through the injected workspace
    dispatch, so the code sees the workspace mounts and nothing else.
    Command-line arguments are exposed as the `argv` global (`argv[0]`
    is the script name) and piped input as the `stdin` global (bytes,
    None when nothing was piped). Monty implements a Python subset;
    host-only features (`sys.stdin`, `sys.argv`, third-party imports)
    are unavailable, and the stdlib is json/re/math/datetime/typing —
    use the `local` runtime for those.
    """

    name = "monty"

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        if pydantic_monty is None:
            raise ImportError(
                "the monty runtime requires the 'monty' extra. Install with: "
                "pip install mirage-ai[monty], or select the 'local' runtime")
        super().__init__(captures, config, script)
        self._workspace_dispatch: DispatchFn | None = None
        self._mount_prefixes: PrefixSource | None = None
        self._eval_sessions: dict[str, Any] = {}
        self._pool: Any = None
        self._pool_task: asyncio.Task[Any] | None = None

    def attach(self, dispatch: DispatchFn,
               mount_prefixes: PrefixSource) -> None:
        if self._workspace_dispatch is None:
            self._workspace_dispatch = dispatch
            self._mount_prefixes = mount_prefixes

    async def _ensure_pool(self) -> Any:
        """The runtime's worker pool, spawned on first use.

        One pool per runtime instance, which is one per workspace world:
        it keeps `request_timeout` and the process cap per workspace
        rather than global. The pool spawns `min_processes` workers
        eagerly and reuses one across sequential checkouts, so an idle
        workspace costs a single worker.

        Creation is cached as a task, not guarded by an `is None`
        check: two commands reaching a cold runtime together would both
        see no pool and both await `__aenter__`, and only the last
        assignment stays reachable, so `close()` could not stop the
        other pool's workers. Mirrors the TypeScript runtime's
        `poolPromise`.
        """
        if self._pool is not None:
            return self._pool
        if self._pool_task is None:
            self._pool_task = asyncio.ensure_future(self._open_pool())
        self._pool = await self._pool_task
        return self._pool

    async def _open_pool(self) -> Any:
        pool = pydantic_monty.AsyncMonty()
        await pool.__aenter__()
        return pool

    async def run(self, args: RunArgs) -> RunResult:
        # Execution lives in a monty worker subprocess (0.0.19 moved it
        # out of process so an interpreter crash cannot take the host
        # with it). feed_run awaits off the event loop, so the loop
        # stays free; a dead or timed-out worker surfaces as
        # MontyCrashedError and the pool replaces it.
        loop = asyncio.get_running_loop()
        collector = pydantic_monty.CollectStreams()
        bridge = _MirageOS(loop, self._workspace_dispatch, args.env,
                           self._mount_prefixes)
        pool = await self._ensure_pool()
        # argv[0] is the program's own name when the caller has one (a
        # CLI install's head word), else the interpreter's placeholder.
        argv = [args.prog or "main.py", *args.args]
        # Monty has no `sys.stdin`, so piped bytes ride in as a global
        # the same way argv does: raw bytes, None when nothing was piped.
        inputs = {"argv": argv, "stdin": args.stdin}
        try:
            async with pool.checkout() as session:
                # Read the pid before the turn starts: the getter reports
                # None while a turn is in flight, and cancelling the await
                # does NOT stop the worker (0.0.19 runs it in its own
                # process). Without the kill, a safeguard timeout would
                # report exit 124 and leave the worker spinning forever,
                # and pool teardown would block on it uninterruptibly.
                worker_pid = session.worker_pid
                try:
                    await session.feed_run(args.code,
                                           inputs=inputs,
                                           print_callback=collector,
                                           os=bridge)
                except asyncio.CancelledError:
                    _kill_worker(worker_pid)
                    raise
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback") + "\n"
            return RunResult(stdout=b"", stderr=trace.encode(), exit_code=1)
        except pydantic_monty.MontyRuntimeError as exc:
            stdout, stderr = _split_streams(collector)
            trace = exc.display(format="traceback") + "\n"
            return RunResult(stdout=stdout,
                             stderr=(stderr or b"") + trace.encode(),
                             exit_code=1)
        except pydantic_monty.MontyCrashedError as exc:
            stdout, stderr = _split_streams(collector)
            reason = ("timed out" if exc.timed_out else "crashed")
            note = f"{self.name}: worker {reason}\n"
            return RunResult(stdout=stdout,
                             stderr=(stderr or b"") + note.encode(),
                             exit_code=1)
        stdout, stderr = _split_streams(collector)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=0)

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        """Evaluate code; the last expression is the value.

        One-shot mode checks a worker out for the feed and hands it
        straight back; a session id keeps its own worker (heap and
        namespace) alive per id, which is the console. Inputs bind as
        globals via monty's native mechanism, and the code sees
        workspace files through the same bridge agent code uses. The
        value crosses the worker boundary as a converted Monty value:
        dicts, lists, strings, numbers, bools and None arrive as their
        Python equivalents, which is every shape a policy verdict
        takes.

        Args:
            code (str): the python source.
            inputs (dict[str, EvalValue] | None): named globals.
            session (str | None): console session id, None for
                one-shot.

        Raises:
            EvalError: the code failed to parse or raised; the
                message is monty's own traceback.
        """
        loop = asyncio.get_running_loop()
        collector = pydantic_monty.CollectStreams()
        bridge = _MirageOS(loop, self._workspace_dispatch, {},
                           self._mount_prefixes)
        pool = await self._ensure_pool()
        repl = self._eval_sessions.get(session) if session is not None \
            else None
        # A checked-out session owns a worker for its lifetime, so the
        # one-shot arm hands its worker back as soon as the feed ends
        # while a console session keeps its own until close().
        one_shot = repl is None and session is None
        if repl is None:
            repl = await pool.checkout().__aenter__()
            if session is not None:
                self._eval_sessions[session] = repl
        worker_pid = repl.worker_pid
        try:
            value = await repl.feed_run(code,
                                        inputs=dict(inputs or {}),
                                        print_callback=collector,
                                        os=bridge)
        except asyncio.CancelledError:
            # Same reclaim as run(): cancelling the await leaves the
            # worker running. A console session loses its heap with the
            # worker, so drop it and let the next eval check out a
            # fresh one rather than address a dead process.
            _kill_worker(worker_pid)
            if session is not None:
                self._eval_sessions.pop(session, None)
            # The checkout was entered by hand, so dropping the session
            # is not enough: without this the pool keeps a lease that
            # close() can no longer reach, and repeated cancellations
            # exhaust its capacity.
            await _release(repl)
            raise
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback")
            # Console continuation, not a broken program: the source
            # merely stopped early (an open block or unclosed suite).
            incomplete = ("unexpected EOF" in trace
                          or "Expected an indented block" in trace)
            if session is not None:
                if incomplete:
                    return EvalResult(status="incomplete")
                return EvalResult(stderr=(trace + "\n").encode(), exit_code=1)
            raise EvalError(trace, syntax=True)
        except pydantic_monty.MontyRuntimeError as exc:
            trace = exc.display(format="traceback")
            if session is not None:
                stdout, stderr = _split_streams(collector)
                return EvalResult(stdout=stdout,
                                  stderr=(stderr or b"") +
                                  (trace + "\n").encode(),
                                  exit_code=1)
            raise EvalError(trace)
        finally:
            if one_shot:
                await repl.__aexit__(None, None, None)
        stdout, stderr = _split_streams(collector)
        return EvalResult(value=value, stdout=stdout, stderr=stderr)

    async def close(self) -> None:
        for repl in self._eval_sessions.values():
            await _release(repl)
        self._eval_sessions.clear()
        # A pool still being opened must be awaited before teardown, or
        # its workers outlive the runtime that asked for them.
        if self._pool is None and self._pool_task is not None:
            self._pool = await self._pool_task
        self._pool_task = None
        if self._pool is not None:
            await self._pool.__aexit__(None, None, None)
            self._pool = None


async def _release(repl: Any) -> None:
    """Hand a checked-out session back, even a poisoned one.

    Args:
        repl (Any): the checked-out monty session.
    """
    try:
        await repl.__aexit__(None, None, None)
    except Exception as exc:
        # The worker is already gone in the cancel path; the lease
        # still has to be returned, so note it and move on.
        logger.debug("monty session release failed: %s", exc)


def _kill_worker(pid: int | None) -> None:
    """Stop a monty worker whose turn was cancelled.

    Args:
        pid (int | None): the worker process id, None when the pool
            had not attached one yet.
    """
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        # Already gone: the turn finished between the cancel and here.
        logger.debug("monty worker %s already exited", pid)


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
