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

import dataclasses
from collections.abc import Mapping, Sequence

from mirage.commands.builtin.find_parse import find_expr_tail
from mirage.commands.builtin.generic.grep import directories_action
from mirage.commands.builtin.generic.program import FILE_KEYS
from mirage.commands.cli.types import CLI
from mirage.commands.cli.walk import walk
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.builtins import is_builtin_grammar
from mirage.commands.spec.constants import (
    OWN_OPTION_LOOP,
    REFUSED,
    STDIN_DASH_COMMANDS,
    STDIN_DASH_LEADING,
)
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandSpec, WordKind
from mirage.core.awk.builtins import split_assignment
from mirage.io.types import ByteSource, DeviceInput
from mirage.policy.types import CommandWord
from mirage.types import PathSpec
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.mount import MountRegistry

# Commands a bare invocation points at the working directory, mapped to
# the typed spelling their synthetic operand carries. GNU find/tree/du/
# ls behave exactly as if `.` had been typed (./-prefixed output); GNU
# grep -r and bare rg print bare relative names (empty raw). Two gates:
# grep only defaults under -r/-R (and ignores stdin, GNU's rule); rg
# yields to an attached stdin, even an empty one (its readable-stdin
# rule), unless `-f -` reads it for patterns or --files lists. All pinned on
# debian:stable-slim / ripgrep 14.
CWD_DEFAULT_RAW = {
    "grep": "",
    "rg": "",
    "find": ".",
    "tree": ".",
    "du": ".",
    "ls": ".",
}

# The path options whose file the handler itself reads or writes through
# the dispatcher, keyed by command, valued by kwarg name: curl's -o and
# -D, jq's --rawfile and --slurpfile, rg's --ignore-file, and grep's
# --exclude-from, which the executor reads with the pattern files. Like a
# program file, such a file is no operand of the mount the line runs on, so
# it routes nothing: the line runs where its positional operands (or the
# cwd) put it, and `-o` and `-D` on two mounts, or `--slurpfile` over a
# process substitution, is not cross-mount.
DISPATCH_FLAG_KEYS: dict[str, tuple[str, ...]] = {
    "curl": ("output", "dump_header"),
    "grep": ("exclude_from",),
    "rg": ("ignore_file",),
    "jq": ("rawfile", "slurpfile"),
}


def default_cwd_operand(
    parts: list[str | PathSpec],
    cmd_name: str,
    registry: MountRegistry,
    cwd: str,
    stdin: ByteSource | None,
) -> PathSpec | None:
    """The synthetic cwd operand for a CWD_DEFAULT_RAW command typed bare.

    Injected before routing, so mount resolution, fan-out across
    descendant mounts, and :func:`respell_raw` treat it exactly like a
    typed operand; backends never see the difference.

    Args:
        parts (list[str | PathSpec]): classified command words.
        cmd_name (str): command name (a CWD_DEFAULT_RAW key).
        registry (MountRegistry): mount registry resolving the cwd.
        cwd (str): session working directory.
        stdin (ByteSource | None): the line's stdin, consulted for rg.
    """
    spec = SPECS.get(cmd_name)
    if spec is None:
        return None
    # A typed `-` goes back to the parser as itself, as it does from
    # `parse_flags`, so `rg -f -` reads as stdin rather than a file `/-`.
    argv = [
        ("-" if p.raw_path == "-" else p.virtual)
        if isinstance(p, PathSpec)
        else p
        for p in parts[1:]
    ]
    if cmd_name == "find":
        # Only the words before the expression can be start points: an
        # `-exec` command word or a `-newer` reference is the parser's.
        argv = argv[: len(argv) - len(find_expr_tail(argv))]
    parsed = parse_command(spec, argv, cwd, cmd_name)
    if parsed.paths():
        return None
    if cmd_name == "rg" and FlagView(
        parse_to_kwargs(parsed), spec=spec
    ).as_bool("type_list"):
        # --type-list reads no path, so there is no cwd to walk.
        return None
    if cmd_name == "grep":
        fl = FlagView(parse_to_kwargs(parsed), spec=spec)
        if directories_action(fl) != "recurse":
            return None
    elif (
        cmd_name == "rg"
        and stdin is not None
        and not isinstance(stdin, DeviceInput)
    ):
        fl = FlagView(parse_to_kwargs(parsed), spec=spec)
        # `-f -` reads the attached stdin for patterns first, and --files
        # lists rather than searches, and either leaves ripgrep nothing to
        # do with stdin but walk the cwd instead. A stdin that is no file,
        # FIFO or socket (`< /dev/null`) is not searched either
        # (grep_cli::is_readable_stdin, ripgrep 14.1.1).
        if "-" not in fl.as_list("file") and not fl.as_bool("files"):
            return None
    operand = classify_bare_path(".", registry, cwd)
    if not isinstance(operand, PathSpec):
        return None
    return dataclasses.replace(operand, raw_path=CWD_DEFAULT_RAW[cmd_name])


