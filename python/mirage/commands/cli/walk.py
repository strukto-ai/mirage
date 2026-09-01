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

from mirage.commands.cli.constants import CLAP_EXIT, USAGE_EXIT
from mirage.commands.cli.types import CLISpec, WalkFlagBag, WalkResult
from mirage.commands.config import HELP_OPTION
from mirage.commands.spec.compile import (CompiledSpec, compile_spec,
                                          expand_long)
from mirage.commands.spec.constants import FLOAT_VALUE, INT_VALUE
from mirage.commands.spec.help import (clap_group_refusal,
                                       clap_unexpected_argument, render_help)
from mirage.commands.spec.types import UsageStyle
from mirage.utils.path import resolve_path


def _verb_display(child: CLISpec) -> str:
    """A subcommand's row label: ``name (alias, ...)`` like argparse.

    Args:
        child (CLISpec): the subcommand node.
    """
    if child.aliases:
        return f"{child.name} ({', '.join(child.aliases)})"
    return child.name


def find_child(node: CLISpec, word: str) -> CLISpec | None:
    """The subcommand a word names, by canonical name or alias.

    Args:
        node (CLISpec): the group being descended.
        word (str): the verb word as typed.
    """
    return next(
        (c for c in node.subcommands if word == c.name or word in c.aliases),
        None)


def find_node(spec: CLISpec,
              verbs: Sequence[str]) -> tuple[CLISpec, tuple[str, ...]] | None:
    """Descend a tree by verb words, None if a word names no subcommand.

    Returns the node and its canonical path, so an alias renders under
    the name it resolves to, the attribution rule ``walk`` uses. This is
    introspection only (``man``): no options are parsed and no usage
    error is produced, so a caller gets the node or nothing.

    Args:
        spec (CLISpec): the root of the tree.
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
        path = path + (child.name, )
    return node, path


def env_names(node: CLISpec) -> frozenset[str]:
    """Every ``Option.env`` variable a program tree reads.

    The env-plane fill step asks this per installed head word on the
    line, so a managed name a CLI reads from the environment joins the
    fetch set even though no ``$NAME`` appears in the line's text.

    Args:
        node (CLISpec): the tree's root (or any subtree).
    """
    out = {opt.env for opt in node.options if opt.env is not None}
    for child in node.subcommands:
        out |= env_names(child)
    return frozenset(out)


def invoked_env_names(spec: CLISpec,
                      words: frozenset[str] | None) -> frozenset[str]:
    """Env names on the verb paths the line's words could select.

    The words prune the tree: a subcommand joins only when some word
    spells its name or an alias, recursively, so a bare head reads the
    root's env names and ``ntn api get`` adds exactly the api and get
    nodes. A word doubling as an operand over-selects, which costs one
    fetch; a verb can never hide, because dispatch only runs a verb the
    line spells. None means a word no static read can spell (an
    expansion), where the whole tree is the only safe answer.

    Args:
        spec (CLISpec): the tree's root (or any subtree).
        words (frozenset[str] | None): the invocation's literal
            argument words, None when one was dynamic.
    """
    if words is None:
        return env_names(spec)
    out = {opt.env for opt in spec.options if opt.env is not None}
    for child in spec.subcommands:
        if child.name in words or any(alias in words
                                      for alias in child.aliases):
            out |= invoked_env_names(child, words)
    return frozenset(out)


def _supplied_option(cs: CompiledSpec, token: str,
                     has_next: bool) -> tuple[str, int] | None:
    """The spelling one dash token certainly supplies, and its width.

    Mirrors the exact-token arms the walk and the flat parser share --
    an attached value, a value in the next word, a bare boolean -- and
    answers None for anything subtler (a cluster, an abbreviation, an
    undeclared spelling, a long given a value it refuses), where the
    caller must stop claiming anything.

    Args:
        cs (CompiledSpec): the level's compiled tables.
        token (str): the dash token as typed.
        has_next (bool): a following word exists to consume as a value.
    """
    if token.startswith("--"):
        spelling, eq, _ = token.partition("=")
        if spelling in cs.long_optional_spellings:
            return spelling, 1
        if spelling in cs.long_bool_spellings:
            return None if eq else (spelling, 1)
        if spelling in cs.long_value_spellings:
            if eq:
                return spelling, 1
            return (spelling, 2) if has_next else None
        return None
    for vf in cs.attach_spellings:
        if token.startswith(vf) and len(token) > len(vf):
            return vf, 1
    for vf in cs.value_spellings:
        if token == vf:
            return (vf, 2) if has_next else None
        if token.startswith(vf) and len(token) > len(vf):
            return vf, 1
    if token in cs.bool_spellings:
        return token, 1
    return None


def _claimed(carriers: Sequence[Mapping[str, str]],
             supplied: set[tuple[int, str]]) -> frozenset[str]:
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


def supplied_env_names(spec: CLISpec, args: Sequence[str]) -> frozenset[str]:
    """Env names whose every reader on the walked path is supplied.

    The parser never reads ``Option.env`` for a destination the line
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
        spec (CLISpec): the installed tree's root.
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
            hit = _supplied_option(cs, token, i + 1 < len(args))
            if hit is None:
                return frozenset()
            spelling, consumed = hit
            supplied.add((len(carriers) - 1, cs.dest_of(spelling)))
            i += consumed
            continue
        if node.fn is not None or node.script is not None:
            if cs.remainder:
                return _claimed(carriers, supplied)
            i += 1
            continue
        child = find_child(node, token)
        if child is None:
            return _claimed(carriers, supplied)
        node = child
        if owns_argv(node):
            return _claimed(carriers, supplied)
        cs = compile_spec(node)
        carriers.append(cs.env_by_dest)
        i += 1
    return _claimed(carriers, supplied)


