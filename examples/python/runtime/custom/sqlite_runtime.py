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
import posixpath
import tempfile
from dataclasses import dataclass
from pathlib import Path

from mirage import (
    Context,
    PathSpec,
    ProcessExecutorMixin,
    RunResult,
    Runtime,
    RuntimeConfig,
)
from mirage.io.types import materialize
from mirage.runtime.types import OutputFn

# A runtime Mirage does not ship, as a deployment ships it: one file, named
# from yaml as ``./sqlite_runtime.py:SqliteRuntime``. It runs the host's
# sqlite3 on a database that lives in the workspace, wherever it is mounted
# (RAM here, an S3 bucket or a disk folder the same way).
#
# The one rule a runtime has to get right is where its files come from. The
# host program cannot see a mount, so the runtime copies the database out
# through ctx.vfs, runs sqlite3 on the copy and writes it back through
# ctx.vfs. Both calls go through the workspace dispatcher, so mount modes,
# policy and the cache apply to them exactly as they apply to cat or cp:
# a database on a read-only mount comes back unchanged and the write is
# refused.


@dataclass(frozen=True, slots=True)
class SqliteConfig(RuntimeConfig):
    """The yaml entry's ``config`` block; an unknown key fails at load.

    Args:
        binary (str): the sqlite3 executable to run.
        readonly (bool): open every database read-only and never write
            one back.
    """

    binary: str = "sqlite3"
    readonly: bool = False


class SqliteRuntime(Runtime[None], ProcessExecutorMixin[None]):
    name = "sqlite"
    captures = ("sqlite3",)
    config_cls = SqliteConfig
    config: SqliteConfig

    async def run_process(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run ``sqlite3 [OPTIONS] DATABASE [SQL]`` on a workspace file.

        Args:
            engine (None): this runtime opens no engine.
            paths (list[PathSpec]): unused; a process gets its argv as
                words.
            texts (list[str]): the argv, ``sqlite3`` first.
            ctx (Context): the session's cwd, stdin and files.
            output (OutputFn | None): unused; the output comes back
                whole in the result.
            errors (OutputFn | None): unused, the same for stderr.
        """
        args = texts[1:]
        options = ["-readonly"] if self.config.readonly else []
        at = next(
            (i for i, a in enumerate(args) if not a.startswith("-")), None
        )
        stdin = await materialize(ctx.stdin) if ctx.stdin is not None else b""
        if at is None:
            return await self._sqlite(options + args, stdin)
        database = posixpath.normpath(
            posixpath.join(ctx.cwd.virtual, args[at])
        )
        try:
            before = await ctx.vfs.read(database, raw=True)
        except FileNotFoundError:
            before = b""
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "db.sqlite"
            local.write_bytes(before)
            argv = options + args[:at] + [str(local)] + args[at + 1 :]
            result = await self._sqlite(argv, stdin)
            after = local.read_bytes()
        if not self.config.readonly and after != before:
            await ctx.vfs.write(database, after)
        return result

    async def _sqlite(self, argv: list[str], stdin: bytes) -> RunResult:
        proc = await asyncio.create_subprocess_exec(
            self.config.binary,
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(stdin)
        return RunResult(
            stdout=out, stderr=err or None, exit_code=proc.returncode or 0
        )