def path_flag_scopes(
    cmd_name: str, argv: list[str], cwd: str
) -> list[PathSpec]:
    spec = SPECS.get(cmd_name)
    if spec is None:
        return []
    parsed = parse_command(spec, argv, cwd, cmd_name)
    kwargs = parse_to_kwargs(parsed)
    flag_paths = list(parsed.path_flag_values)
    # A program file and a dispatched option's file are read or written
    # through the dispatcher, not on the line's mount. A pair's name
    # slots are words, never resolved paths, so they match nothing here.
    for key in (
        FILE_KEYS.get(cmd_name),
        *DISPATCH_FLAG_KEYS.get(cmd_name, ()),
    ):
        if key is None:
            continue
        value = kwargs.get(key)
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str) and item in flag_paths:
                flag_paths.remove(item)
    return [
        PathSpec(virtual=value, directory=value, vfs_path="", raw_path=value)
        for value in flag_paths
    ]


def tree_path_scopes(
    registry: MountRegistry,
    name: str,
    argv: Sequence[str],
    cwd: str,
    env: Mapping[str, str] | None = None,
) -> list[PathSpec]:
    """The path-valued options a command tree's walk resolves.

    ``path_flag_scopes`` reads the built-in specs, which hold no tree, and
    a tree's words are classified as its walk reads them, its group
    options as text. So a tree's group options and its leaf's are read
    here, walked as the run walks them: ``notes --file /data/secret show``
    hands the leaf ``/data/secret``, and a rule protecting it has to see
    it.

    Args:
        registry (MountRegistry): registry holding the CLI installs and
            the mounts.
        name (str): expanded command name.
        argv (Sequence[str]): the words after it, as typed.
        cwd (str): session working directory.
        env (Mapping[str, str] | None): session environment, which fills
            options the walk needs to reach the leaf.
    """
    tree = command_tree(registry, name, cwd)
    if tree is None:
        return []
    result = walk(name, tree.spec, list(argv), cwd, env)
    if result.leaf is None:
        return []
    found: list[PathSpec] = []
    for value in result.group_flags.values():
        items = value if isinstance(value, list) else [value]
        found += [item for item in items if isinstance(item, PathSpec)]
    leaf = parse_command(
        result.leaf,
        list(result.argv),
        cwd,
        name,
        env,
        unknown_is_operand=True,
    )
    found += [
        PathSpec(virtual=value, directory=value, vfs_path="", raw_path=value)
        for value in leaf.path_flag_values
    ]
    return found


def positional_scopes(
    cmd_name: str, argv: list[str], cwd: str, words: list[str | PathSpec]
) -> list[PathSpec]:
    """The path operands a line names positionally, flag values left out.

    Classification turns every path-shaped word into a PathSpec,
    including the value of a path-valued flag, so the classified word
    list cannot tell ``tar -xf a.tar -C /mnt`` (extract INTO a mount)
    from ``tar -cf a.tar /mnt`` (archive a whole mount). Only the spec
    knows which slot a word filled, so this asks it and keeps the
    classified spec for each surviving operand, whose ``raw_path`` is
    what a message should name.

    Args:
        cmd_name (str): command name.
        argv (list[str]): the words after the command name, as typed.
        cwd (str): working directory the line was typed under.
        words (list[str | PathSpec]): the same words, classified.
    """
    spec = SPECS.get(cmd_name)
    if spec is None:
        return [p for p in words if isinstance(p, PathSpec)]
    parsed = parse_command(spec, argv, cwd, cmd_name)
    by_virtual = {p.virtual: p for p in words if isinstance(p, PathSpec)}
    return [
        by_virtual.get(
            value,
            PathSpec(
                virtual=value, directory=value, vfs_path="", raw_path=value
            ),
        )
        for value in parsed.paths()
    ]


