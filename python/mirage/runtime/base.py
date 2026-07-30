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
from dataclasses import dataclass, field
from typing import Any, Callable, ClassVar, Literal, TypeAlias

from mirage.runtime.config import RuntimeConfig

# The value contract of eval: never richer than JSON plus bytes, so any
# evaluator (in-process or remote over a serialized transport) can carry
# it, in either direction (inputs in, verdict out).
EvalValue: TypeAlias = (None | bool | int | float | str | bytes
                        | list["EvalValue"] | dict[str, "EvalValue"])

# "incomplete" is console semantics: the source needs a continuation
# line (session mode only). "exit" is an explicit exit() call.
EvalStatus: TypeAlias = Literal["complete", "incomplete", "exit"]


@dataclass(frozen=True, slots=True)
class ScriptSource:
    """Script source arriving from a workspace config, not from code.

    The programmatic API takes callables; a yaml ``script:``/``route:``
    value references a ``.py`` file whose content is embedded here at
    load. The source sees ctx as a dict and its LAST EXPRESSION is the
    verdict. It runs on the routing interpreter (monty today; a
    sandbox runtime may take this over later).

    Args:
        source (str): the script program.
    """

    source: str


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


class EvalError(Exception):
    """An evaluation that could not produce a value.

    The message carries the evaluator's own diagnostics (a traceback,
    a transport failure, a non-serializable result).

    Args:
        message (str): the evaluator's diagnostic text.
        syntax (bool): True when the program failed to parse, so
            callers can distinguish "bad script" from "script raised".
    """

    def __init__(self, message: str, syntax: bool = False) -> None:
        super().__init__(message)
        self.syntax = syntax


class EvaluatorMixin(ABC):
    """The evaluator capability: named inputs in, a value out.

    A true mixin: no state, no constructor, one method. A Runtime
    that also inherits this can evaluate expressions, which is what
    the routing policy engine and the repl consume; process-only
    runtimes never inherit it and are never asked to evaluate. The
    contract promises the shape, not value fidelity: inputs and the
    returned value stay within EvalValue so any transport can carry
    them, and errors surface as the evaluator's own diagnostics
    wrapped in EvalError.
    """

    @abstractmethod
    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        """Evaluate one program and return its last expression.

        Args:
            code (str): the source to evaluate.
            inputs (dict[str, EvalValue] | None): named values the
                program sees as globals, bound in the evaluator's own
                idiom.
            session (str | None): a session id for stateful console
                semantics (globals persist per id); None evaluates
                one-shot.

        Raises:
            EvalError: the program failed to parse, raised, or its
                value could not be carried back.
        """


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
    # I want this line": a callable taking a RouteContext, or a
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
