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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace

from mirage.commands.cli.constants import CLAP_EXIT, GIT_SYNOPSES, USAGE_EXIT
from mirage.commands.cli.refusal import HELP_SWITCH, git_option_refusal
from mirage.commands.cli.types import CLI, WalkFlagBag, WalkResult
from mirage.commands.spec.compile import (
    CompiledSpec,
    compile_spec,
    expand_long,
)
from mirage.commands.spec.constants import (
    FLOAT_VALUE,
    HELP_OPTION,
    INT_VALUE,
    NEGATIVE_NUMBER,
)
from mirage.commands.spec.help import (
    argparse_help,
    clap_group_refusal,
    clap_unexpected_argument,
    render_help,
)
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec


def _verb_display(child: CommandSpec) -> str:
    """A subcommand's row label: ``name (alias, ...)`` like argparse.

    Args:
        child (CommandSpec): the subcommand node.
    """
    if child.aliases:
        return f"{child.name} ({', '.join(child.aliases)})"
    return child.name


def find_child(node: CommandSpec, word: str) -> CommandSpec | None:
    """The subcommand a word names, by canonical name or alias.

    Args:
        node (CommandSpec): the group being descended.
        word (str): the verb word as typed.
    """
    return next(
        (c for c in node.subcommands if word == c.name or word in c.aliases),
        None,
    )


def find_node(
    spec: CommandSpec, verbs: Sequence[str]
) -> tuple[CommandSpec, tuple[str, ...]] | None:
    """Descend a tree by verb words, None if a word names no subcommand.

    Returns the node and its canonical path, so an alias renders under
    the name it resolves to, the attribution rule ``walk`` uses. This is
    introspection only (``man``): no options are parsed and no usage
    error is produced, so a caller gets the node or nothing.

    Args:
        spec (CommandSpec): the root of the tree.
        verbs (Sequence[str]): verb words after the head, aliases
            allowed.
    """
    node = spec
    path: tuple[str, ...] = ()
    for word in verbs:
        child = find_child(node, word)
        if child is None:
            return None
        node = child
        path = path + (child.name,)
    return node, path


def env_names(node: CommandSpec) -> frozenset[str]:
    """Every ``Argument.env`` variable a program tree reads.

    The env-plane fill step asks this per installed head word on the
    line, so a managed name a CLI reads from the environment joins the
    fetch set even though no ``$NAME`` appears in the line's text.

    Args:
        node (CommandSpec): the tree's root (or any subtree).
    """
    out = {
        opt.env for opt in compile_spec(node).options if opt.env is not None
    }
    for child in node.subcommands:
        out |= env_names(child)
    return frozenset(out)


def invoked_env_names(
    spec: CommandSpec, words: frozenset[str] | None
) -> frozenset[str]:
    """Env names on the verb paths the line's words could select.

    The words prune the tree: a subcommand joins only when some word
    spells its name or an alias, recursively, so a bare head reads the
    root's env names and ``ntn api get`` adds exactly the api and get
    nodes. A word doubling as an operand over-selects, which costs one
    fetch; a verb can never hide, because dispatch only runs a verb the
    line spells. None means a word no static read can spell (an
    expansion), where the whole tree is the only safe answer.

    Args:
        spec (CommandSpec): the tree's root (or any subtree).
        words (frozenset[str] | None): the invocation's literal
            argument words, None when one was dynamic.
    """
    if words is None:
        return env_names(spec)
    out = {
        opt.env for opt in compile_spec(spec).options if opt.env is not None
    }
    for child in spec.subcommands:
        if child.name in words or any(
            alias in words for alias in child.aliases
        ):
            out |= invoked_env_names(child, words)
    return frozenset(out)


def _optional_value(token: str | None) -> bool:
    """Whether a following word can supply an optional argument value."""
    return token is not None and (
        not token.startswith("-")
        or token == "-"
        or bool(NEGATIVE_NUMBER.match(token))
    )


