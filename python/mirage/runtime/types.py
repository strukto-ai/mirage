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

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeAlias

from mirage.io import IOResult, OpReport
from mirage.io.types import ByteSource
from mirage.types import PathSpec


class RuntimeIdentity(Protocol):
    """The runtime metadata shared by routing and capability checks."""

    @property
    def name(self) -> str: ...

    @property
    def captures(self) -> Sequence[str]: ...


# The languages a runtime can interpret. A Literal, not str, so a typo is
# a type error instead of a selector that silently matches nothing and
# reports "no runtime".
Language: TypeAlias = Literal["python", "js"]

# Which entry points code executed by a runtime has to the outside world. The
# workspace dispatch is a gate: it checks mount modes, session grants,
# and policy, records the op, and only then touches the real backend
# behind the mount (s3, disk, an API). Reach states whether that gate
# is avoidable, not where bytes physically end up; a "workspace" write to an
# s3 mount still lands in real s3, but only after the gate said yes.
# - "workspace": the gate is the code's only entry point. The engine runs as an
#   in-process guest with no syscalls, so its I/O can only travel the
#   VFS bridge (or the workspace executor itself) and a mount-mode or
#   policy refusal is final.
# - "process": the code has host entry points around the gate. It is, or
#   spawns, a real process on this machine with the user's own
#   filesystem and network, so it can reach the same backends (and
#   everything else) without the gate seeing it.
# - "remote": the code runs on another machine and acts on that
#   machine's world; the gate never sees those effects.
RuntimeReach: TypeAlias = Literal["workspace", "process", "remote"]

# How a sandbox sees the workspace: ``ssh`` serves every prefix from the
# host over SFTP, ``fuse`` leaves them to the sandbox's own mirage, and
# ``both`` serves from the host what the sandbox does not mount itself.
MountType: TypeAlias = Literal["ssh", "fuse", "both"]