def owns_argv(node: CLISpec) -> bool:
    """True when the node parses its own command line instead of mirage.

    A script root that declares no grammar is the only such node: the
    embedded program is the parser, so its flags are not mirage's to
    recognize, and a generated help page would document nothing. Mirage
    forwards the whole line to it (a pass-through rest operand) and
    leaves ``--help`` to the program. A script root that does declare
    options or operands opts back into the ordinary machinery, which
    then renders truthful help and refuses undeclared flags.

    Args:
        node (CLISpec): the node whose line is about to be parsed.
    """
    return (node.script is not None and not node.options
            and not node.positional and node.rest is None)


def node_help(name: str,
              node: CLISpec,
              style: UsageStyle = UsageStyle.ARGPARSE,
              visible: Callable[[str], bool] | None = None) -> str:
    """A group node's help: the ordinary command help plus Commands rows.

    One renderer serves leaves and groups (a group is a spec whose
    operand is the subcommand word); the same text serves ``--help``
    (stdout, exit 0) and the bare-group refusal (stdout, exit 1,
    matching git).

    Args:
        name (str): full display path as typed, e.g. "gws gmail"; the
            head word is the installed name, so a renamed install
            renders its own spelling.
        node (CLISpec): the group node.
        style (UsageStyle): the ROOT's dialect, never the node's: a
            program answers in one voice at every level, the same rule
            the leaf refusal follows.
        visible (Callable[[str], bool] | None): filter on a child's
            canonical name, None to list every child. Only ``man``
            passes one, since it renders for a session; a line that
            reaches ``--help`` or the bare-group refusal was admitted
            whole, so there is nothing left to filter there.
    """
    return render_help(name,
                       _listed(node),
                       subcommands=_rows(node, visible),
                       style=style)


def _rows(
        node: CLISpec,
        visible: Callable[[str], bool] | None = None) -> list[tuple[str, str]]:
    """The node's child rows, as the renderer lists them.

    Args:
        node (CLISpec): the group node.
        visible (Callable[[str], bool] | None): filter on a child's
            canonical name, None to list every child.
    """
    return [(_verb_display(child), child.description or "")
            for child in node.subcommands
            if visible is None or visible(child.name)]


def _listed(node: CLISpec) -> CLISpec:
    """The node as the renderer shows it, with `--help` filled in.

    --help is a registered option everywhere (argparse add_help, click
    add_help_option, withHelpSupport for leaves), so the listing shows
    it unless the node declares its own or answers the flag itself
    (owns_argv), where advertising it would promise a page mirage no
    longer renders. A refusal renders the same node a help page would,
    or its usage line would disagree with `--help`'s.

    Args:
        node (CLISpec): the group node.
    """
    if any(option.long == "--help"
           for option in node.options) or owns_argv(node):
        return node
    return replace(node, options=node.options + (HELP_OPTION, ))


