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

from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel

from mirage.commands.spec.types import CommandSpec
from mirage.types import CommandSafeguard


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
        safeguard (CommandSafeguard | None): safeguard category for the
            leaf.
        config_model (type[BaseModel] | None): root only. Pydantic model
            validating an installation's config from YAML ``clis:`` or
            ``register_cli``; also the redaction schema for snapshots.
    """
    name: str = ""
    fn: Callable[..., Any] | None = None
    subcommands: tuple["CLISpec", ...] = ()
    write: bool = False
    safeguard: CommandSafeguard | None = None
    config_model: type[BaseModel] | None = None

    def __post_init__(self) -> None:
        if not self.name or " " in self.name:
            raise ValueError(
                f"cli name {self.name!r} must be a single non-empty word")
        if self.fn is not None and self.subcommands:
            raise ValueError(
                f"cli {self.name!r}: a node takes fn or subcommands, "
                f"not both")
        if self.fn is None and not self.subcommands:
            raise ValueError(
                f"cli {self.name!r}: a node needs fn or subcommands")
        if self.subcommands and (self.positional or self.rest is not None):
            raise ValueError(
                f"cli {self.name!r}: a group's operand is its subcommand "
                f"word; positional/rest belong on leaves")
        seen: set[str] = set()
        for child in self.subcommands:
            if child.name in seen:
                raise ValueError(f"cli {self.name!r}: duplicate subcommand "
                                 f"{child.name!r}")
            seen.add(child.name)
            if child.config_model is not None:
                raise ValueError(
                    f"cli {self.name!r}: subcommand {child.name!r} declares "
                    f"config_model; only the root of a tree may")
