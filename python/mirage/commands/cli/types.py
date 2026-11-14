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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Callable, Literal

from pydantic import BaseModel

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.cli.mcp.types import MCPSource
from mirage.commands.spec.compile import argument_dest, compile_spec
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import Argument, CommandSpec, FlagValue
from mirage.runtime.constants import (
    HOST,
    IN_PROCESS,
    SCRIPT_MACHINES,
    WORKER,
)
from mirage.runtime.types import ScriptSource
from mirage.types import Limit, PathSpec

# The group-level flag bag the walk accumulates, keyed by canonical
# dashed spelling like ParsedArgs.flags.
WalkFlagBag = FlagBag[FlagValue]


@dataclass(frozen=True)
class CLIHandler:
    """Execution and policy for one command path.

    Args:
        fn (Callable | None): callback receiving ``(accessor, paths,
            texts, ctx)``, the same ``Context`` a command gets; None only
            for a script installation.
        write (bool): whether invoking the command may mutate state.
        write_when (tuple[str, ...]): option spellings that make a leaf
            otherwise read-only a writer on the line that carries them.
        limit (Limit | None): default execution and output limits.
    """

    fn: Callable[..., Any] | None = None
    write: bool = False
    limit: Limit | None = None
    write_when: tuple[str, ...] = ()

    def writes(self, argv: Sequence[str]) -> bool:
        """Whether this invocation may mutate state.

        Args:
            argv (Sequence[str]): the words after the head, as typed.
        """
        return self.write or any(word in self.write_when for word in argv)


@dataclass(frozen=True)
class CLI:
    """Bind a command tree to handlers and installation configuration.

    Args:
        spec (CommandSpec): the shared grammar, including subcommands.
        handlers (Mapping[str, CLIHandler]): canonical paths below the
            root, separated by spaces; the root leaf uses an empty key.
        config_model (type[BaseModel] | None): installation config schema.
        accessor (Callable[..., Accessor]): builds the install's
            accessor from its validated config, once per install; a CLI
            that reaches no service keeps ``NOOPAccessor``.
        script (ScriptSource | None): program owning the whole installation.
        machine (str): the machine it runs on: ``in_process``, or for a
            script ``worker`` or ``host``.
        runtime (str | None): the runtime that runs the script on that
            machine; None for the first that speaks its language.
        mcp (MCPSource | None): the MCP tool list the tree was built
            from, so a snapshot rebuilds it without the server.
    """

    spec: CommandSpec
    handlers: Mapping[str, CLIHandler] = field(default_factory=dict)
    config_model: type[BaseModel] | None = None
    accessor: Callable[..., Accessor] = NOOPAccessor
    script: ScriptSource | None = None
    machine: str = IN_PROCESS
    runtime: str | None = None
    mcp: MCPSource | None = None

    def __post_init__(self) -> None:
        handlers = dict(self.handlers)
        if self.script is not None:
            handlers.setdefault("", CLIHandler())
            if not self.spec.arguments:
                object.__setattr__(
                    self, "spec", replace(self.spec, add_help=False)
                )
        object.__setattr__(self, "handlers", MappingProxyType(handlers))
        _validate_cli(self)


def placement_error(
    machine: str, runtime: str | None, script: bool
) -> str | None:
    """Why a CLI cannot run where it is placed; None when it can.

    A handler or MCP CLI runs in Mirage's own process. A script runs on
    a machine whose runtime Mirage hands it to, under the rules a
    ``machines:`` entry of that provider follows.

    Args:
        machine (str): the machine it runs on.
        runtime (str | None): the runtime it names there.
        script (bool): whether a script serves the CLI.
    """
    if not script:
        if machine != IN_PROCESS:
            return f"runs on {IN_PROCESS} only, not {machine!r}"
        if runtime is not None:
            return "runtime names what runs a script; it takes script"
        return None
    if machine not in SCRIPT_MACHINES:
        return (
            f"a script runs on {', '.join(SCRIPT_MACHINES)}, not {machine!r}"
        )
    if machine == HOST and runtime is not None:
        return "a host runs its own programs, not a runtime"
    if machine == WORKER and runtime not in (None, "monty"):
        return f"a worker runs 'monty', not {runtime!r}"
    return None


