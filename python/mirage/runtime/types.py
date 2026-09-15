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

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypeAlias

from mirage.io import IOResult, OpReport
from mirage.types import PathSpec

if TYPE_CHECKING:
    from mirage.ops.types import NamespaceView, SessionView
    from mirage.runtime.binding import WorkspaceBinding
    from mirage.runtime.resolver import MountResolver
    from mirage.utils.context_scope import ContextScope

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

# Which doors code executed by a runtime has to the outside world. The
# workspace dispatch is a gate: it checks mount modes, session grants,
# and policy, records the op, and only then touches the real backend
# behind the mount (s3, disk, an API). Reach states whether that gate
# is avoidable, not where bytes physically end up; a "vfs" write to an
# s3 mount still lands in real s3, but only after the gate said yes.
# - "vfs": the gate is the code's only door. The engine runs as an
#   in-process guest with no syscalls, so its I/O can only travel the
#   VFS bridge (or the workspace executor itself) and a mount-mode or
#   policy refusal is final.
# - "process": the code has host doors around the gate. It is, or
#   spawns, a real process on this machine with the user's own
#   filesystem and network, so it can reach the same backends (and
#   everything else) without the gate seeing it.
# - "remote": the code runs on another machine and acts on that
#   machine's world; the gate never sees those effects.
RuntimeReach: TypeAlias = Literal["vfs", "process", "remote"]


class DispatchFn(Protocol):
    """The workspace op dispatch: run ``op`` against the mount owning
    ``path`` and return its result with the accounting IOResult.

    The contract a sandboxed runtime's file I/O rides: defined here,
    on the consumer side, because runtimes receive it through a binding while
    the workspace provides it, and the runtime package imports no
    workspace module. ``report``, when a caller passes one, is stamped
    by the door the moment the op completes, so an observer reads what
    ran even when a later step throws the result away; runtimes never
    pass it."""

    def __call__(self,
                 op: str,
                 path: PathSpec,
                 *,
                 report: OpReport | None = None,
                 **kwargs: Any) -> Awaitable[tuple[Any, IOResult]]:
        ...


# Whether code may be loaded from one virtual path: the per-script exec
# question an interpreter command asks about a file operand. Defined
# beside DispatchFn for the same reason: the consumer receives it, the
# workspace provides it.
ExecPathFn: TypeAlias = Callable[[str], bool]

# Live view of the workspace mount prefixes, read per run so mounts
# added or removed after construction are always picked up.
PrefixSource: TypeAlias = Callable[[], list[str]]

# Live view of the link names one directory owns, read per listing so a
# link created after construction is always seen.
LinkChildrenSource: TypeAlias = Callable[[str], set[str]]


@dataclass(frozen=True, slots=True)
class VFSStat:
    """One path's metadata, in the shape every guest encoder needs
    (TS ``VFSStat``).

    Built once at the door out of the mount's own ``FileStat``, so a
    surface projects rather than translates: preview1 keeps the type
    bits and drops the rest, monty fills a ``StatResult``, Emscripten
    fills an ``FSAttr``.

    Args:
        size (int): rendered content bytes, 0 for a directory and for
            an unknown size.
        is_dir (bool): the path is a directory.
        mode (int): the full st_mode, type bits included, so a chmod
            the shell made is what a guest's stat reports. ``is_dir``
            and ``is_link`` are this field's type bits spelled out;
            mode is the authority and they are the convenience.
        mtime_ns (int): modification time in epoch nanoseconds, 0 when
            the source reports none. Nanoseconds here and milliseconds
            in TypeScript, on purpose: epoch nanoseconds are past
            2**53, so a JS number cannot hold them exactly, while a
            python int can and preview1 asks in them.
        is_link (bool): the path is a symlink. Only ever true for a
            stat the caller asked not to follow, since every other
            answer is the target's.
        rdev (int): encoded logical major:minor for a character device,
            otherwise 0.
    """

    size: int
    is_dir: bool
    mode: int
    mtime_ns: int
    is_link: bool = False
    rdev: int = 0