def _usage_error(name: str,
                 node: CLISpec,
                 message: str,
                 style: UsageStyle,
                 token: str | None = None) -> WalkResult:
    """Group-level option refusal, in the dialect the CLI declares.

    git answers with the message and the whole usage listing and exits
    129. clap answers with the message, the one usage line and a footer
    pointing at --help, and exits 2, at every level of the tree; the
    exit code is the group's just as much as the leaf's, so reading the
    style here is what keeps `ntn --bogus` and `ntn pages get --bogus`
    from disagreeing.

    Args:
        name (str): display path walked so far, e.g. "gws gmail".
        node (CLISpec): the group node being parsed.
        message (str): first line of the refusal, in the default
            dialect; clap rewords the cases it words differently.
        style (UsageStyle): the root's dialect.
        token (str | None): the offending token when the refusal is an
            unrecognized option, which clap words its own way. None for
            the refusals whose wording both dialects share.
    """
    if style is UsageStyle.CLAP:
        first = (clap_unexpected_argument(token)
                 if token is not None else message)
        return WalkResult(output=clap_group_refusal(name, _listed(node),
                                                    _rows(node), first),
                          stream="stderr",
                          exit_code=CLAP_EXIT)
    text = f"{message}\n\n{node_help(name, node, style)}"
    return WalkResult(output=text.encode(),
                      stream="stderr",
                      exit_code=USAGE_EXIT)


def _unknown_verb(head: str, name: str, word: str) -> WalkResult:
    """git's unknown-command refusal, with the group path in the noun.

    Args:
        head (str): installed head word ("gws").
        name (str): display path walked so far ("gws gmail").
        word (str): the word that matched no subcommand.
    """
    text = (f"{head}: '{word}' is not a {name} command. "
            f"See '{name} --help'.\n")
    return WalkResult(output=text.encode(), stream="stderr", exit_code=1)


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


def _record_value(flags: WalkFlagBag, cs: CompiledSpec, spelling: str,
                  value: str) -> None:
    """Record a value occurrence under its canonical dashed spelling.

    Args:
        flags (WalkFlagBag): accumulated group flags.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): dashed spelling as typed.
        value (str): the flag's value.
    """
    dest = cs.dest_of(spelling)
    if dest in cs.multiple_dests:
        prev = flags.get(dest)
        if isinstance(prev, list):
            prev.append(value)
        else:
            flags[dest] = [value]
    else:
        flags[dest] = value


def _match_short(name: str, node: CLISpec, cs: CompiledSpec,
                 flags: WalkFlagBag, token: str, next_token: str | None,
                 style: UsageStyle) -> tuple[int, WalkResult | None] | None:
    """Match a whole short token against declared spellings.

    Mirrors the flat parser's precedence before cluster splitting:
    attached values on attach-capable spellings, then value spellings
    (exact token wants the next word; longer token carries an attached
    value), then an exact boolean spelling. Multi-char shorts like
    find's ``-name`` only match here. Returns None to fall through to
    the single-char cluster loop, else (tokens consumed, refusal).

    Args:
        name (str): display path walked so far.
        node (CLISpec): the group node being parsed.
        cs (CompiledSpec): the node's compiled tables.
        flags (WalkFlagBag): accumulated group flags.
        token (str): the short token as typed.
        next_token (str | None): the following word, when any.
        style (UsageStyle): the root's dialect, for any refusal.
    """
    for vf in cs.attach_spellings:
        if token.startswith(vf) and len(token) > len(vf):
            _record_value(flags, cs, vf, token[len(vf):])
            return (1, None)
    for vf in cs.value_spellings:
        if token == vf:
            if next_token is None:
                return (0,
                        _usage_error(name, node,
                                     f"error: option '{vf}' requires a value",
                                     style))
            _record_value(flags, cs, vf, next_token)
            return (2, None)
        if token.startswith(vf) and len(token) > len(vf):
            _record_value(flags, cs, vf, token[len(vf):])
            return (1, None)
    if token in cs.bool_spellings:
        _record_bool(flags, cs, token)
        return (1, None)
    return None