def _supplied_option(
    cs: CompiledSpec, token: str, following: Sequence[str]
) -> tuple[str, int] | None:
    """The exact spelling certainly supplied by a dash token and its width."""
    if token.startswith("--"):
        spelling, eq, _ = token.partition("=")
        arity = cs.nargs_by_dest.get(cs.dest_of(spelling))
        if arity == 1 and eq:
            return spelling, 1
        if arity is not None:
            return (
                (spelling, arity + 1)
                if not eq and len(following) >= arity
                else None
            )
        if spelling in cs.long_optional_spellings:
            detached = (
                not eq
                and spelling in cs.detached_optional_spellings
                and _optional_value(following[0] if following else None)
            )
            return spelling, 2 if detached else 1
        if spelling in cs.long_bool_spellings:
            return None if eq else (spelling, 1)
        if spelling in cs.long_value_spellings:
            if eq:
                return spelling, 1
            return (spelling, 2) if following else None
        return None
    for vf in cs.attach_spellings:
        if token.startswith(vf) and len(token) > len(vf):
            return vf, 1
    for vf in cs.value_spellings:
        if token == vf or token.startswith(vf):
            arity = cs.nargs_by_dest.get(cs.dest_of(vf), 1)
            remaining = arity - (len(token) > len(vf))
            return (vf, remaining + 1) if len(following) >= remaining else None
    if token in cs.bool_spellings:
        detached = token in cs.detached_optional_spellings and _optional_value(
            following[0] if following else None
        )
        return token, 2 if detached else 1
    return None


def _claimed(
    carriers: Sequence[Mapping[str, str]], supplied: set[tuple[int, str]]
) -> frozenset[str]:
    """Variables every visited reader of which was supplied.

    Args:
        carriers (Sequence[Mapping[str, str]]): each visited level's
            ``env_by_dest`` table, in walk order.
        supplied (set[tuple[int, str]]): the (level, destination) pairs
            the line certainly fills.
    """
    claimed: set[str] = set()
    blocked: set[str] = set()
    for level, table in enumerate(carriers):
        for dest, variable in table.items():
            if (level, dest) in supplied:
                claimed.add(variable)
            else:
                blocked.add(variable)
    return frozenset(claimed - blocked)


def supplied_env_names(
    spec: CommandSpec, args: Sequence[str]
) -> frozenset[str]:
    """Env names whose every reader on the walked path is supplied.

    The parser never reads ``Argument.env`` for a destination the line
    already fills (typed outranks environment), so a supplied option's
    managed variable is not a read and must not fetch: a dead source
    would otherwise fail a line that never consults it. Tracking is by
    destination, never by bare name: two options may declare one
    variable, and a variable shared by a supplied and an unsupplied
    destination stays a read, because the unsupplied one still falls
    back to it. Presence is claimed only where consumption is certain,
    walking level by level the way ``walk`` does and matching only the
    exact-token forms. Anything subtler stops the scan -- keeping what
    was proven for a word that only ends option parsing (an operand
    under a remainder leaf, a verb that matches nothing; ``--`` also
    drops every variable readable below the group, since the walk
    keeps descending after it), and keeping nothing for a word whose
    consumption is in doubt (a cluster, an abbreviation, ``--help``) --
    so a wrong guess can only over-fetch, never skip a real read.

    Args:
        spec (CommandSpec): the installed tree's root.
        args (Sequence[str]): the invocation's literal argument words.
    """
    supplied: set[tuple[int, str]] = set()
    node = spec
    cs = compile_spec(node)
    carriers: list[Mapping[str, str]] = [cs.env_by_dest]
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--":
            below: set[str] = set()
            for sub in node.subcommands:
                below |= env_names(sub)
            return _claimed(carriers, supplied) - below
        if token.startswith("-") and token != "-":
            if token == "--help" or token.startswith("--help="):
                return frozenset()
            hit = _supplied_option(cs, token, args[i + 1 :])
            if hit is None:
                return frozenset()
            spelling, consumed = hit
            supplied.add((len(carriers) - 1, cs.dest_of(spelling)))
            i += consumed
            continue
        if not node.subcommands:
            if cs.remainder:
                return _claimed(carriers, supplied)
            i += 1
            continue
        child = find_child(node, token)
        if child is None:
            return _claimed(carriers, supplied)
        node = child
        cs = compile_spec(node)
        carriers.append(cs.env_by_dest)
        i += 1
    return _claimed(carriers, supplied)


