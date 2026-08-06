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

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Generic, Literal, TypeVar

from pydantic import BaseModel

from mirage.commands.cli.compile import validate_cli
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import ByteSource
from mirage.ops.types import MountRoot, StatPath
from mirage.runtime.types import ScriptSource
from mirage.types import Limit, PathSpec, ResourceName


class UsageStyle(Enum):
    """Which program's usage-error dialect a CLI speaks.

    An installed CLI is not a GNU tool, so a leaf that refuses an option
    it does not declare answers in argparse's shape and exit code by
    default. A CLI that mimics an existing program has to answer in that
    program's shape instead: mirage implements a subset of git, so most
    of git's real options arrive undeclared, and an agent that reads the
    refusal should see what git would have said rather than learn that
    it is talking to a reimplementation.

    Covers the unknown-option refusal and the exit code, which is what
    an undeclared flag produces. Every other usage error (a missing
    value, an unparseable int) stays in argparse's shape for both
    styles, because those only happen for options a CLI does declare.
    """

    ARGPARSE = "argparse"
    GIT = "git"


# The group-level flag bag the walk accumulates, keyed by canonical
# dashed spelling like ParsedArgs.flags.
FlagBag = dict[str, str | bool | int | list[str]]

ConfigT = TypeVar("ConfigT")


@dataclass(frozen=True)
class CLIVerbOpts:
    """The workspace doors a mount-reading CLI verb needs, as one field.

    Most CLIs want none of this: an account CLI reaches a service and
    has no filesystem, while ``git``'s whole subject is a repository
    that lives on a mount. So this rides ``CLIInvocation.ops`` and is
    None outside a workspace (a spec exercised directly in a test), and
    a verb that never reads it cannot touch a mount. That is the same
    opt-in the parameter-injection form gave, moved onto the one record
    every leaf already takes: the door is a field read instead of a
    signature the dispatcher inspects.

    Args:
        dispatch (Callable[..., Any] | None): the workspace op
            dispatcher. Typed loosely on purpose: the DispatchFn
            Protocol lives in ``workspace.types``, and ``commands``
            stays free of a workspace import.
        stat_path (StatPath | None): dispatcher-backed stat that asks
            both channels a backend can answer on.
        mount_root (MountRoot | None): the mount prefix serving a path.
            A mount boundary is a filesystem boundary, which is where
            git stops looking for a repository.
    """
    dispatch: Callable[..., Any] | None = None
    stat_path: StatPath | None = None
    mount_root: MountRoot | None = None


@dataclass(frozen=True)
class CLIInvocation(Generic[ConfigT]):
    """Everything one CLI line hands its handler, built once per line.

    The executor constructs exactly one of these per invocation and
    every handler tier renders it: an fn leaf is called as ``fn(inv)``,
    a script handler maps ``argv``/``stdin``/``env`` onto RunArgs, a
    native handler maps the same three onto a process. The record
    carries both views of the line: the process view (``argv``,
    ``stdin``, ``env``) and the parsed view (``config``, ``paths``,
    ``texts``, ``flags``), so a handler takes whichever its substrate
    can express and nothing is threaded through keyword injection.

    Args:
        config (ConfigT): the installation's validated ``config_model``
            instance, None when the CLI declares no config. A leaf
            annotates the concrete model (``CLIInvocation[SlackConfig]``),
            the same authorship claim as the old ``config`` parameter.
        argv (tuple[str, ...]): verbatim tokens after the head word,
            subcommand words included.
        paths (tuple[PathSpec, ...]): path-typed operands of the leaf,
            cwd-resolved.
        texts (tuple[str, ...]): text-typed operands of the leaf.
        flags (Mapping[str, object]): merged group and leaf flags keyed
            by kwarg name (``flag_kwarg_name`` spelling), read through
            FlagView. PATH-typed flag values arrive as PathSpec.
        stdin (ByteSource | None): piped input, None when the line has
            none.
        env (Mapping[str, str]): the session's environment variables.
        ops (CLIVerbOpts | None): the workspace doors a mount-reading
            verb needs (``git``), None outside a workspace and for every
            CLI that reaches a service instead of a filesystem.
    """
    config: ConfigT
    argv: tuple[str, ...] = ()
    paths: tuple[PathSpec, ...] = ()
    texts: tuple[str, ...] = ()
    flags: Mapping[str, object] = field(default_factory=dict)
    stdin: ByteSource | None = None
    env: Mapping[str, str] = field(default_factory=dict)
    ops: CLIVerbOpts | None = None


