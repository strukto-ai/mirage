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

from collections.abc import Sequence
from pathlib import Path
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.runtime.config import RuntimeConfig, memory_limit, resolve_home
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.execution import main_filename, prepare_source
from mirage.runtime.python.flags import init_argv
from mirage.runtime.python.wasi.config import WasiConfig
from mirage.runtime.types import (
    FilesystemOperation,
    Program,
    RunResult,
    RuntimeReach,
)
from mirage.runtime.wasm import WasmExecution, WasmView
from mirage.runtime.wasm.loader import wasmtime

WASI_HOME_ENV = "MIRAGE_WASI_HOME"

_BUILD_HINT = (
    "the wasi runtime needs a CPython WASI build directory (python.wasm "
    "plus lib/): download one from "
    "https://github.com/brettcannon/cpython-wasi-build/releases, unzip it, "
    "and point the runtime entry's config `home` (yaml `runtimes: [{name: "
    f"wasi, config: {{home: ...}}}}]`) or the {WASI_HOME_ENV} environment "
    "variable at the directory"
)


def _stdlib_mount(prefixes: Sequence[str]) -> str | None:
    """The mount prefix that covers the build's standard library, if the
    workspace has one: ``/lib`` itself, or anything under
    ``/lib/python``. A mount prefix wins over the build directory, so it
    would hide the library the interpreter starts from; a mount
    elsewhere under ``/lib`` (``/lib/app``) leaves it alone.

    Args:
        prefixes (Sequence[str]): the workspace mount prefixes.
    """
    return next(
        (
            p
            for p in prefixes
            if p.rstrip("/") == "/lib" or p.startswith("/lib/python")
        ),
        None,
    )


class WasiRuntime(PythonRuntime[WasmExecution]):
    """Run Python code on a WASI CPython under wasmtime, in-process.

    Full CPython (classes, complete stdlib, real `sys`) inside a wasm
    sandbox: no host filesystem, no network, only the environment the
    run passes. The guest's filesystem imports are intercepted, so
    `open('/data/f.txt')` inside the code routes through the workspace
    dispatch — the same cache, write modes, and session narrowing as
    shell commands — while the interpreter's own build directory is
    served read-only from the host. Workspace mounts are therefore
    visible to the code with no FUSE mount and no extra setup; without
    an injected dispatch, only the build directory is visible.

    Runs execute on a worker thread with the GIL released, and each run
    leases its own epoch-interruption engine: cancelling the `run` task
    bumps the epoch, which traps the run and reclaims the thread, so a
    limit timeout stops the interpreter instead of leaking it.

    The build directory comes from the config `home` (the yaml entry's
    ``config`` block ends up here) or the MIRAGE_WASI_HOME environment
    variable. It is read-only inside the sandbox; guest writes land in
    the workspace or answer EACCES, never in the bundle.
    """

    name = "wasi"
    version_suffix = " (wasi)"
    # Guest file I/O can only travel the workspace bridge; the one
    # host surface is the interpreter's own build directory, served
    # read-only (mutations raise PermissionError in WasmView), so
    # nothing goes around the gate.
    reach: RuntimeReach = "workspace"
    filesystem: ClassVar[tuple[FilesystemOperation, ...]] = (
        "read",
        "write",
        "list",
        "stat",
        "glob",
    )

    config_cls: ClassVar[type[RuntimeConfig]] = WasiConfig
    config: WasiConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: WasiConfig | dict[str, Any] | None = None,
    ) -> None:
        if wasmtime is None:
            raise ImportError(
                "the wasi runtime requires the 'wasi' extra. Install with: "
                "pip install mirage-ai[wasi], or select another runtime"
            )
        super().__init__(captures, config)
        root = resolve_home(self.config, WASI_HOME_ENV)
        if not root:
            raise FileNotFoundError(_BUILD_HINT)
        self._root = Path(root)
        if not (self._root / "python.wasm").is_file():
            raise FileNotFoundError(
                f"no python.wasm under {self._root}; {_BUILD_HINT}"
            )
        if not any((self._root / "lib").glob("python3.*")):
            raise FileNotFoundError(
                f"no lib/python3.* under {self._root}; {_BUILD_HINT}"
            )

    async def open_engine(self) -> WasmExecution:
        return WasmExecution(
            self._root / "python.wasm",
            "python3",
            memory_limit(self.config.max_memory),
        )

    async def close_engine(self, engine: WasmExecution) -> None:
        await engine.close()

    async def interpret(
        self, engine: WasmExecution, program: Program, ctx: Context
    ) -> RunResult:
        files = RuntimeFiles.of(ctx, self._binding)
        hiding = _stdlib_mount(files.prefixes()) if files is not None else None
        if hiding is not None:
            return RunResult(
                stdout=b"",
                stderr=(
                    f"mirage: the {self.name} runtime cannot run with a mount "
                    f"at '{hiding}', which hides the interpreter's standard "
                    "library at /lib\n"
                ).encode(),
                exit_code=126,
            )
        # Mount prefixes route to the workspace bridge; everything else
        # is served from the build directory, so a mount at "/" never
        # collides with the interpreter's own files.
        fs = WasmView(str(self._root), files)
        # The guest sees the mounts, so the script's own directory heads
        # sys.path, as it does on CPython.
        cwd = ctx.cwd
        source = prepare_source(program, cwd, search_path=True)
        filename = (
            main_filename(program, cwd)
            or (program.prog if program.script_cli else None)
            or "<string>"
        )
        if source == program.code:
            source = f"exec(compile({program.code!r}, {filename!r}, 'exec'), globals())"
        preamble = f"__import__('os').chdir({cwd.virtual!r})\n"
        source = (
            f"__import__('linecache').cache[{filename!r}] = "
            f"({len(program.code)}, None, "
            f"{program.code.splitlines(keepends=True)!r}, "
            f"{filename!r})\n"
            "__import__('sys').excepthook = (lambda hook: lambda t, v, tb: "
            "hook(t, v, tb) if tb is None or tb.tb_frame.f_back is not None "
            "else hook(t, v.with_traceback(tb.tb_next), tb.tb_next))"
            "(__import__('sys').excepthook)\n" + preamble + source
        )
        # sys.argv becomes [prog, *program.args], matching the local runtime.
        stdout, stderr, exit_code = await engine.run(
            argv=[
                "python",
                *init_argv(ctx.flags),
                "-c",
                source,
                *program.args,
            ],
            stdin=program.stdin,
            # The build directory is the prefix, so the stdlib is found
            # under /lib on its own and a session's PYTHONPATH only adds
            # to sys.path, as on CPython.
            env=[
                *(ctx.env or {}).items(),
                ("PYTHONHOME", "/"),
                ("PYTHONDONTWRITEBYTECODE", "1"),
            ],
            fs=fs,
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=exit_code)