def owns_argv(cli: CLI) -> bool:
    """Whether a script installation owns its complete argument list.

    Args:
        cli (CLI): registered execution and grammar.
    """
    return cli.script is not None and not cli.spec.arguments


def node_help(
    name: str,
    node: CommandSpec,
    style: UsageStyle = UsageStyle.ARGPARSE,
    visible: Callable[[str], bool] | None = None,
) -> str:
    """A group node's help: the ordinary command help plus Commands rows.

    One renderer serves leaves and groups (a group is a spec whose
    operand is the subcommand word); the same text serves ``--help``
    (stdout, exit 0) and the bare-group refusal (stdout, exit 1,
    matching git).

    Args:
        name (str): full display path as typed, e.g. "gws gmail"; the
            head word is the installed name, so a renamed install
            renders its own spelling.
        node (CommandSpec): the group node.
        style (UsageStyle): the ROOT's dialect, never the node's: a
            program answers in one voice at every level, the same rule
            the leaf refusal follows.
        visible (Callable[[str], bool] | None): filter on a child's
            canonical name, None to list every child. Help, man and
            generated skills use the reading session's visibility.
    """
    if style in (UsageStyle.ARGPARSE, UsageStyle.COBRA):
        return argparse_help(
            name, listed_node(node, style), _rows(node, visible)
        )
    return render_help(
        name,
        listed_node(node, style),
        subcommands=_rows(node, visible),
        style=style,
    )


def _rows(
    node: CommandSpec, visible: Callable[[str], bool] | None = None
) -> list[tuple[str, str]]:
    """The node's child rows, as the renderer lists them.

    Args:
        node (CommandSpec): the group node.
        visible (Callable[[str], bool] | None): filter on a child's
            canonical name, None to list every child.
    """
    return [
        (_verb_display(child), child.description or "")
        for child in node.subcommands
        if visible is None or visible(child.name)
    ]


def listed_node(
    node: CommandSpec, style: UsageStyle = UsageStyle.ARGPARSE
) -> CommandSpec:
    """The node as the renderer shows it, with `--help` filled in.

    --help is a registered option everywhere (argparse add_help, click
    add_help_option, withHelpSupport for leaves), so the listing shows
    it unless the node declares its own or answers the flag itself
    (owns_argv), where advertising it would promise a page mirage no
    longer renders. A refusal renders the same node a help page would,
    or its usage line would disagree with `--help`'s. Help is added to a
    temporary grammar without changing registration
    or validating the injected spelling against child commands.

    Args:
        node (CommandSpec): the node; a leaf parses against this form too.
        style (UsageStyle): the root's voice; argparse also takes ``-h``.
    """
    if not node.add_help or any(
        "--help" in arg.names for arg in node.arguments
    ):
        return node
    names = (
        ("-h", "--help")
        if style in (UsageStyle.ARGPARSE, UsageStyle.COBRA)
        and not any("-h" in arg.names for arg in node.arguments)
        else ("--help",)
    )
    help_argument = Argument(
        *names, action="store_true", help=HELP_OPTION.help
    )
    return replace(node, arguments=(*node.arguments, help_argument))


