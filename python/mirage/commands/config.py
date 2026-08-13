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

import functools
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Protocol, cast

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.help import render_help
from mirage.commands.spec.types import FlagValue, Option
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import (ChildMounts, LinkView, MountView, ReaddirPath,
                              StatOverlay, StatPath)
from mirage.runtime.base import Runtime
from mirage.runtime.types import DispatchFn
from mirage.types import Limit, PathSpec
from mirage.version import __version__


def cwd_str(cwd: PathSpec | str) -> str:
    """The virtual directory name of a dispatcher-injected cwd.

    The dispatcher may inject the session cwd as a PathSpec (carrying
    the mount-relative key) or a plain string; generics that only
    resolve names use this, generics that default their operands keep
    the PathSpec (``default_paths``).

    Args:
        cwd (PathSpec | str): The injected working directory.
    """
    if isinstance(cwd, PathSpec):
        return cwd.virtual
    return cwd or "/"


@dataclass(frozen=True, slots=True)
class CommandOpts:
    """The dispatcher context of one command invocation, as one value.

    Mirrors the TypeScript ``CommandOpts`` (commands/config.ts): the
    dispatcher (``Mount.execute_cmd``) constructs it once and hands it
    to every handler as the fourth argument, so builders and bespoke
    backend wrappers are wiring that passes it through. The generic owns
    everything inside it (flag parsing via a spec-bound FlagView, the
    stdin fallback); the wiring owns everything outside it (glob
    resolution, op binding, push-downs). A handler reads the fields it
    wants and ignores the rest, so there is no opt-in registry anywhere.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        flags (Mapping[str, FlagValue]): The parsed command-line flag
            bag — only real flags, no injected context.
        cwd (PathSpec | str): The session's working directory, as the
            dispatcher injected it — a PathSpec keeps the mount-relative
            key for operand defaulting, a plain string is root-mounted.
        mount_prefix (str): The owning mount's prefix, for commands that
            render mount-relative names.
        filetype_fns (Mapping[str, CommandFn] | None): Extension-specific
            handlers of the same command, for a generic that delegates
            per operand; None when the handler itself is one of them.
        command (str | None): The full command string, set on the
            provision path only.
        spec (CommandSpec | None): The invoked command's spec, set on the
            provision path: a provision function is shared across
            commands, so it needs the spec to resolve a flag spelling.
        index (IndexCacheStore): The mount's index cache store.
        dispatch (DispatchFn | None): The workspace op dispatch, for
            interpreter commands whose sandboxed I/O rides it.
        session_id (str | None): The calling session, for commands that
            record per-session state.
        env (dict[str, str] | None): The session environment.
        exec_allowed (bool): Whether the policy layer permits spawning
            an interpreter.
        runtime (Runtime | None): The resolved runtime for interpreter
            commands.
        runtime_unavailable (str | None): The hint naming why the
            requested runtime is unavailable. Python-only: the TS
            runtime table refuses at resolution time instead.
        stat_overlay (StatOverlay | None): Namespace attr merge for
            stat-rendering commands.
        links (LinkView | None): The namespace's symlink facts.
        stat_path (StatPath | None): Dispatcher-backed stat of one path,
            for a traversal command's start point.
        readdir_path (ReaddirPath | None): Dispatcher-backed readdir of
            one path, for a walker that reads past a mount boundary.
        child_mounts (ChildMounts | None): Child names the namespace
            owes a directory (mounts and links).
        mounts (MountView | None): Where the mount boundaries are, for a
            walker whose output cannot be fanned out and concatenated.
    """

    stdin: ByteSource | None = None
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    cwd: PathSpec | str = "/"
    mount_prefix: str = ""
    filetype_fns: Mapping[str, "CommandFn"] | None = None
    command: str | None = None
    spec: CommandSpec | None = None
    index: IndexCacheStore = NULL_INDEX
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    env: dict[str, str] | None = None
    exec_allowed: bool = True
    runtime: Runtime | None = None
    runtime_unavailable: str | None = None
    stat_overlay: StatOverlay | None = None
    links: LinkView | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None
    child_mounts: ChildMounts | None = None
    mounts: MountView | None = None


CommandFnResult = tuple[ByteSource | None, IOResult] | None