def option_loop_exits(
    cmd_name: str, spec: CommandSpec | None, argv: list[str], cwd: str
) -> bool:
    """Whether a handler's option loop must exit before reading operands.

    Help, version and deferred refusals leave no input files to route.
    The handler still decides which answer or earlier binding error wins.

    Args:
        cmd_name (str): command name.
        spec (CommandSpec | None): the registered command's grammar.
        argv (list[str]): words after the command name.
        cwd (str): working directory.
    """
    if (
        spec is None
        or cmd_name not in OWN_OPTION_LOOP
        or not is_builtin_grammar(cmd_name, spec)
    ):
        return False
    parsed = parse_command(spec, argv, cwd, cmd_name)
    fl = FlagView(parse_to_kwargs(parsed), spec=spec)
    return bool(fl.occurrences("help", "version", REFUSED))


def routed_operands(
    cmd_name: str,
    argv: list[str],
    cwd: str,
    words: list[str | PathSpec],
    path_scopes: list[PathSpec],
) -> list[PathSpec]:
    """The classified path words that route a line.

    Classification makes a dispatched option's file a path word like any
    other, so a command in DISPATCH_FLAG_KEYS routes by its positional
    operands alone; every other command by all its path words.

    Args:
        cmd_name (str): command name.
        argv (list[str]): the words after the command name, as typed.
        cwd (str): working directory the line was typed under.
        words (list[str | PathSpec]): the same words, classified.
        path_scopes (list[PathSpec]): the line's classified path words.
    """
    if cmd_name not in DISPATCH_FLAG_KEYS:
        return path_scopes
    return positional_scopes(cmd_name, argv, cwd, words)


def routable_scopes(cmd_name: str, scopes: list[PathSpec]) -> list[PathSpec]:
    """Drop the operands that name no path from a line's routing words.

    An awk ``var=value`` operand is an assignment awk makes when its
    input reaches it, so it routes nowhere: ``awk p /data/a x=1
    /data/b`` runs on /data like the same line without it. A lone ``-``
    is standard input to the commands in ``STDIN_DASH_COMMANDS``, so it
    routes nowhere either, past ``STDIN_DASH_LEADING``'s leading
    operands only where it names an output (split's PREFIX).

    Args:
        cmd_name (str): command name.
        scopes (list[PathSpec]): the line's routing path words.
    """
    if cmd_name in STDIN_DASH_COMMANDS:
        leading = STDIN_DASH_LEADING.get(cmd_name, len(scopes))
        scopes = [
            s
            for index, s in enumerate(scopes)
            if s.raw_path != "-" or index >= leading
        ]
    if cmd_name != "awk":
        return scopes
    return [s for s in scopes if split_assignment(s.raw_path) is None]


def merge_scopes(
    positional: list[PathSpec], flag_scopes: list[PathSpec]
) -> list[PathSpec]:
    """Combine positional and path-flag scopes, keeping operand order.

    Args:
        positional (list[PathSpec]): Path operands parsed from the argv tail.
        flag_scopes (list[PathSpec]): Paths carried by path-valued flags.
    """
    merged = list(positional)
    seen = {p.virtual for p in merged}
    for scope in flag_scopes:
        if scope.virtual not in seen:
            seen.add(scope.virtual)
            merged.append(scope)
    return merged


def command_tree(registry: MountRegistry, name: str, cwd: str) -> CLI | None:
    """The command tree a head word walks: an installed CLI's, else one
    the mount serving the name registered (``MountEntry.cli_for``).

    A tree on a mount runs on the mount that serves its name, the working
    directory's when it has one, else the first that does, never by
    operand path: its walk, not a spec, says which words are paths.

    Args:
        registry (MountRegistry): registry holding the CLI installs and
            the mounts.
        name (str): expanded command name.
        cwd (str): session working directory.
    """
    install = registry.clis.get(name)
    if install is not None:
        return install.cli
    mount = registry.command_mount(name, [], cwd)
    tree = mount.cli_for(name) if mount is not None else None
    return tree if isinstance(tree, CLI) else None