def _usage_error(
    name: str,
    node: CommandSpec,
    message: str,
    style: UsageStyle,
    token: str | None = None,
) -> WalkResult:
    """Group-level option refusal, in the dialect the CLI declares.

    git answers an unknown option in parse-options' words and its usage
    block (on stdout for ``-h``), and the bare ``git`` with its one
    synopsis; both exit 129. The bare ``git -h`` prints the help. clap
    answers with the message, the one usage line and a footer pointing at
    --help, and exits 2, at every level of the tree; the exit code is the
    group's just as much as the leaf's, so reading the style here is what
    keeps `ntn --bogus` and `ntn pages get --bogus` from disagreeing.

    Args:
        name (str): display path walked so far, e.g. "gws gmail".
        node (CommandSpec): the group node being parsed.
        message (str): first line of the refusal, in the default
            dialect; clap rewords the cases it words differently.
        style (UsageStyle): the root's dialect.
        token (str | None): the offending token when the refusal is an
            unrecognized option, which clap and git word their own way.
            None for the refusals whose wording the dialects share.
    """
    if style is UsageStyle.CLAP:
        first = (
            clap_unexpected_argument(token) if token is not None else message
        )
        return WalkResult(
            output=clap_group_refusal(
                name, listed_node(node, style), _rows(node), first
            ),
            stream="stderr",
            exit_code=CLAP_EXIT,
        )
    if style is UsageStyle.GIT and token is not None:
        path = name.partition(" ")[2]
        # `git -h` is git's own help, as `git --help` is, and exits 0.
        if not path and token == HELP_SWITCH:
            return WalkResult(output=encode_text(node_help(name, node, style)))
        if not path:
            text = f"unknown option: {token}\nusage: {GIT_SYNOPSES[''][0]}\n"
            return WalkResult(
                output=encode_text(text), stream="stderr", exit_code=USAGE_EXIT
            )
        shown, refused = git_option_refusal(token, path, node)
        return WalkResult(
            output=encode_text(shown or refused),
            stream="stdout" if shown else "stderr",
            exit_code=USAGE_EXIT,
        )
    text = f"{message}\n\n{node_help(name, node, style)}"
    return WalkResult(
        output=encode_text(text), stream="stderr", exit_code=USAGE_EXIT
    )


def _unknown_verb(head: str, name: str, word: str) -> WalkResult:
    """git's unknown-command refusal, with the group path in the noun.

    Args:
        head (str): installed head word ("gws").
        name (str): display path walked so far ("gws gmail").
        word (str): the word that matched no subcommand.
    """
    text = f"{head}: '{word}' is not a {name} command. See '{name} --help'.\n"
    return WalkResult(output=encode_text(text), stream="stderr", exit_code=1)


def _record_bool(flags: WalkFlagBag, cs: CompiledSpec, spelling: str) -> None:
    """Record a boolean occurrence under its canonical dashed spelling.

    Args:
        flags (WalkFlagBag): accumulated group flags.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): dashed spelling as typed.
    """
    dest = cs.dest_of(spelling)
    if dest in cs.count_dests:
        prev = flags.get(dest)
        flags[dest] = prev + 1 if isinstance(prev, int) else 1
    else:
        flags[dest] = True


def _record_value(
    flags: WalkFlagBag, cs: CompiledSpec, spelling: str, value: str
) -> None:
    """Record a value occurrence under its canonical dashed spelling.

    Directory changes are resolved in occurrence order by
    ``_resolve_group_paths`` after the node has been scanned.

    Args:
        flags (WalkFlagBag): accumulated group flags.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): dashed spelling as typed.
        value (str): the flag's value.
    """
    dest = cs.dest_of(spelling)
    flags.occurrences.append((dest, value))
    if dest in cs.multiple_dests:
        prev = flags.get(dest)
        if isinstance(prev, list):
            flags[dest] = [*prev, value]
        else:
            flags[dest] = [value]
    else:
        flags[dest] = value


def _record_values(
    flags: WalkFlagBag, cs: CompiledSpec, spelling: str, values: Sequence[str]
) -> None:
    """Store one fixed-width occurrence, extending only repeatable values."""
    dest = cs.dest_of(spelling)
    flags.occurrences.extend((dest, value) for value in values)
    previous = flags.get(dest)
    flags[dest] = (
        [*previous, *values]
        if dest in cs.multiple_dests and isinstance(previous, list)
        else list(values)
    )


