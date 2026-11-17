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

from mirage.commands.cli.walk import walk
from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.parser import ParsedArgs, word_paths
from mirage.commands.spec.types import WordKind
from mirage.policy.types import CommandWord
from mirage.types import PathSpec
from mirage.utils.path import resolve_path
from mirage.view.types import NamespaceLinks
from mirage.workspace.executor.builtins.links.links import follow_paths
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.command.cli import leaf_parse
from mirage.workspace.executor.command.routing import command_tree
from mirage.workspace.executor.command.types import LineReading
from mirage.workspace.lookup import SLASH_KEEPS_LAST
from mirage.workspace.mount import MountRegistry

Grammar = tuple[WordKind, str | None, PathSpec | None]


def _leaf_grammar(
    parsed: ParsedArgs, argv: Sequence[str], cwd: str, operands: bool
) -> list[Grammar]:
    """Each word as a flat grammar reads it: its kind, the option it
    carries attached and the path the grammar gives it.

    Args:
        parsed (ParsedArgs): the parse of ``argv``.
        argv (Sequence[str]): the words the parse read.
        cwd (str): working directory the line was typed under.
        operands (bool): whether a path operand takes the grammar's
            path, as a tree's does; a builtin's comes from the
            classifier.
    """
    paths = word_paths(parsed, argv, cwd, operands=operands)
    attached = {a.slot: a.option for a in parsed.attached}
    return [
        (role or WordKind.OPERAND, attached.get(slot), paths[slot])
        for slot, role in enumerate(parsed.word_roles)
    ]


def read_line(
    registry: MountRegistry,
    name: str,
    argv: Sequence[str],
    classified: Sequence[str | PathSpec],
    cwd: str,
    env: Mapping[str, str] | None = None,
) -> LineReading:
    """Read a command once, its words and the paths they name.

    A command tree (an installed CLI's, or a mount's) is walked as its
    run walks it: the walk names its verbs, group options and their
    values, and the leaf's grammar its own words, parsed with the run's
    own settings (``leaf_parse``). Any other command's
    words are read off its own spec, and a command no spec describes
    reads a dashed word as an option and anything else as an operand.
    A word's path is the classifier's, which carries the mount and the
    glob, else the grammar's: an option's value the classifier left as
    text, attached (``--file=x``) or not, and a tree's operand.

    Args:
        registry (MountRegistry): registry holding the CLI installs and
            the mounts.
        name (str): expanded command name.
        argv (Sequence[str]): the words after it, expanded.
        classified (Sequence[str | PathSpec]): the same words,
            classified.
        cwd (str): working directory the line was typed under.
        env (Mapping[str, str] | None): session environment, which fills
            a group option declaring ``Argument.env`` as the run's walk
            does.
    """
    tree = command_tree(registry, name, cwd, argv)
    result = (
        walk(name, tree.spec, list(argv), cwd, env)
        if tree is not None
        else None
    )
    supplied: list[PathSpec] = []
    grammar: list[Grammar]
    if tree is not None and result is not None and result.leaf is not None:
        rules = leaf_parse(tree, result.leaf, result.path)
        leaf = parse_command(
            rules.spec,
            list(result.argv),
            cwd,
            name,
            env,
            unknown_is_operand=rules.unknown_is_operand,
            abbreviations=rules.abbreviations,
        )
        grammar = [
            *((w.kind, w.option, w.path) for w in result.words),
            *_leaf_grammar(leaf, result.argv, cwd, operands=True),
        ]
        typed = {w.path.virtual for w in result.words if w.path is not None}
        for value in result.group_flags.values():
            items = value if isinstance(value, list) else [value]
            supplied += [
                item
                for item in items
                if isinstance(item, PathSpec) and item.virtual not in typed
            ]
        supplied += [_to_scope(v) for v in leaf.supplied_path_values]
        program = (name, *result.path)
        tokens = (*program, *result.argv)
    else:
        spec = SPECS.get(name)
        if spec is None:
            grammar = [
                (
                    WordKind.OPTION
                    if w.startswith("-") and w != "-"
                    else WordKind.OPERAND,
                    None,
                    None,
                )
                for w in argv
            ]
        else:
            parsed = parse_command(spec, list(argv), cwd, name)
            grammar = _leaf_grammar(parsed, argv, cwd, operands=False)
            supplied += [_to_scope(v) for v in parsed.supplied_path_values]
        program = (name,)
        tokens = (name, *argv)
    words: list[CommandWord] = []
    option: str | None = None
    for slot, text in enumerate(argv):
        kind, carried, spec_path = grammar[slot]
        word = classified[slot] if slot < len(classified) else text
        path = word if isinstance(word, PathSpec) else spec_path
        owner = option if kind is WordKind.VALUE else carried
        words.append(CommandWord(text, kind, owner, path))
        if kind is WordKind.OPTION:
            option = text
    return LineReading(tuple(words), tuple(supplied), tokens, program)