def program_tokens(
    registry: MountRegistry,
    name: str,
    argv: Sequence[str],
    cwd: str,
    env: Mapping[str, str] | None = None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The line as an admission pattern reads it, and the program it runs.

    For a command tree's head (an installed CLI, or a tree a mount
    serves) the spec walk names the verb path (global options before the
    verb dropped, an alias canonicalized) and hands back the leaf's own
    words, so ``git -C /r push origin`` reads as ``git push origin`` and
    a rule on ``git push`` catches it; a walk the tree refuses (unknown
    verb, bare group, usage error) reads the raw words, since the line
    fails on its own. Anything else is the name and the raw argv, and
    the program is the bare name.

    Args:
        registry (MountRegistry): registry holding the CLI installs.
        name (str): expanded command name.
        argv (Sequence[str]): the words after it.
        cwd (str): session working directory, for the walk's PATH-typed
            group values.
        env (Mapping[str, str] | None): session environment, which fills
            a group option declaring ``Argument.env`` as the run's walk
            does.
    """
    tree = command_tree(registry, name, cwd)
    if tree is not None:
        result = walk(name, tree.spec, argv, cwd, env)
        if result.leaf is not None:
            program = (name, *result.path)
            return (*program, *result.argv), program
    return (name, *argv), (name,)


def _parsed_kinds(
    spec: CommandSpec | None,
    argv: Sequence[str],
    cwd: str,
    cmd_name: str,
    cli: bool = False,
) -> list[WordKind]:
    """Each word's kind as a command's grammar reads it: an option, an
    option's value or an operand. A command no spec describes reads a
    dashed word as an option and anything else as an operand.

    Args:
        spec (CommandSpec | None): the command's grammar.
        argv (Sequence[str]): the words after the command name.
        cwd (str): working directory the line was typed under.
        cmd_name (str): command name.
        cli (bool): whether the spec is an installed CLI's node, whose
            undeclared dashed words are the program's own operands.
    """
    if spec is None:
        return [
            WordKind.OPTION
            if w.startswith("-") and w != "-"
            else WordKind.OPERAND
            for w in argv
        ]
    parsed = parse_command(
        spec, list(argv), cwd, cmd_name, unknown_is_operand=cli
    )
    return [role or WordKind.OPERAND for role in parsed.word_roles]


def command_words(
    registry: MountRegistry,
    name: str,
    argv: Sequence[str],
    classified: Sequence[str | PathSpec],
    redirects: Sequence[PathSpec],
    cwd: str,
    env: Mapping[str, str] | None = None,
) -> tuple[CommandWord, ...]:
    """The command line word by word, each with its kind and the path
    it names.

    The name comes first and the redirect targets last. A command
    tree's verbs (an installed CLI's, or a mount's) are read off the tree
    and its leaf's words off the leaf's grammar; any other command's
    words off its own spec.

    Args:
        registry (MountRegistry): registry holding the CLI installs.
        name (str): expanded command name.
        argv (Sequence[str]): the words after it, expanded.
        classified (Sequence[str | PathSpec]): the same words,
            classified.
        redirects (Sequence[PathSpec]): the statement's redirect
            targets.
        cwd (str): working directory the line was typed under.
        env (Mapping[str, str] | None): session environment, which fills
            a group option declaring ``Argument.env`` as the run's walk
            does.
    """
    tree = command_tree(registry, name, cwd)
    result = (
        walk(name, tree.spec, argv, cwd, env) if tree is not None else None
    )
    if result is not None and result.leaf is not None:
        lead = len(argv) - len(result.argv)
        kinds = [
            *(
                WordKind.SUBCOMMAND
                if i in result.verb_positions
                else WordKind.OPTION
                if word.startswith("-")
                else WordKind.VALUE
                for i, word in enumerate(argv[:lead])
            ),
            *_parsed_kinds(result.leaf, argv[lead:], cwd, name, cli=True),
        ]
    else:
        kinds = _parsed_kinds(SPECS.get(name), argv, cwd, name)
    words = [CommandWord(name, WordKind.NAME)]
    option: str | None = None
    for index, (text, kind) in enumerate(zip(argv, kinds, strict=True)):
        word = classified[index] if index < len(classified) else text
        path = word if isinstance(word, PathSpec) else None
        words.append(
            CommandWord(
                text, kind, option if kind is WordKind.VALUE else None, path
            )
        )
        if kind is WordKind.OPTION:
            option = text
    words.extend(
        CommandWord(p.raw_path or p.virtual, WordKind.REDIRECT, path=p)
        for p in redirects
    )
    return tuple(words)