def _expand_group_long(node: CLISpec, cs: CompiledSpec,
                       spelling: str) -> tuple[str, ...]:
    """Prefix-expand a long spelling at a group level.

    The declared tables match first; the injected ``--help`` joins the
    candidate pool when the node does not declare its own, because it is
    a registered option everywhere else (argparse and getopt_long both
    expand ``--hel`` to it).

    Args:
        node (CLISpec): the group node being parsed.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): the typed long spelling, without any ``=value``.
    """
    candidates = expand_long(cs, spelling)
    if ("--help".startswith(spelling) and len(spelling) > 2
            and "--help" not in candidates
            and not any(option.long == "--help" for option in node.options)):
        candidates = candidates + ("--help", )
    return candidates


def _resolve_group_paths(cs: CompiledSpec, flags: WalkFlagBag,
                         cwd: str) -> None:
    """Resolve PATH-typed group values against the working directory.

    A group option declared ``type="path"`` has to mean what it means on
    a leaf, or the type is a lie at exactly one level of the tree. The
    flat parser resolves PATH values right after defaults land, so a
    ``-C`` that defaults to ``"."`` becomes the session cwd and a
    relative ``-C build`` becomes absolute; do the same here rather than
    handing a leaf a raw relative string it has no cwd to interpret.

    Resolved to absolute strings, not PathSpec: a group flag never picks
    a mount (CLI dispatch consults none), so the routing half of the
    leaf's PATH recovery has nothing to do here.

    Args:
        cs (CompiledSpec): the node's compiled tables.
        flags (WalkFlagBag): accumulated group flags, updated in place.
        cwd (str): current working directory.
    """
    for dest, kind in cs.kind_by_dest.items():
        if kind != "path" or dest not in flags:
            continue
        value = flags[dest]
        if isinstance(value, list):
            flags[dest] = [resolve_path(part, cwd) for part in value]
        elif isinstance(value, str):
            flags[dest] = resolve_path(value, cwd)


def _finish_node(name: str,
                 node: CLISpec,
                 cs: CompiledSpec,
                 flags: WalkFlagBag,
                 cwd: str,
                 style: UsageStyle,
                 env: Mapping[str, str] | None = None) -> WalkResult | None:
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
        node (CLISpec): the group node just scanned.
        cs (CompiledSpec): the node's compiled tables.
        flags (WalkFlagBag): accumulated group flags.
        cwd (str): current working directory, for PATH values.
        style (UsageStyle): the root's dialect, for any refusal.
        env (Mapping[str, str] | None): session environment for
            ``Option.env`` fallbacks, None outside a session.
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
    _resolve_group_paths(cs, flags, cwd)
    # Numeric-typed values before choices, argparse's order; wording is
    # git's parse-options refusal (`--depth` on a non-integer), one
    # phrase for int and float alike.
    for dests, pattern in ((cs.int_dests, INT_VALUE), (cs.float_dests,
                                                       FLOAT_VALUE)):
        for dest in dests:
            value = flags.get(dest)
            candidates = value if isinstance(
                value, list) else ([value] if isinstance(value, str) else [])
            for part in candidates:
                if not pattern.match(part):
                    return _usage_error(
                        name, node,
                        f"error: option '{dest}' expects a numerical value",
                        style)
    for dest, allowed in cs.choices_by_dest.items():
        value = flags.get(dest)
        candidates = value if isinstance(
            value, list) else ([value] if isinstance(value, str) else [])
        for part in candidates:
            if part not in allowed:
                return _usage_error(
                    name, node,
                    f"error: invalid argument '{part}' for '{dest}'", style)
    for dest in cs.required_dests:
        if dest not in flags:
            return _usage_error(name, node,
                                f"error: option '{dest}' is required", style)
    return None