@dataclass(frozen=True)
class CLISpec(CommandSpec):
    """One node of a program tree: argparse's parser/subparser as data.

    A CLISpec IS a CommandSpec (click's Group-is-a-Command): it inherits
    the grammar fields (``options``, ``positional``, ``rest``,
    ``description``, ``epilog``) and adds identity, behavior, and nesting.
    A leaf carries ``fn``; a group carries ``subcommands``; the root of an
    installable program may carry ``config_model``. Every level of the
    tree parses with the ordinary spec machinery because every level is a
    CommandSpec.

    Construction validates the node at import time: the name must be a
    single word, a node takes exactly one of ``fn``, ``subcommands``, or
    ``script``, a group declares no positional/rest (its operand is the
    subcommand word), child names must be unique, and only a tree's
    root may declare ``config_model`` or ``script``.

    Args:
        name (str): the word at this level: argparse's ``prog`` for a
            root, ``add_parser`` name for a subcommand.
        aliases (tuple[str, ...]): alternate words that resolve to this
            subcommand (argparse ``add_parser(..., aliases=[...])``).
            Rendered as ``name (alias, ...)`` in the parent's Commands
            listing; the walk records the canonical ``name`` in its
            path, so help and errors attribute to the canonical word
            (argparse prog semantics). Inert on a root: the installed
            head word is the only way in.
        fn (Callable | None): leaf handler (argparse
            ``set_defaults(func=...)``), called as ``fn(inv)`` with the
            line's one CLIInvocation; ``inv.config`` is the
            installation's validated ``config_model`` instance (None when
            the CLI declares no config). What the handler does with the
            config: wrap it in an accessor, build its own client, or
            ignore it, is the author's business.
        subcommands (tuple[CLISpec, ...]): child nodes (argparse
            ``add_subparsers().add_parser(...)``).
        write (bool): leaf mutates backend state (policy classification).
        limit (Limit | None): limit category for the
            leaf.
        config_model (type[BaseModel] | None): root only. Pydantic model
            validating an installation's config from YAML ``clis:`` or
            ``register_cli``; also the redaction schema for snapshots.
        serves (tuple[ResourceName, ...]): root only. The resources this
            CLI's service also backs as mounts. A write verb mutates that
            service by id, which no vfs path can be derived from, so
            those mounts drop their cached listings and bodies
            afterwards: the agent's next ``ls`` shows what it just made
            and its next ``cat`` shows an edit rather than the pre-write
            content. Empty for a CLI with no mounted counterpart
            (``git`` reaches mounts through the op dispatcher, which
            invalidates per path already).
        script (ScriptSource | None): root only, and the root stands
            alone (no fn, no subcommands: the program re-parses argv
            natively). The program that serves the whole install,
            embedded from a YAML ``script:`` path at load; config is
            the only door for script source, in code a leaf carries
            ``fn``.
        runtime (str | None): name of the world runtime entry that runs
            ``script`` (YAML ``runtime:``); None picks the first entry
            speaking the script's language. Takes ``script``.
        usage_style (UsageStyle): root only. How a leaf refuses an option
            it does not declare. Defaults to argparse, which is right for
            a CLI mirage invented; a CLI that mimics an existing program
            sets the style that program uses, so an agent reading the
            message and the exit code sees what it would from the real
            one.
    """
    name: str = ""
    aliases: tuple[str, ...] = ()
    fn: Callable[..., Any] | None = None
    subcommands: tuple["CLISpec", ...] = ()
    write: bool = False
    usage_style: UsageStyle = UsageStyle.ARGPARSE
    # hash=False: Limit is a mutable dataclass, and the
    # frozen CLISpec must stay hashable for compile_spec's per-spec
    # cache. Equality still compares the field; only the hash skips it
    # (a collision is legal, a TypeError is not).
    limit: Limit | None = field(default=None, hash=False)
    config_model: type[BaseModel] | None = None
    serves: tuple[ResourceName, ...] = ()
    script: ScriptSource | None = None
    runtime: str | None = None

    def __post_init__(self) -> None:
        validate_cli(self)


@dataclass(frozen=True)
class WalkResult:
    """Outcome of walking a CLI tree with one command line.

    Exactly one of two shapes: ``leaf`` set (dispatch: the resolved verb,
    the group flags collected on the way down, and the argv remainder the
    leaf's own spec parses), or ``leaf`` None (rendered: ``output`` goes
    to ``stream`` and the line exits with ``exit_code``, covering help,
    bare-group usage, unknown verbs, and group-level option errors).

    Args:
        leaf (CLISpec | None): resolved verb node, None for a rendered
            outcome.
        path (tuple[str, ...]): canonical subcommand names consumed below
            the head, including the leaf name (an alias records the name
            it resolves to, argparse prog semantics).
        group_flags (dict): flags consumed at group levels, keyed by
            canonical dashed spelling like ParsedArgs.flags.
        argv (tuple[str, ...]): remaining tokens for the leaf's spec.
        output (bytes): rendered bytes when ``leaf`` is None.
        stream (Literal["stdout", "stderr"]): where ``output`` goes.
        exit_code (int): exit status for a rendered outcome.
    """
    leaf: "CLISpec | None" = None
    path: tuple[str, ...] = ()
    group_flags: FlagBag = field(default_factory=dict)
    argv: tuple[str, ...] = ()
    output: bytes = b""
    stream: Literal["stdout", "stderr"] = "stdout"
    exit_code: int = 0
