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

from abc import ABC, abstractmethod
from collections.abc import Sequence
from typing import Any, Callable, ClassVar

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.types import RunArgs, RunResult, ScriptSource


class Runtime(ABC):
    """An interpreter a workspace command can execute code on.

    A runtime is to its commands what the regex engine is to grep: the
    machinery inside a handler, invisible to the dispatcher. Each
    runtime declares the command names it captures; a command binds to
    the first runtime in the workspace's ordered list that captures
    it. Implementations own their interpreter lifecycle (lazy boot,
    reuse across runs, teardown in close). How an implementation sees
    workspace files is its own concern: a sandboxed interpreter
    bridges reads through the workspace dispatch, while a host
    subprocess only sees the host filesystem.
    """

    name: str
    captures: tuple[str, ...] = ()
    # Per-line admission script for the routing ladder, answering "do
    # I want this line": a callable taking a PolicyContext, or a
    # config-borne ScriptSource. None = always willing. Policy, not
    # capability: it can only refuse lines the captures already allow.
    script: Callable[..., Any] | ScriptSource | None = None
    # A runtime that runs whole lines sets this True and implements
    # run_line. Interpreter runtimes leave it False: they are the
    # engine inside one command (python3, node), never the line.
    runs_lines: bool = False
    # Each runtime's config class; coerce() makes unknown fields fail
    # loud, so runtimes need no per-field rejection code.
    config_cls: ClassVar[type[RuntimeConfig]] = RuntimeConfig
    config: RuntimeConfig = RuntimeConfig()

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        """Every runtime is constructed the same way.

        Args:
            captures (Sequence[str] | None): commands this runtime
                claims, overriding the class default; ("*",) claims
                every line for a runs_lines runtime. None keeps the
                default.
            config (RuntimeConfig | dict[str, Any] | None): the
                runtime's implementation knobs, coerced through its
                own config class (config_cls), so a field the runtime
                does not have fails loud; the dict form is a yaml
                entry's ``config`` block.
            script (Callable | ScriptSource | None): per-line
                admission script for the routing ladder.
        """
        if captures is not None:
            self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)
        self.script = script

    def attach(self, dispatch: Callable[..., Any],
               mount_prefixes: Callable[[], list[str]]) -> None:
        """Late-wire workspace I/O into a user-constructed instance.

        Config-built and user-passed runtimes exist before the
        workspace they serve, so the workspace attaches its dispatch
        bridge at construction. Runtimes that never touch workspace
        files (a host subprocess) keep the default no-op.

        Args:
            dispatch (Callable[..., Any]): workspace dispatch the
                sandboxed runtime bridges file I/O through.
            mount_prefixes (Callable[[], list[str]]): live list of
                workspace mount prefixes, read per run.
        """

    @abstractmethod
    async def run(self, args: RunArgs) -> RunResult:
        """Execute one program and return its captured outcome.

        Args:
            args (RunArgs): the execution request.
        """

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        """Execute one raw command line wholesale.

        Only runtimes with ``runs_lines`` implement this. The runtime
        owns the entire line: pipes, redirects, and every command in
        it run inside the runtime's world (its own cat, its own grep),
        the workspace shell never splits the line. A line lands here
        when this runtime captures one of the line's commands or "*".

        Args:
            line (str): the raw typed line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the session environment.
            cwd (str): the session working directory.
        """
        raise NotImplementedError(
            f"runtime {self.name!r} runs single commands, not whole lines")

    async def close(self) -> None:
        """Release interpreter resources. Default: nothing held."""
