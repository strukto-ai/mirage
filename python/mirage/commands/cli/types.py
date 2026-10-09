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

from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Generic, Literal, TypeVar

from pydantic import BaseModel

from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import CommandSpec, FlagValue, UsageStyle
from mirage.io.types import ByteSource, IOResult
from mirage.process.view import ProcessView
from mirage.runtime.types import DispatchFn, ScriptSource
from mirage.types import Limit, PathSpec
from mirage.view.types import NamespaceView, SessionView, StatPath

# The group-level flag bag the walk accumulates, keyed by canonical
# dashed spelling like ParsedArgs.flags.
WalkFlagBag = FlagBag[FlagValue]

ConfigT = TypeVar("ConfigT")


@dataclass(frozen=True)
class CLIView:
    """One entry point per state plane, for the CLI verb that needs one.

    Most CLIs want none of this: an account CLI reaches a service and
    has no filesystem, while ``git``'s whole subject is a repository
    that lives on a mount. So this rides ``CLIInvocation.view`` and is
    None outside a workspace (a spec exercised directly in a test), and
    a verb that never reads it cannot touch a mount. That is the same
    opt-in the parameter-injection form gave, moved onto the one record
    every leaf already takes: the dispatcher is a field read instead of a
    signature the dispatcher inspects.

    The field names and types are ``CommandOpts``' (commands/config.py),
    deliberately: a fact reached from a CLI leaf and the same fact
    reached from a command handler must be spelled the same way, or the
    two tiers grow separate vocabularies for one plane.
    ``tests/commands/cli/test_view_parity.py`` pins that.

    Args:
        dispatch (DispatchFn | None): the dispatcher, the
            workspace op dispatcher. The Protocol is declared in
            ``runtime.types``, on the consumer side, because the
            workspace provides the dispatcher and everyone else receives one;
            naming it from here costs no workspace import.
        stat_path (StatPath | None): dispatcher-backed stat that asks
            both channels a backend can answer on.
        ns (NamespaceView | None): the namespace view, holding the
            facts no backend can see: symlinks, mount boundaries, the
            attr overlay, the child names the namespace owes a
            directory. A verb that walks a tree itself needs this or it
            silently cannot see a link, the way ``git status`` could
            not. ``ns.mounts.root_of`` is where a mount prefix comes
            from: a mount boundary is a filesystem boundary, which is
            where git stops looking for a repository.
        session_view (SessionView | None): the session view,
            live and gated for both reads and writes. ``inv.env`` stays
            the frozen process view, which is what a script or native
            handler maps onto a real process environment; a verb that
            wants liveness, or wants to write, reads this instead. Env
            is not a mount, so an account CLI may read it without
            breaking the tier rule.
    """

    dispatch: DispatchFn | None = None
    stat_path: StatPath | None = None
    ns: NamespaceView | None = None
    session_view: SessionView | None = None
    processes: ProcessView | None = None


@dataclass(frozen=True)
class CLIInvocation(Generic[ConfigT]):
    """Everything one CLI line hands its handler, built once per line.

    The executor constructs exactly one of these per invocation and
    every handler tier renders it: an fn leaf is called as ``fn(inv)``,
    a script handler maps ``argv``/``stdin``/``env`` onto RunArgs, a
    native handler maps the same three onto a process. The record
    carries both views of the line: the process view (``argv``,
    ``stdin``, ``env``, ``cwd``) and the parsed view (``config``, ``paths``,
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
        cwd (PathSpec): the session's working directory, the one the
            paths were resolved against.
        flags (Mapping[str, FlagValue]): merged group and leaf flags keyed
            by kwarg name (``flag_kwarg_name`` spelling), read through
            FlagView. PATH-typed flag values arrive as PathSpec.
        stdin (ByteSource | None): piped input, None when the line has
            none.
        env (Mapping[str, str]): the session's environment variables,
            as one frozen process-view snapshot. A leaf that wants the
            live, gated handle reads ``view.session_view``.
        view (CLIView | None): one dispatcher per state plane, None outside
            a workspace and for every CLI that reaches a service
            instead of a filesystem.
        shell (Callable[[str], Awaitable[IOResult]] | None): evaluate a
            nested line in this invocation's exact session. Host callbacks
            use this for portable re-entry, including after awaits and in
            forks. Valid until the handler settles or is cancelled; await
            each call before returning. None outside a workspace.
        spec (CLISpec | None): the leaf the line resolved to, the
            grammar its argv was parsed against. A verb reads it to
            answer in its original's terms (git names the first switch
            letter parse-options would not know), so a refusal never
            restates the options declared one level up. None where no
            executor built the record.
    """

    config: ConfigT
    argv: tuple[str, ...] = ()
    paths: tuple[PathSpec, ...] = ()
    texts: tuple[str, ...] = ()
    cwd: PathSpec = ROOT_CWD
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    stdin: ByteSource | None = None
    env: Mapping[str, str] = field(default_factory=dict)
    view: CLIView | None = None
    spec: "CLISpec | None" = None
    shell: Callable[[str], Awaitable[IOResult]] | None = None


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
        script (ScriptSource | None): root only, and the root stands
            alone (no fn, no subcommands: the program re-parses argv
            natively). The program that serves the whole install,
            embedded from a YAML ``script:`` path at load; config is
            the only entry point for script source, in code a leaf carries
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
    # Any callable is valid, including stateful callable objects whose
    # class deliberately has no hash. The handler does not affect the
    # inherited CommandSpec grammar cached by compile_spec.
    fn: Callable[..., Any] | None = field(default=None, hash=False)
    subcommands: tuple["CLISpec", ...] = ()
    write: bool = False
    usage_style: UsageStyle = UsageStyle.ARGPARSE
    # hash=False: Limit is a mutable dataclass, and the
    # frozen CLISpec must stay hashable for compile_spec's per-spec
    # cache. Equality still compares the field; only the hash skips it
    # (a collision is legal, a TypeError is not).
    limit: Limit | None = field(default=None, hash=False)
    config_model: type[BaseModel] | None = None
    script: ScriptSource | None = None
    runtime: str | None = None

    def __post_init__(self) -> None:
        _validate_cli(self)