def context_words(
    name: str, reading: LineReading, redirects: Sequence[PathSpec]
) -> tuple[CommandWord, ...]:
    """The words a policy reads: the name first, then each word of the
    reading, then the statement's redirect targets.

    Args:
        name (str): expanded command name.
        reading (LineReading): the command, read.
        redirects (Sequence[PathSpec]): the statement's redirect
            targets.
    """
    return (
        CommandWord(name, WordKind.NAME),
        *reading.words,
        *(
            CommandWord(p.raw_path or p.virtual, WordKind.REDIRECT, path=p)
            for p in redirects
        ),
    )


def line_paths(
    name: str,
    reading: LineReading,
    follows: bool,
    links: NamespaceLinks | None,
    cwd: str,
    implied: PathSpec | None = None,
    redirects: Sequence[PathSpec] = (),
) -> list[PathSpec]:
    """Every path a line reaches, the one list a path guard reads.

    The paths the words name, in the order they stand, an operand typed
    twice twice (``cat a a``); then those carried attached to an option
    (``--file=x``) and the values no word typed (a default, the
    environment). A slash-carrying name is a file the line executes, so
    it comes first. Then the link targets the command will reach: an
    operand's by the command's own follow policy (``rm``, ``mv``,
    ``tar`` act on a link itself), an option's always, since the command
    opens the file (``--attach link.csv`` sends the file the link
    names). Then the working directory a bare ``ls`` reads, which the
    executor injects after the gate. Last the redirect targets and
    theirs, which the shell opens on its own fds outside the command's
    gate window, so this is the one place a rule can see them.

    Args:
        name (str): expanded command name.
        reading (LineReading): the command, read.
        follows (bool): whether the command may resolve an operand's
            last component (``LineFacts.follows`` is not NONE).
        links (NamespaceLinks | None): the session's link table; None
            where no link stands.
        cwd (str): working directory the line was typed under.
        implied (PathSpec | None): the working-directory operand the
            command reads when typed bare.
        redirects (Sequence[PathSpec]): the statement's redirect
            targets.
    """
    named = [w for w in reading.words if w.path is not None]
    scopes = [w.path for w in named if w.kind is not WordKind.OPTION]
    seen = {p.virtual for p in scopes if p is not None}

    def add(items: Sequence[str | PathSpec | None]) -> None:
        for item in items:
            if isinstance(item, PathSpec) and item.virtual not in seen:
                seen.add(item.virtual)
                scopes.append(item)

    add([w.path for w in named if w.kind is WordKind.OPTION])
    add(reading.supplied)
    if "/" in name:
        scopes.insert(0, _to_scope(resolve_path(name, cwd)))
    if links is not None:
        operands: list[str | PathSpec] = [
            w.path
            for w in named
            if w.path is not None and w.kind is WordKind.OPERAND
        ]
        options: list[str | PathSpec] = [
            w.path
            for w in named
            if w.path is not None and w.kind is not WordKind.OPERAND
        ]
        add(
            follow_paths(
                links,
                operands,
                follows,
                slash_follows=name not in SLASH_KEEPS_LAST,
            )
        )
        add(follow_paths(links, [*options, *reading.supplied], True))
    add([implied])
    add(redirects)
    if links is not None:
        add(follow_paths(links, list(redirects), True))
    return [p for p in scopes if p is not None]