def walk(head: str,
         spec: CLISpec,
         argv: Sequence[str],
         cwd: str = "/",
         env: Mapping[str, str] | None = None) -> WalkResult:
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
        spec (CLISpec): the root of the tree.
        argv (Sequence[str]): the words after the head.
        cwd (str): working directory for PATH-typed group values, so a
            group option resolves the way a leaf option does.
        env (Mapping[str, str] | None): session environment, so a group
            option declaring ``Option.env`` fills at its own level
            exactly as a leaf one does in the flat parser.
    """
    node = spec
    # Read once off the root and never off a node: a program answers in
    # one voice at every level, so a subcommand cannot pick its own.
    style = spec.usage_style
    path: tuple[str, ...] = ()
    flags: WalkFlagBag = {}
    i = 0
    while True:
        # A script node terminates the walk exactly like an fn leaf:
        # its remaining argv rides the ordinary spec machinery for
        # validation, then passes to the program verbatim.
        if node.fn is not None or node.script is not None:
            return WalkResult(leaf=node,
                              path=path,
                              group_flags=flags,
                              argv=tuple(argv[i:]))
        name = " ".join((head, ) + path)
        cs = compile_spec(node)
        descended = False
        options_ended = False
        while i < len(argv):
            token = argv[i]
            if not options_ended and token == "--":
                options_ended = True
                i += 1
                continue
            if not options_ended and token.startswith("--"):
                spelling, eq, attached = token.partition("=")
                # getopt_long: an exact spelling wins; otherwise a unique
                # prefix expands (git status --porcel) and an ambiguous
                # one is refused with every possibility (git wording).
                if spelling not in cs.dest and spelling != "--help":
                    candidates = _expand_group_long(node, cs, spelling)
                    if len(candidates) == 1:
                        spelling = candidates[0]
                    elif len(candidates) > 1:
                        possible = " or ".join(candidates)
                        return _usage_error(
                            name, node,
                            f"error: ambiguous option: {spelling[2:]} "
                            f"(could be {possible})", style)
                # Optional-value longs sit in BOTH long_bool_spellings and
                # long_optional_spellings, so the optional test runs first
                # or --color=auto would be refused as taking no value.
                if spelling in cs.long_optional_spellings:
                    if eq:
                        _record_value(flags, cs, spelling, attached)
                    else:
                        _record_bool(flags, cs, spelling)
                elif spelling in cs.long_bool_spellings:
                    if eq:
                        return _usage_error(
                            name, node,
                            f"error: option '{spelling}' takes no value",
                            style)
                    _record_bool(flags, cs, spelling)
                elif spelling in cs.long_value_spellings:
                    if eq:
                        _record_value(flags, cs, spelling, attached)
                    elif i + 1 < len(argv):
                        i += 1
                        _record_value(flags, cs, spelling, argv[i])
                    else:
                        return _usage_error(
                            name, node,
                            f"error: option '{spelling}' requires a value",
                            style)
                elif spelling == "--help":
                    if eq:
                        return _usage_error(
                            name, node,
                            f"error: option '{spelling}' takes no value",
                            style)
                    return WalkResult(
                        output=node_help(name, node, style).encode())
                else:
                    return _usage_error(name,
                                        node,
                                        f"unknown option: {spelling}",
                                        style,
                                        token=spelling)
                i += 1
                continue
            if not options_ended and token.startswith("-") and token != "-":
                # Declared multi-char shorts (find-style -name) match the
                # whole token before any cluster splitting, longest first,
                # the same precedence the flat parser uses.
                whole = _match_short(
                    name, node, cs, flags, token,
                    argv[i + 1] if i + 1 < len(argv) else None, style)
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
                    if spelling in cs.bool_spellings:
                        _record_bool(flags, cs, spelling)
                        j += 1
                    elif spelling in cs.dest:
                        rest = token[j + 1:]
                        if rest:
                            _record_value(flags, cs, spelling, rest)
                        elif i + 1 < len(argv):
                            i += 1
                            _record_value(flags, cs, spelling, argv[i])
                        else:
                            error = (f"error: option '{spelling}' "
                                     f"requires a value")
                        break
                    else:
                        error = f"unknown option: {spelling}"
                        unknown = spelling
                        break
                if error is not None:
                    return _usage_error(name,
                                        node,
                                        error,
                                        style,
                                        token=unknown)
                i += 1
                continue
            refused = _finish_node(name, node, cs, flags, cwd, style, env)
            if refused is not None:
                return refused
            # An alias resolves to its canonical node; the path records
            # the canonical name (argparse prog attribution: errors under
            # `gws co` render as `gws checkout`).
            child = find_child(node, token)
            if child is None:
                return _unknown_verb(head, name, token)
            node = child
            path = path + (child.name, )
            i += 1
            descended = True
            break
        if descended:
            continue
        refused = _finish_node(name, node, cs, flags, cwd, style, env)
        if refused is not None:
            return refused
        return WalkResult(output=node_help(name, node, style).encode(),
                          stream="stdout",
                          exit_code=1)