def _match_short(
    name: str,
    node: CommandSpec,
    cs: CompiledSpec,
    flags: WalkFlagBag,
    token: str,
    following: Sequence[str],
    style: UsageStyle,
) -> tuple[int, WalkResult | None] | None:
    """Match a complete short spelling before splitting a short cluster."""
    for vf in cs.attach_spellings:
        if token.startswith(vf) and len(token) > len(vf):
            _record_value(flags, cs, vf, token[len(vf) :])
            return (1, None)
    for vf in cs.value_spellings:
        if token == vf or token.startswith(vf):
            attached = token[len(vf) :]
            arity = cs.nargs_by_dest.get(cs.dest_of(vf))
            remaining = (arity if arity is not None else 1) - bool(attached)
            if len(following) < remaining:
                return 0, _usage_error(
                    name, node, f"error: option '{vf}' requires a value", style
                )
            values = ([attached] if attached else []) + list(
                following[:remaining]
            )
            if arity is not None:
                _record_values(flags, cs, vf, values)
            else:
                _record_value(flags, cs, vf, values[0])
            return remaining + 1, None
    if token in cs.bool_spellings:
        if token in cs.detached_optional_spellings and _optional_value(
            following[0] if following else None
        ):
            _record_value(flags, cs, token, following[0])
            return 2, None
        _record_bool(flags, cs, token)
        return 1, None
    return None


def _expand_group_long(
    node: CommandSpec, cs: CompiledSpec, spelling: str
) -> tuple[str, ...]:
    """Prefix-expand a long spelling at a group level.

    The declared tables match first; the injected ``--help`` joins the
    candidate pool when the node does not declare its own, because it is
    a registered option everywhere else (argparse and getopt_long both
    expand ``--hel`` to it).

    Args:
        node (CommandSpec): the group node being parsed.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): the typed long spelling, without any ``=value``.
    """
    candidates = expand_long(cs, spelling)
    if (
        node.add_help
        and "--help".startswith(spelling)
        and len(spelling) > 2
        and "--help" not in candidates
        and "--help" not in cs.dest
    ):
        candidates = candidates + ("--help",)
    return candidates


def _resolve_group_paths(
    cs: CompiledSpec, flags: WalkFlagBag, cwd: str, bases: list[PathSpec]
) -> None:
    """Resolve PATH-typed group values against the working directory.

    A group option declared ``type="path"`` has to mean what it means on
    a leaf, or the type is a lie at exactly one level of the tree. The
    flat parser resolves PATH values right after defaults land, so a
    ``-C`` that defaults to ``"."`` becomes the session cwd and a
    relative ``-C build`` becomes absolute; do the same here rather than
    handing a leaf a raw relative string it has no cwd to interpret.

    Keep the typed spelling and its walk verdict, just as leaf PATH
    values do. The operand base resolves first; other path options are
    relative to it, including environment-supplied values.

    Args:
        cs (CompiledSpec): the node's compiled tables.
        flags (WalkFlagBag): accumulated group flags, updated in place.
        cwd (str): current working directory.
        bases (list[PathSpec]): ordered directory changes to validate.
    """
    base: str | PathSpec = cwd
    if cs.base_dest is not None:
        value = flags.get(cs.base_dest)
        if isinstance(value, str):
            values = [
                word
                for name, word in flags.occurrences
                if name == cs.base_dest and isinstance(word, str)
            ]
            scope = PathSpec.from_str_path(".", cwd=cwd)
            for word in values or [value]:
                scope = PathSpec.from_str_path(word or ".", cwd=scope)
                bases.append(scope)
            flags[cs.base_dest] = scope
            base = scope
    for dest, kind in cs.kind_by_dest.items():
        if kind != "path" or dest not in flags or dest == cs.base_dest:
            continue
        value = flags[dest]
        if isinstance(value, list):
            value_types = cs.value_types_by_dest.get(dest, ("path",))
            flags[dest] = [
                PathSpec.from_str_path(part, cwd=base)
                if value_types[index % len(value_types)] == "path"
                else part
                for index, part in enumerate(value)
            ]
        elif isinstance(value, str):
            flags[dest] = PathSpec.from_str_path(value, cwd=base)


