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

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Literal

from pydantic import BaseModel

from mirage.commands.cli.compile import validate_cli
from mirage.commands.spec.types import CommandSpec
from mirage.types import Limit, ResourceName


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
    single word, a node takes ``fn`` or ``subcommands`` (never both,
    never neither), a group declares no positional/rest (its operand is
    the subcommand word), child names must be unique, and only a tree's
    root may declare ``config_model``.

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
            ``set_defaults(func=...)``), called as
            ``fn(config, paths, *texts, **flags)`` where ``config`` is the
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
            those mounts drop their cached listings afterwards and the
            agent's next ``ls`` shows what it just made. Empty for a CLI
            with no mounted counterpart (``git`` reaches mounts through
            the op dispatcher, which invalidates per path already).
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