def _validate_cli(cli: CLI) -> None:
    """Validate bindings and every node before installing a CLI.

    Args:
        cli (CLI): definition being constructed.
    """
    name = cli.spec.name
    if cli.script is not None and cli.mcp is not None:
        raise ValueError(f"cli {name!r}: an MCP tree takes no script")
    if cli.script is not None:
        if cli.spec.subcommands:
            raise ValueError(
                f"cli {name!r}: a script serves the whole program"
            )
        if cli.config_model is not None:
            raise ValueError(
                f"cli {name!r}: script config is opaque; it cannot declare config_model"
            )
        if cli.accessor is not NOOPAccessor:
            raise ValueError(
                f"cli {name!r}: a script reaches its service itself; "
                "it cannot declare accessor"
            )
        if any(handler.fn is not None for handler in cli.handlers.values()):
            raise ValueError(
                f"cli {name!r}: a node takes fn or script, not both"
            )
    refused = placement_error(cli.machine, cli.runtime, cli.script is not None)
    if refused is not None:
        raise ValueError(f"cli {name!r}: {refused}")
    leaves = _validate_tree(cli.spec, (), {})
    missing = leaves - cli.handlers.keys()
    extra = cli.handlers.keys() - leaves
    if missing:
        raise ValueError(
            f"cli {name!r}: missing handlers for {sorted(missing)!r}"
        )
    if extra:
        raise ValueError(
            f"cli {name!r}: handlers do not name leaves: {sorted(extra)!r}"
        )
    if cli.script is None and any(
        handler.fn is None for handler in cli.handlers.values()
    ):
        raise ValueError(f"cli {name!r}: each leaf needs a handler fn")


def _validate_tree(
    node: CommandSpec,
    path: tuple[str, ...],
    ancestors: Mapping[str, Argument | None],
) -> set[str]:
    """Validate a command tree and return its canonical leaf paths.

    Args:
        node (CommandSpec): root or child grammar.
        path (tuple[str, ...]): canonical path below the root.
        ancestors (Mapping[str, Argument | None]): destinations already
            supplied by parents, each with the option that declares it.
            A node may repeat its parent's very object, which is how a
            program's global option stays legal at every level.
    """
    if not node.name or any(ch.isspace() for ch in node.name):
        raise ValueError(
            f"cli name {node.name!r} must be a single non-empty word"
        )
    for alias in node.aliases:
        if not alias or any(ch.isspace() for ch in alias):
            raise ValueError(
                f"cli {node.name!r}: alias {alias!r} must be a single non-empty word"
            )
    compiled = compile_spec(node)
    options = {argument_dest(option): option for option in compiled.options}
    own = {dest: options.get(dest) for dest in compiled.dest.values()}
    for dest in own.keys() & ancestors.keys():
        if own[dest] is None or own[dest] is not ancestors[dest]:
            raise ValueError(
                f"option {dest!r} collides with subcommand {' '.join(path)!r}"
            )
    if not node.subcommands:
        return {" ".join(path)}
    if compiled.positional or compiled.rest is not None:
        raise ValueError(
            f"cli {node.name!r}: positional arguments belong on leaves"
        )
    seen: set[str] = set()
    leaves: set[str] = set()
    for child in node.subcommands:
        for word in (child.name, *child.aliases):
            if word in seen:
                raise ValueError(
                    f"cli {node.name!r}: duplicate subcommand {word!r}"
                )
            seen.add(word)
        leaves.update(
            _validate_tree(child, (*path, child.name), {**ancestors, **own})
        )
    return leaves


@dataclass(frozen=True)
class WalkResult:
    """A resolved leaf and remaining argv, or a rendered help/refusal.

    Args:
        leaf (CommandSpec | None): resolved grammar; None for rendered output.
        path (tuple[str, ...]): canonical subcommand names below the head.
        verb_positions (tuple[int, ...]): where each of ``path`` stands
            in the walked argv.
        group_flags (WalkFlagBag): group flags keyed by canonical spelling.
        operand_bases (tuple[PathSpec, ...]): ordered directory changes.
        argv (tuple[str, ...]): remaining words for the leaf parser.
        output (bytes): rendered help or refusal when leaf is None.
        stream (Literal["stdout", "stderr"]): destination for output.
        exit_code (int): exit status for rendered output.
    """

    leaf: "CommandSpec | None" = None
    path: tuple[str, ...] = ()
    verb_positions: tuple[int, ...] = ()
    group_flags: WalkFlagBag = field(default_factory=FlagBag)
    operand_bases: tuple[PathSpec, ...] = ()
    argv: tuple[str, ...] = ()
    output: bytes = b""
    stream: Literal["stdout", "stderr"] = "stdout"
    exit_code: int = 0