def _finish_node(
    name: str,
    node: CommandSpec,
    cs: CompiledSpec,
    flags: WalkFlagBag,
    cwd: str,
    style: UsageStyle,
    bases: list[PathSpec],
    env: Mapping[str, str] | None = None,
) -> WalkResult | None:
    """Apply a node's declarative option rules after its scan.

    The environment lands first, then defaults, then PATH values
    resolve and choices and required are enforced, the same order the
    flat parser uses (parser.py): an option's declared variable
    outranks its default, yields to anything the line typed, and gets
    the same coercion, choices test and required credit a typed value
    does. Returns a rendered refusal or None when the node is
    satisfied.

    Args:
        name (str): display path walked so far.
        node (CommandSpec): the group node just scanned.
        cs (CompiledSpec): the node's compiled tables.
        flags (WalkFlagBag): accumulated group flags.
        cwd (str): current working directory, for PATH values.
        style (UsageStyle): the root's dialect, for any refusal.
        env (Mapping[str, str] | None): session environment for
            ``Argument.env`` fallbacks, None outside a session.
    """
    for dest, variable in cs.env_by_dest.items():
        if dest in flags:
            continue
        supplied = env.get(variable) if env else None
        if not supplied:
            continue
        if dest in cs.multiple_dests:
            flags[dest] = [supplied]
        else:
            flags[dest] = supplied
    for dest, default in cs.defaults.items():
        if dest not in flags:
            if dest in cs.multiple_dests:
                flags[dest] = [default]
            else:
                flags[dest] = default
    _resolve_group_paths(cs, flags, cwd, bases)
    # Numeric-typed values before choices, argparse's order; wording is
    # git's parse-options refusal (`--depth` on a non-integer), one
    # phrase for int and float alike.
    for dests, pattern in (
        (cs.int_dests, INT_VALUE),
        (cs.float_dests, FLOAT_VALUE),
    ):
        for dest in dests:
            value = flags.get(dest)
            candidates = (
                value
                if isinstance(value, list)
                else ([value] if isinstance(value, str) else [])
            )
            for part in candidates:
                if isinstance(part, str) and not pattern.match(part):
                    return _usage_error(
                        name,
                        node,
                        f"error: option '{dest}' expects a numerical value",
                        style,
                    )
    for dest, allowed in cs.choices_by_dest.items():
        value = flags.get(dest)
        candidates = (
            value
            if isinstance(value, list)
            else ([value] if isinstance(value, (str, PathSpec)) else [])
        )
        for part in candidates:
            choice = part.virtual if isinstance(part, PathSpec) else part
            if choice not in allowed:
                return _usage_error(
                    name,
                    node,
                    f"error: invalid argument '{choice}' for '{dest}'",
                    style,
                )
    for dest in cs.required_dests:
        if dest not in flags:
            return _usage_error(
                name, node, f"error: option '{dest}' is required", style
            )
    return None