@dataclass(frozen=True, slots=True)
class VFSEntry:
    """One directory entry as the mounts report it (TS ``VFSEntry``).

    Resolved once at the door off the stat index the readdir just
    populated, so no guest pays one stat per entry for a fact the door
    already had.

    Args:
        path (str): the entry's virtual path, in the door's own
            spelling (a backend that slash-marks directories keeps the
            trailing slash).
        size (int): rendered content bytes, 0 for directories and for
            entries whose stat answered absent.
        is_dir (bool): the entry is a directory.
        is_link (bool): the entry is a namespace symlink. Marked from
            the name plane, which is the only authority for one: no
            backend listing reports a link and stat follows, so a
            directory link would otherwise read as a plain directory
            and a cyclic one would recurse a whole-tree walk forever.
        mode (int | None): the entry's full st_mode, None when this row
            carries no stat. A backend that slash-marks its directories
            is listed without one, which is the whole point of the
            mark, so the row says "not known" rather than inventing a
            default the guest cannot tell from a real answer.
        mtime_ns (int | None): modification time in epoch nanoseconds,
            None on the same rows and for the same reason. 0 is a real
            answer here (1970-01-01T00:00:00Z, and what an unknown
            mtime collapses to once a stat did happen).
        rdev (int): encoded logical major:minor for a character device,
            otherwise 0.
    """

    path: str
    size: int
    is_dir: bool
    is_link: bool = False
    mode: int | None = None
    mtime_ns: int | None = None
    rdev: int = 0


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
        script_cli (bool): installed script CLI; bind bare argv and stdin
            in the program globals as well as the interpreter's own streams.
        cwd (PathSpec | None): virtual working directory for
            filesystem-aware guest runtimes.
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
    cwd: PathSpec | None = None
    script_cli: bool = False


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


@dataclass(frozen=True, slots=True, kw_only=True)
class CodeExecution(RunArgs):
    """Source in an explicit language, with interpreter execution arguments."""

    language: Language
    kind: Literal["code"] = field(default="code", init=False)


@dataclass(frozen=True, slots=True, kw_only=True)
class ShellExecution:
    """A whole shell line, interpreted entirely by the selected runtime."""

    line: str
    cwd: PathSpec
    env: dict[str, str] = field(default_factory=dict)
    stdin: bytes | None = None
    kind: Literal["shell"] = field(default="shell", init=False)


@dataclass(frozen=True, slots=True, kw_only=True)
class ProcessExecution:
    """An argv request executed without shell interpretation."""

    argv: tuple[str, ...]
    cwd: PathSpec
    env: dict[str, str] = field(default_factory=dict)
    stdin: bytes | None = None
    kind: Literal["process"] = field(default="process", init=False)


ExecutionRequest: TypeAlias = CodeExecution | ShellExecution | ProcessExecution

# Guest APIs that can operate on workspace files. Policy and backend support
# still decide whether an individual operation is allowed.
FilesystemOperation: TypeAlias = Literal["read", "write", "list", "stat",
                                         "glob"]


@dataclass(frozen=True, slots=True)
class RuntimeCapabilities:
    """Execution support by runtime type, plus the separate reach guarantee."""

    languages: tuple[Language, ...] = ()
    shell: bool = False
    process: bool = False
    evaluate: bool = False
    reach: RuntimeReach = "process"
    filesystem: tuple[FilesystemOperation, ...] = ()


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    """Local workspace binding captured for one execution, never guest globals.

    The scoped doors retain session, policy, and observation context even
    when called later from a worker callback. No workspace stores are exposed.
    """

    binding: "WorkspaceBinding"
    dispatch: DispatchFn
    resolver: "MountResolver"
    ns: "NamespaceView"
    session_view: "SessionView | None"
    cwd: PathSpec
    env: Mapping[str, str]
    scope: "ContextScope"


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