class CommandFn(Protocol):
    """Command handler signature, mirroring the TS ``CommandFn``.

    Four positional parameters — accessor, paths, texts, opts — on both
    sides. Handlers that narrow the accessor to their backend's type are
    cast at registration (``command``), exactly like the TS
    ``options.fn as CommandFn``, so the dispatcher call site stays
    typed.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> Awaitable[CommandFnResult]:
        ...


class ProvisionFn(Protocol):
    """Provision estimator signature, mirroring the TS ``ProvisionFn``.

    Same four positional parameters as ``CommandFn``; the provision-only
    context (``command``, ``spec``) rides in ``opts``.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str], opts: CommandOpts) -> Awaitable[Any]:
        ...


HELP_OPTION = Option(
    long="--help",
    type="bool",
    description="Show this help and exit",
)

_VERSION_OPTION = Option(
    long="--version",
    type="bool",
    description="Show version information and exit",
)


def _version_line(name: str) -> bytes:
    """Render the GNU-style version line for a command.

    Args:
        name (str): command name as invoked.
    """
    return f"{name} (Mirage) {__version__}\n".encode()


def version_request(name: str, spec: CommandSpec | None,
                    argv: list[str]) -> bytes | None:
    """Version output when argv asks a command for the injected --version.

    None when the command declares its own --version, when the flag is
    absent, or when it sits after the `--` end-of-options marker.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec | None): the command's registered spec.
        argv (list[str]): the words after the command name.
    """
    if spec is None or not any(o is _VERSION_OPTION for o in spec.options):
        return None
    for arg in argv:
        if arg == "--":
            return None
        if arg == "--version":
            return _version_line(name)
    return None


def _with_help_support(
        name: str, spec: CommandSpec,
        fn: Callable[..., Any]) -> tuple[CommandSpec, CommandFn]:
    """Inject --help / --version and short-circuit them before the handler.

    Mirrors GNU coreutils: every registered command accepts both flags,
    prints to stdout, and exits 0 without running the command body.
    """
    extras: list[Option] = []
    if not any(o.long == "--help" for o in spec.options):
        extras.append(HELP_OPTION)
    if not any(o.long == "--version" for o in spec.options):
        extras.append(_VERSION_OPTION)
    new_spec = (spec if not extras else replace(
        spec, options=spec.options + tuple(extras)))
    help_text = render_help(name, new_spec).encode()
    version_text = _version_line(name)

    @functools.wraps(fn)
    async def wrapper(accessor: Accessor, paths: list[PathSpec],
                      texts: list[str], opts: CommandOpts) -> CommandFnResult:
        if opts.flags.get("help") is True:
            return yield_bytes(help_text), IOResult()
        if opts.flags.get("version") is True:
            return yield_bytes(version_text), IOResult()
        return await fn(accessor, paths, texts, opts)

    return new_spec, wrapper


@dataclass
class RegisteredCommand:
    name: str
    spec: CommandSpec
    resource: str | None
    filetype: str | None
    fn: CommandFn
    provision_fn: ProvisionFn | None = None
    aggregate: Callable[..., Any] | None = None
    src: str | None = None
    dst: str | None = None
    write: bool = False
    limit: Limit | None = None


def command(
    name: str,
    *,
    resource: str | list[str] | None,
    spec: CommandSpec,
    filetype: str | None = None,
    provision: Callable[..., Any] | None = None,
    dry_run: Callable[..., Any] | None = None,
    aggregate: Callable[..., Any] | None = None,
    write: bool = False,
    limit: Limit | None = None,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        resources = (resource if isinstance(resource, list) else [resource])
        new_spec, wrapped_fn = _with_help_support(name, spec, fn)
        provision_fn = cast(ProvisionFn | None, provision or dry_run)
        cmds = getattr(wrapped_fn, "_registered_commands", [])
        for p in resources:
            rc = RegisteredCommand(
                name=name,
                spec=new_spec,
                resource=p,
                filetype=filetype,
                fn=wrapped_fn,
                provision_fn=provision_fn,
                aggregate=aggregate,
                write=write,
                limit=limit,
            )
            cmds.append(rc)
        setattr(wrapped_fn, "_registered_commands", cmds)
        return wrapped_fn

    return decorator


def cross_command(
    name: str,
    *,
    src: str,
    dst: str,
    spec: CommandSpec,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        rc = RegisteredCommand(
            name=name,
            spec=spec,
            resource=f"{src}->{dst}",
            filetype=None,
            fn=cast(CommandFn, fn),
            src=src,
            dst=dst,
        )
        cmds = getattr(fn, "_registered_commands", [])
        cmds.append(rc)
        setattr(fn, "_registered_commands", cmds)
        return fn

    return decorator