def walk(
    head: str,
    spec: CommandSpec,
    argv: Sequence[str],
    cwd: str = "/",
    env: Mapping[str, str] | None = None,
    visible: Callable[[tuple[str, ...]], bool] | None = None,
) -> WalkResult:
    """Resolve one command line against a CLI tree.

    Each level consumes its own options in POSIX order (stop at the
    first non-option word, which names the subcommand), so
    `git -C <path> status` shapes parse the way a terminal user expects.
    Behavior is pinned to git (docker, git 2.47.3): bare group prints
    its usage to stdout and exits 1, `--help` prints the same to stdout
    and exits 0, an unknown verb refuses on stderr with exit 1, and
    group-level option errors refuse on stderr with exit 129. The leaf's
    own argv is not parsed here; it rides the ordinary spec machinery.

    Args:
        head (str): installed head word, used in every rendering so a
            renamed install prints its own name.
        spec (CommandSpec): the root of the tree.
        argv (Sequence[str]): the words after the head.
        cwd (str): working directory for PATH-typed group values, so a
            group option resolves the way a leaf option does.
        env (Mapping[str, str] | None): session environment, so a group
            option declaring ``Argument.env`` fills at its own level
            exactly as a leaf one does in the flat parser.
        visible (Callable[[tuple[str, ...]], bool] | None): filter child
            command paths in generated help for the current session.
    """
    node = spec
    # Read once off the root and never off a node: a program answers in
    # one voice at every level, so a subcommand cannot pick its own.
    style = spec.usage_style
    path: tuple[str, ...] = ()
    flags: WalkFlagBag = WalkFlagBag()
    bases: list[PathSpec] = []
    i = 0

    def shown(child: str) -> bool:
        return visible is None or visible((*path, child))

    while True:
        # A script node terminates the walk exactly like an fn leaf:
        # its remaining argv rides the ordinary spec machinery for
        # validation, then passes to the program verbatim.
        if not node.subcommands:
            return WalkResult(
                leaf=node,
                path=path,
                group_flags=flags,
                operand_bases=tuple(bases),
                argv=tuple(argv[i:]),
            )
        name = " ".join((head,) + path)
        cs = compile_spec(node)
        descended = False
        options_ended = False
        while i < len(argv):
            token = argv[i]
            alias = (
                find_child(node, token)
                if (
                    not options_ended
                    and token.startswith("-")
                    and token not in cs.dest
                    and token != "--help"
                )
                else None
            )
            if alias is not None and token in alias.aliases:
                refused = _finish_node(
                    name, node, cs, flags, cwd, style, bases, env
                )
                if refused is not None:
                    return refused
                node = alias
                path = path + (alias.name,)
                i += 1
                descended = True
                break
            if (
                not options_ended
                and token == "-h"
                and node.add_help
                and style in (UsageStyle.ARGPARSE, UsageStyle.COBRA)
                and "-h" not in cs.dest
            ):
                return WalkResult(
                    output=encode_text(
                        node_help(
                            name,
                            node,
                            style,
                            visible=shown,
                        )
                    )
                )
            if not options_ended and token == "--":
                if style is UsageStyle.GIT and not path:
                    return _usage_error(
                        name, node, "unknown option: --", style, token
                    )
                options_ended = True
                i += 1
                continue
            if not options_ended and token.startswith("--"):
                spelling, eq, attached = token.partition("=")
                # getopt_long: an exact spelling wins; otherwise a unique
                # prefix expands (git status --porcel) and an ambiguous
                # one is refused with every possibility (git wording).
                if spelling not in cs.dest and spelling != "--help":
                    candidates = (
                        _expand_group_long(node, cs, spelling)
                        if node.allow_abbrev
                        else ()
                    )
                    if len(candidates) == 1:
                        spelling = candidates[0]
                    elif len(candidates) > 1:
                        possible = " or ".join(candidates)
                        return _usage_error(
                            name,
                            node,
                            f"error: ambiguous option: {spelling[2:]} "
                            f"(could be {possible})",
                            style,
                        )
                # Optional-value longs sit in BOTH long_bool_spellings and
                # long_optional_spellings, so the optional test runs first
                # or --color=auto would be refused as taking no value.
                if spelling in cs.long_optional_spellings:
                    if eq:
                        _record_value(flags, cs, spelling, attached)
                    elif (
                        spelling in cs.detached_optional_spellings
                        and _optional_value(
                            argv[i + 1] if i + 1 < len(argv) else None
                        )
                    ):
                        i += 1
                        _record_value(flags, cs, spelling, argv[i])
                    else:
                        _record_bool(flags, cs, spelling)
                elif spelling in cs.long_bool_spellings:
                    if eq:
                        return _usage_error(
                            name,
                            node,
                            f"error: option '{spelling}' takes no value",
                            style,
                        )
                    _record_bool(flags, cs, spelling)
                elif spelling in cs.long_value_spellings:
                    arity = cs.nargs_by_dest.get(cs.dest_of(spelling))
                    if arity == 1 and eq:
                        _record_values(flags, cs, spelling, [attached])
                    elif arity is not None:
                        if eq or i + arity >= len(argv):
                            return _usage_error(
                                name,
                                node,
                                f"error: option '{spelling}' requires a value",
                                style,
                            )
                        _record_values(
                            flags, cs, spelling, argv[i + 1 : i + 1 + arity]
                        )
                        i += arity
                    elif eq:
                        _record_value(flags, cs, spelling, attached)
                    elif i + 1 < len(argv):
                        i += 1
                        _record_value(flags, cs, spelling, argv[i])
                    else:
                        return _usage_error(
                            name,
                            node,
                            f"error: option '{spelling}' requires a value",
                            style,
                        )
                elif spelling == "--help" and node.add_help:
                    if eq:
                        return _usage_error(
                            name,
                            node,
                            f"error: option '{spelling}' takes no value",
                            style,
                        )
                    return WalkResult(
                        output=encode_text(
                            node_help(
                                name,
                                node,
                                style,
                                visible=shown,
                            )
                        )
                    )
                else:
                    return _usage_error(
                        name,
                        node,
                        f"unknown option: {spelling}",
                        style,
                        token=token if style is UsageStyle.GIT else spelling,
                    )
                i += 1
                continue
            if not options_ended and token.startswith("-") and token != "-":
                # Declared multi-char shorts (find-style -name) match the
                # whole token before any cluster splitting, longest first,
                # the same precedence the flat parser uses.
                whole = _match_short(
                    name,
                    node,
                    cs,
                    flags,
                    token,
                    argv[i + 1 :],
                    style,
                )
                if whole is not None:
                    consumed, refused = whole
                    if refused is not None:
                        return refused
                    i += consumed
                    continue
                j = 1
                error = None
                unknown = None
                while j < len(token):
                    spelling = f"-{token[j]}"
                    rest = token[j + 1 :]
                    optional = spelling in cs.detached_optional_spellings
                    attached_optional = spelling in cs.attach_spellings
                    if (
                        spelling in cs.bool_spellings
                        and not optional
                        and not (attached_optional and rest)
                    ):
                        _record_bool(flags, cs, spelling)
                        j += 1
                    elif spelling in cs.dest:
                        if (
                            optional
                            and not rest
                            and not _optional_value(
                                argv[i + 1] if i + 1 < len(argv) else None
                            )
                        ):
                            _record_bool(flags, cs, spelling)
                            break
                        arity = cs.nargs_by_dest.get(cs.dest_of(spelling))
                        remaining = (arity if arity is not None else 1) - bool(
                            rest
                        )
                        if i + remaining >= len(argv):
                            error = (
                                f"error: option '{spelling}' requires a value"
                            )
                            break
                        values = ([rest] if rest else []) + list(
                            argv[i + 1 : i + remaining + 1]
                        )
                        if arity is not None:
                            _record_values(flags, cs, spelling, values)
                        else:
                            _record_value(flags, cs, spelling, values[0])
                        i += remaining
                        break
                    else:
                        error = f"unknown option: {spelling}"
                        unknown = spelling
                        break
                if error is not None:
                    return _usage_error(
                        name, node, error, style, token=unknown
                    )
                i += 1
                continue
            refused = _finish_node(
                name, node, cs, flags, cwd, style, bases, env
            )
            if refused is not None:
                return refused
            # An alias resolves to its canonical node; the path records
            # the canonical name (argparse prog attribution: errors under
            # `gws co` render as `gws checkout`).
            child = None if token.startswith("-") else find_child(node, token)
            if child is None:
                return _unknown_verb(head, name, token)
            node = child
            path = path + (child.name,)
            i += 1
            descended = True
            break
        if descended:
            continue
        refused = _finish_node(name, node, cs, flags, cwd, style, bases, env)
        if refused is not None:
            return refused
        return WalkResult(
            output=encode_text(
                node_help(
                    name,
                    node,
                    style,
                    visible=shown,
                )
            ),
            stream="stdout",
            exit_code=1,
        )
