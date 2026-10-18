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

from mirage.commands.builtin.find_parse import exec_spans
from mirage.commands.cli.walk import walk
from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import CommandSpec, ValueType
from mirage.utils.glob_walk import unmark_globs
from mirage.workspace.executor.command.routing import command_tree
from mirage.workspace.mount import MountRegistry


def spec_for_command(
    name: str,
    registry: MountRegistry,
    cwd: str,
) -> CommandSpec | None:
    """Find the spec that classifies a mount command's words.

    A command tree a mount serves is classified by its tree, which
    ``spec_word_kinds`` walks, wherever the line is typed: the tree runs
    on the mount serving its name. Otherwise the cwd mount's spec wins;
    the shared SPECS table fills in when that mount does not register the
    command. Every absolute path has a mount (the workspace roots an
    implicit RAM mount), so mount_for never fails here; if it ever does,
    the registry is broken and the error should propagate.

    Args:
        name (str): expanded command name.
        registry (MountRegistry): mount registry.
        cwd (str): current working directory.
    """
    tree = command_tree(registry, name, cwd)
    if tree is not None:
        return tree.spec
    spec = registry.mount_for(cwd).spec_for(name)
    if spec is not None:
        return spec
    return SPECS.get(name)


def spec_word_kinds(
    spec: CommandSpec,
    argv: list[str],
    name: str = "",
    env: Mapping[str, str] | None = None,
) -> list[ValueType | None]:
    """Classify argv words into per-position operand kinds.

    Delegates to parse_command so flag syntax (clusters, --flag=value,
    multiple flags, provided_by) classifies identically to dispatch.
    Kinds are positional, not value sets, so the same word can be TEXT
    in one slot and PATH in another (`grep '*.txt' *.txt`). A flag token
    is TEXT even when it carries a path (`sort -o/data/s1.txt`): the
    parser resolves the value, and the shape heuristic would read the
    whole word as a path under the cwd.

    find's ``-exec`` is the one grammar a spec cannot state (an option
    whose argument is a program, up to a terminator), so its words are
    overridden to TEXT here: the rest slot would otherwise read
    ``echo``, ``{}`` and ``;`` as start points. A command tree's words
    are walked first, as its line runs: the verbs and group options are
    TEXT, and the leaf's words are its grammar's, its undeclared dashed
    words operands, as a CLI leaf parses them, under the session
    environment the run walks with: a required group option it fills
    would otherwise stop the walk short of the leaf.

    Examples:
        cat file.txt           → [PATH]
        grep pattern file.txt  → [TEXT, PATH]
        find /data -name *.txt → [PATH, TEXT, TEXT]
        sort -o/d/s.txt in.txt → [TEXT, PATH]

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
        name (str): the command name, which is what says the words are
            find's.
        env (Mapping[str, str] | None): the session environment a
            command tree's walk reads ``Argument.env`` from.
    """
    # parse_command classifies ignore_tokens as TEXT itself, so there is
    # nothing to override here: leaving them None sent `find \( ... \)`
    # back to the shape heuristic, which read "(" as the bare path "/(".
    literal = [unmark_globs(word) for word in argv]
    if spec.subcommands:
        result = walk(name, spec, literal, "/", env)
        if result.leaf is None:
            return ["str"] * len(literal)
        lead: list[ValueType | None] = ["str"] * (
            len(literal) - len(result.argv)
        )
        return lead + list(
            parse_command(
                result.leaf,
                list(result.argv),
                cwd="/",
                cmd_name=name,
                env=env,
                unknown_is_operand=True,
            ).word_kinds
        )
    kinds = list(
        parse_command(
            spec, literal, cwd="/", cmd_name=name, env=env
        ).word_kinds
    )
    if name == "find":
        for start, end in exec_spans(literal):
            for i in range(start, end + 1):
                kinds[i] = "str"
    return kinds


def spec_word_bases(
    spec: CommandSpec,
    argv: list[str],
    cwd: str,
    name: str = "",
    env: Mapping[str, str] | None = None,
) -> list[str | None] | None:
    """Per-position base directories for a spec that declares one.

    tar's -C is a chdir for the operands typed after it, so those words
    are not relative to the session cwd at all. The parser already walks
    the line positionally, so it is what says where each word stood;
    this asks it, and only for the one command family that can answer
    (None everywhere else, so 92 of 93 specs pay nothing). A command
    tree's leaf declares its own, so a tree is walked to the leaf first,
    as ``spec_word_kinds`` walks it.

    Args:
        spec (CommandSpec): command specification.
        argv (list[str]): command arguments (without command name).
        cwd (str): the working directory the line was typed under.
        name (str): the command name.
        env (Mapping[str, str] | None): the session environment a
            command tree's walk reads ``Argument.env`` from.
    """
    literal = [unmark_globs(word) for word in argv]
    if spec.subcommands:
        result = walk(name, spec, literal, cwd, env)
        if result.leaf is None or result.leaf.operand_base is None:
            return None
        lead: list[str | None] = [None] * (len(literal) - len(result.argv))
        return lead + list(
            parse_command(
                result.leaf,
                list(result.argv),
                cwd=cwd,
                cmd_name=name,
                env=env,
                unknown_is_operand=True,
            ).word_bases
        )
    if spec.operand_base is None:
        return None
    return list(parse_command(spec, literal, cwd=cwd, env=env).word_bases)
