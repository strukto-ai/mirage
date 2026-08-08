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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeAlias

from mirage.io import IOResult
from mirage.types import PathSpec

# The value contract of eval: never richer than JSON plus bytes, so any
# evaluator (in-process or remote over a serialized transport) can carry
# it, in either direction (inputs in, verdict out).
EvalValue: TypeAlias = (None | bool | int | float | str | bytes
                        | list["EvalValue"] | dict[str, "EvalValue"])

# "incomplete" is console semantics: the source needs a continuation
# line (session mode only). "exit" is an explicit exit() call.
EvalStatus: TypeAlias = Literal["complete", "incomplete", "exit"]

# The languages a runtime can interpret, one name for both doors (run
# and eval). A Literal, not str, so a typo is a type error instead of a
# selector that silently matches nothing and reports "no runtime".
Language: TypeAlias = Literal["python", "js"]


class DispatchFn(Protocol):
    """The workspace op dispatch: run ``op`` against the mount owning
    ``path`` and return its result with the accounting IOResult.

    The contract a sandboxed runtime's file I/O rides: defined here,
    on the consumer side, because runtimes receive it (attach) while
    the workspace provides it, and the runtime package imports no
    workspace module."""

    def __call__(self, op: str, path: PathSpec,
                 **kwargs: Any) -> Awaitable[tuple[Any, IOResult]]:
        ...


# Live view of the workspace mount prefixes, read per run so mounts
# added or removed after construction are always picked up.
PrefixSource: TypeAlias = Callable[[], list[str]]


@dataclass(frozen=True, slots=True)
class ScriptSource:
    """Script source arriving from a workspace config, not from code.

    The programmatic API takes callables; a yaml ``script:``/``policy:``
    value references a ``.py`` or ``.js``/``.mjs`` file whose content is
    embedded here at load. The source sees ctx as a dict and its LAST
    EXPRESSION is the verdict. It runs on the world's evaluator
    (evaluator_of), preferring one whose language matches.

    Args:
        source (str): the script program.
        language (Language): the script's language ("python" or "js"),
            stamped from the file extension at config load; the
            programmatic default is "python".
        module (bool): the source is an ES module (a ``.mjs`` file), so
            a js engine must run it in module mode or ``import`` and
            top-level ``await`` fail. Stamped from the extension at
            load beside ``language``, since the path is gone once the
            source is embedded. Inert for policy scripts: a module has
            no completion value, and their contract is the last
            expression.
    """

    source: str
    language: Language = "python"
    module: bool = False


@dataclass(frozen=True, slots=True)
class RunArgs:
    """One interpreter execution request, language-agnostic.

    Args:
        code (str): the source to run (script body or -c/-e payload).
        args (list[str]): argv exposed to the script.
        prog (str | None): the program's own name, for the argv slot a
            program reads to prefix its messages. Set by the CLI script
            tier (the installed head word, so a renamed install names
            itself), None for the interpreter commands, which keep
            their engine's own spelling. A runtime that assembles argv
            itself fills slot 0 with it; where a real interpreter
            defines that slot (CPython under ``-c``) it cannot apply.
        env (dict[str, str]): extra environment merged over the
            runtime's own.
        stdin (bytes | None): bytes fed to the interpreter's stdin.
        flags (dict[str, Any]): interpreter-level switches parsed by
            the command's spec (e.g. js module mode). Each runtime
            reads its own switches and ignores the rest.
    """

    code: str
    args: list[str] = field(default_factory=list)
    prog: str | None = None
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


@dataclass(frozen=True, slots=True)
class EvalResult:
    """Outcome of one evaluation.

    One-shot mode raises EvalError on any failure, so a returned
    result is always a success. Session (console) mode is a
    transcript: a failing snippet comes back as a result too (its
    traceback on stderr, a nonzero exit_code), because a console
    reports errors and keeps going.

    Args:
        value (EvalValue): the program's last expression. In-process
            evaluators return it directly; remote ones return what the
            transport could carry. Session (console) mode may report
            None when the evaluator only streams output.
        stdout (bytes): output the program printed while running.
        stderr (bytes | None): captured standard error, None when
            empty.
        exit_code (int): 0 outside session mode; a console snippet's
            exit (1 on error, exit(N)'s N).
        status (EvalStatus): console verdict; always "complete"
            outside session mode.
    """

    value: EvalValue = None
    stdout: bytes = b""
    stderr: bytes | None = None
    exit_code: int = 0
    status: EvalStatus = "complete"