def _validate_cli(node: CLISpec) -> None:
    """Validate one CLISpec node at construction time.

    Called from CLISpec.__post_init__, so an invalid node raises ValueError
    at import time, never at dispatch. Children were
    validated by their own construction (a nested literal builds bottom
    up), so each call checks one level: the name is a single word with no
    whitespace, a node takes exactly one of fn, subcommands, or script
    (a script root stands alone and takes opaque config: the program
    re-parses argv natively), runtime only rides a script, every node's
    inherited CommandSpec grammar compiles, a group declares no
    positional/rest (its operand is the subcommand word), child names are
    unique, and only a tree's root may declare config_model or script.

    Args:
        node (CLISpec): the freshly constructed node.
    """
    if not node.name or any(ch.isspace() for ch in node.name):
        raise ValueError(
            f"cli name {node.name!r} must be a single non-empty word"
        )
    for alias in node.aliases:
        if not alias or any(ch.isspace() for ch in alias):
            raise ValueError(
                f"cli {node.name!r}: alias {alias!r} must be "
                f"a single non-empty word"
            )
    if node.script is not None and node.fn is not None:
        raise ValueError(
            f"cli {node.name!r}: a node takes fn or script, not both"
        )
    if node.script is not None and node.subcommands:
        raise ValueError(
            f"cli {node.name!r}: a script serves the whole program; "
            f"subcommands belong to fn trees"
        )
    if node.script is not None and node.config_model is not None:
        raise ValueError(
            f"cli {node.name!r}: script config is opaque; it "
            f"cannot declare config_model"
        )
    if node.runtime is not None and node.script is None:
        raise ValueError(
            f"cli {node.name!r}: runtime names the entry that "
            f"runs script; it takes script"
        )
    if node.fn is not None and node.subcommands:
        raise ValueError(
            f"cli {node.name!r}: a node takes fn or subcommands, not both"
        )
    if node.fn is None and not node.subcommands and node.script is None:
        raise ValueError(
            f"cli {node.name!r}: a node needs fn, subcommands, or script"
        )
    if node.subcommands and (node.positional or node.rest is not None):
        raise ValueError(
            f"cli {node.name!r}: a group's operand is its subcommand "
            f"word; positional/rest belong on leaves"
        )
    compiled = compile_spec(node)
    # Names and aliases share one sibling namespace (argparse refuses a
    # conflicting subparser alias the same way).
    seen: set[str] = set()
    for child in node.subcommands:
        for word in (child.name,) + child.aliases:
            if word in seen:
                raise ValueError(
                    f"cli {node.name!r}: duplicate subcommand {word!r}"
                )
            seen.add(word)
        if child.config_model is not None:
            raise ValueError(
                f"cli {node.name!r}: subcommand {child.name!r} declares "
                f"config_model; only the root of a tree may"
            )
        if child.script is not None:
            raise ValueError(
                f"cli {node.name!r}: subcommand {child.name!r} declares "
                f"script; only the root of a tree may"
            )
    if node.options and node.subcommands:
        own = set(compiled.dest.values())
        for child in node.subcommands:
            _check_collisions(node.name, own, child, (child.name,))


def _check_collisions(
    root_name: str,
    ancestor_dests: set[str],
    node: CLISpec,
    path: tuple[str, ...],
) -> None:
    """Refuse an option spelled the same on a node and any descendant.

    The walk consumes group options level by level into one flag bag, so
    an ancestor/descendant collision would be ambiguous there; siblings
    may freely share spellings. Children validated themselves already,
    so this only compares each descendant against the ancestor set.

    Args:
        root_name (str): the ancestor node's name, for the message.
        ancestor_dests (set[str]): canonical spellings on the ancestor.
        node (CLISpec): descendant being checked.
        path (tuple[str, ...]): words from the ancestor to ``node``.
    """
    if node.options:
        for dest in compile_spec(node).dest.values():
            if dest in ancestor_dests:
                raise ValueError(
                    f"cli {root_name!r}: option '{dest}' collides with "
                    f"subcommand {' '.join(path)!r}"
                )
    for child in node.subcommands:
        _check_collisions(
            root_name, ancestor_dests, child, path + (child.name,)
        )


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
    group_flags: WalkFlagBag = field(default_factory=FlagBag)
    operand_bases: tuple[PathSpec, ...] = ()
    argv: tuple[str, ...] = ()
    output: bytes = b""
    stream: Literal["stdout", "stderr"] = "stdout"
    exit_code: int = 0
