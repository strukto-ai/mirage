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
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True, slots=True)
class RunArgs:
    """One interpreter execution request, language-agnostic.

    Args:
        code (str): the source to run (script body or -c/-e payload).
        args (list[str]): argv exposed to the script.
        env (dict[str, str]): extra environment merged over the
            runtime's own.
        stdin (bytes | None): bytes fed to the interpreter's stdin.
        flags (dict[str, Any]): interpreter-level switches parsed by
            the command's spec (e.g. js module mode). Each runtime
            reads its own switches and ignores the rest.
    """

    code: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    stdin: bytes | None = None
    flags: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RunResult:
    """Outcome of one interpreter execution.

    Args:
        stdout (bytes): captured standard output.
        stderr (bytes | None): captured standard error, None when
            empty.
        exit_code (int): interpreter exit code.
    """

    stdout: bytes
    stderr: bytes | None
    exit_code: int


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

    async def close(self) -> None:
        """Release interpreter resources. Default: nothing held."""