class DispatchFn(Protocol):
    """The workspace dispatch: run the function ``name`` against the
    mount owning ``path`` and return its result with the accounting
    IOResult.

    The contract a sandboxed runtime's file I/O rides: defined here,
    on the consumer side, because runtimes receive it through a binding while
    the workspace provides it, and the runtime package imports no
    workspace module. ``report``, when a caller passes one, is stamped
    by the dispatcher the moment the op completes, so an observer reads what
    ran even when a later step throws the result away; runtimes never
    pass it."""

    def __call__(
        self,
        name: str,
        path: PathSpec,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> Awaitable[tuple[Any, IOResult]]: ...


# Whether code may be loaded from one virtual path: the per-script exec
# question an interpreter command asks about a file operand. Defined
# beside DispatchFn for the same reason: the consumer receives it, the
# workspace provides it.
ExecPathFn: TypeAlias = Callable[[str], bool]

# Run one shell line in the calling session and return its result, the
# line reading the given input (None keeps the ambient one): the entry point a
# command handler reaches the executor through, as awk's command pipes
# and system() do. Defined beside DispatchFn for the same reason: the
# consumer receives it, the workspace provides it.
ShellFn: TypeAlias = Callable[[str, ByteSource | None], Awaitable[IOResult]]

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

    Built once at the file adapter out of the mount's own ``FileStat``, so a
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
        mtime_ns (int | None): modification time in epoch nanoseconds,
            None when the source reports none. A guest wire with no
            validity channel spells None as 0 at its own boundary.
            Nanoseconds here and milliseconds in TypeScript, on purpose:
            epoch nanoseconds are past 2**53, so a JS number cannot hold
            them exactly, while a python int can and preview1 asks in
            them.
        is_link (bool): the path is a symlink. Only ever true for a
            stat the caller asked not to follow, since every other
            answer is the target's.
        rdev (int): encoded logical major:minor for a character device,
            otherwise 0.
        atime_ns (int | None): access time in epoch nanoseconds, None
            when the source reports none.
        uid (int | None): the owner's numeric id, None when unknown or
            stored as a name.
        gid (int | None): the group's numeric id, read the same way.
    """

    size: int
    is_dir: bool
    mode: int
    mtime_ns: int | None = None
    is_link: bool = False
    rdev: int = 0
    atime_ns: int | None = None
    uid: int | None = None
    gid: int | None = None


@dataclass(frozen=True, slots=True)
class VFSEntry:
    """One directory entry as the mounts report it (TS ``VFSEntry``).

    Resolved once at the file adapter by the entry's own stat, so no guest
    pays one stat per entry for a fact the file adapter already had. An entry
    the file adapter did not classify (a guest that asked for names only, or a
    stat that failed) rides as a size-0 non-directory with no mode or
    mtime: "not known", rather than a default a guest cannot tell from
    a real answer. A slash-marked directory carries neither either,
    which is the whole point of the mark.

    Args:
        path (str): the entry's virtual path, in the file adapter's own
            spelling (a backend that slash-marks directories keeps the
            trailing slash).
        size (int): rendered content bytes, 0 for directories and
            unclassified entries.
        is_dir (bool): the entry is a directory.
        is_link (bool): the entry is a namespace symlink. Marked from
            the name plane, which is the only authority for one: no
            backend listing reports a link and stat follows, so a
            directory link would otherwise read as a plain directory
            and a cyclic one would recurse a whole-tree walk forever.
        mode (int | None): the entry's full st_mode, None when the row
            carries no stat (a slash-marked or unclassified entry).
        mtime_ns (int | None): modification time in epoch nanoseconds,
            None on the same rows and for the same reason. 0 is a real
            answer here (1970-01-01T00:00:00Z, and what an unknown
            mtime collapses to once a stat did happen).
        rdev (int): encoded logical major:minor for a character device,
            otherwise 0.
        atime_ns (int | None): access time a stat reported, on the same
            rows as the mode.
        uid (int | None): owner a stat reported; None when it had none.
        gid (int | None): group, read the same way.
    """

    path: str
    size: int
    is_dir: bool
    is_link: bool = False
    mode: int | None = None
    mtime_ns: int | None = None
    rdev: int = 0
    atime_ns: int | None = None
    uid: int | None = None
    gid: int | None = None


@dataclass(frozen=True, slots=True)
class ScriptSource:
    """A program's source: a policy program or a script CLI.

    A yaml ``script:`` value references a ``.py`` or ``.js``/``.mjs``
    file whose content is embedded here at load; code passes the text.
    It runs as a program on the runtime its config names, never edited.

    Args:
        source (str): the script program.
        language (Language): the script's language ("python" or "js"),
            stamped from the file extension at config load; the
            programmatic default is "python".
        module (bool): the source is an ES module (a ``.mjs`` file), so
            a js engine must run it in module mode or ``import`` and
            top-level ``await`` fail. Stamped from the extension at
            load beside ``language``, since the path is gone once the
            source is embedded.
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
        script_path (PathSpec | None): the script file the program was
            read from, ``raw_path`` as typed.
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
    script_path: PathSpec | None = None
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


class ByteReader(Protocol):
    """The byte reads an SFTP transport needs."""

    async def readexactly(self, n: int) -> bytes: ...


class PipeWriter(Protocol):
    """Where a pipe's bytes go: an ``asyncio.StreamWriter``, or anything
    with its two calls."""

    def write(self, data: bytes) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class SandboxPipe:
    """A command a sandbox runs with its stdin and stdout held open.

    Args:
        reader (ByteReader): what the command writes.
        writer (PipeWriter): what the command reads.
        stop (Callable[[], Awaitable[None]]): ends the command.
    """

    reader: ByteReader
    writer: PipeWriter
    stop: Callable[[], Awaitable[None]]


@dataclass(frozen=True, slots=True, kw_only=True)
class CodeExecution(RunArgs):
    """Source in an explicit language, with interpreter execution arguments."""

    language: Language
    kind: Literal["code"] = field(default="code", init=False)


@dataclass(frozen=True, slots=True, kw_only=True)
class ShellRequest:
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


@dataclass(frozen=True, slots=True)
class StreamExecution:
    """An argv execution with bounded input and an awaited stdout consumer."""

    argv: tuple[str, ...]
    cwd: PathSpec
    env: dict[str, str]
    stdin: ByteSource | None
    output: Callable[[bytes], Awaitable[None]]
    kind: Literal["stream"] = field(default="stream", init=False)


ExecutionRequest: TypeAlias = (
    CodeExecution | ShellRequest | ProcessExecution | StreamExecution
)

# Guest APIs that can operate on workspace files. Policy and backend support
# still decide whether an individual operation is allowed.
FilesystemOperation: TypeAlias = Literal[
    "read", "write", "list", "stat", "glob"
]


@dataclass(frozen=True, slots=True)
class RuntimeCapabilities:
    """Execution support by runtime type, plus the separate reach guarantee."""

    languages: tuple[Language, ...] = ()
    shell: bool = False
    process: bool = False
    reach: RuntimeReach = "process"
    filesystem: tuple[FilesystemOperation, ...] = ()
