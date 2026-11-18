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

import logging
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import replace
from types import MappingProxyType

from mirage.commands.cli.walk import find_child
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import argument_dest, compile_spec
from mirage.commands.spec.types import CommandSpec
from mirage.policy.errors import PolicyError
from mirage.policy.match import expand_pattern, head_allowed, split_pattern
from mirage.policy.match.grammar import (
    STAR,
    allow_patterns,
    env_options,
    pattern_problem,
    read_pattern,
    undeclared_options,
)
from mirage.policy.types import (
    AdmissionRules,
    AllowFlags,
    CommandNode,
    CommandRule,
    Grammar,
    OptionRule,
    ValueRule,
)

logger = logging.getLogger(__name__)

BUILTIN_GRAMMARS: Mapping[str, Grammar] = MappingProxyType(
    {name: Grammar(spec) for name, spec in SPECS.items()}
)

RESERVED_WORDS = frozenset(
    {"decision", "reason", "paths", "operands", "values"}
)
VALUELESS_ACTIONS = frozenset({"store_true", "count"})
GLOB_CHARS = frozenset("*?[")


def expanded(patterns: Sequence[str]) -> tuple[str, ...]:
    """Written patterns with each ``{a,b}`` group expanded, in order.

    Args:
        patterns (Sequence[str]): the patterns as written.
    """
    return tuple(p for written in patterns for p in expand_pattern(written))


def _head(pattern: str) -> str:
    """The command name a pattern starts with, empty for a bare
    wildcard.

    Args:
        pattern (str): the command pattern as written.
    """
    tokens = split_pattern(pattern)
    head = tokens[0] if tokens else ""
    return "" if head == "*" else head


def _covers_pattern(deny: str, ask: str) -> bool:
    """Whether a deny pattern matches every line an ask pattern does.

    A pattern is a token prefix, so a shorter deny covers a longer ask
    (``git`` covers ``git push``) and a ``*`` token in the deny covers
    whatever the ask names there. The reverse never holds.

    Args:
        deny (str): the deny rule's command pattern.
        ask (str): the ask rule's command pattern.
    """
    want = split_pattern(deny)
    have = split_pattern(ask)
    if len(want) > len(have):
        return False
    return all(w == "*" or w == h for w, h in zip(want, have))


def _shadowed(ask: CommandRule, deny: CommandRule) -> bool:
    """Whether a deny rule refuses every line an ask rule asks about.

    Three things have to hold, and each is the reason for one arm. The
    deny must name no paths, or the ask still fires on the operands the
    deny leaves alone. It must be written at the same anchor, which is
    where deny beats ask unconditionally; across anchors the deeper rule
    leads and which one that is depends on the line, so this reports
    nothing rather than guess (a top-level deny does shadow a
    mount-scoped ask on the same command, and is deliberately left to
    the run). And every command the ask names must be covered by one of
    its patterns, since an ask naming a command the deny misses still
    has work to do.

    Args:
        ask (CommandRule): the ask rule.
        deny (CommandRule): the deny rule to test against it.
    """
    if deny.paths:
        return False
    if deny.mount != ask.mount:
        return False
    if not deny.commands:
        return True
    if not ask.commands:
        return False
    return all(
        any(_covers_pattern(d, a) for d in expanded(deny.commands))
        for a in expanded(ask.commands)
    )


def _uninstalled(rules: AdmissionRules) -> str | None:
    """The first rule naming a builtin the allow list never allows.

    A rule on a command the allow list leaves out reads as a guard and
    is not one: the allow list refuses the command first, so nothing
    reaches the rule and the operator is protected only in the document. Only a
    name this repo ships a spec for is judged, because any other word
    may be a CLI the host registers after the workspace is built, which
    ``check_cli_patterns`` checks at ``create_session`` instead.

    Args:
        rules (AdmissionRules): the compiled document.
    """
    if rules.allow is None:
        return None
    for verb, entries in (("deny", rules.deny), ("ask", rules.ask)):
        for rule in entries:
            for pattern in expanded(rule.commands):
                head = _head(pattern)
                if not head or head not in SPECS:
                    continue
                if not head_allowed(head, rules):
                    return (
                        f"{verb} rule names {head}, which the allow list "
                        "never allows, so the rule can never fire"
                    )
    return None


def _dead_ask(rules: AdmissionRules) -> str | None:
    """The first ask an outranking deny already refuses.

    Deny is read before ask at the same anchor, so an ask a deny covers
    can never be reached: the line is refused before anyone is asked,
    and the sign-off the operator wrote is never requested.

    Args:
        rules (AdmissionRules): the compiled document.
    """
    for ask in rules.ask:
        for deny in rules.deny:
            if _shadowed(ask, deny):
                a = ", ".join(ask.commands) or "*"
                d = ", ".join(deny.commands) or "*"
                return (
                    f"ask rule {a} can never fire: the deny rule {d} "
                    "refuses the same commands and outranks it"
                )
    return None


def _written(
    rules: AdmissionRules,
) -> list[tuple[str, str, str]]:
    """Every pattern a rule set writes, with the list it is in and each
    of its groups expanded: (list, pattern as written, expanded).

    Args:
        rules (AdmissionRules): the compiled document.
    """
    out = [
        ("allow", entry, p)
        for entry in rules.allow or ()
        if isinstance(entry, str)
        for p in expand_pattern(entry)
    ]
    out += [
        ("allow", entry.pattern, entry.pattern)
        for entry in rules.allow or ()
        if isinstance(entry, AllowFlags)
    ]
    for verb, entries in (("deny", rules.deny), ("ask", rules.ask)):
        out += [
            (verb, written, p)
            for rule in entries
            for written in rule.commands
            for p in expand_pattern(written)
        ]
    return out


def check_patterns(
    rules: AdmissionRules | None, grammars: Mapping[str, Grammar]
) -> None:
    """Refuse a pattern its command cannot read as written: a
    subcommand or option it does not have, a long option written by a
    prefix, a short option past a subcommand ``*``, or an option no
    subcommand under the ``*`` declares. A command with no grammar here
    is left alone, and matches word by word.

    Args:
        rules (AdmissionRules | None): the compiled document.
        grammars (Mapping[str, Grammar]): the grammar of each command
            to check, keyed by name.

    Raises:
        PolicyError: a pattern names something its command lacks.
    """
    if rules is None:
        return
    for where, written, pattern in _written(rules):
        words = split_pattern(pattern)
        grammar = grammars.get(words[0]) if words else None
        if grammar is None:
            continue
        problem = pattern_problem(grammar, words)
        if problem is not None:
            raise PolicyError(f"commands.{where}: {written}: {problem}")


def pattern_warnings(rules: AdmissionRules | None) -> list[str]:
    """What a document writes that loads but may not mean what it says:
    a group in the command name (``{rm,mv} -f`` reads as two rules on
    two commands), or a subcommand ``*`` in the allow list, which admits
    a subcommand the command gains later.

    Args:
        rules (AdmissionRules | None): the compiled document.
    """
    if rules is None:
        return []
    out: list[str] = []
    for where, written, _ in _written(rules):
        words = split_pattern(written)
        if words and len(expand_pattern(words[0])) > 1:
            out.append(
                f"commands.{where}: {written}: a group in the command name "
                "writes one rule per command"
            )
        if where == "allow" and "*" in words[1:]:
            out.append(
                f"commands.allow: {written}: a * admits every subcommand "
                "there, including any added later"
            )
    return list(dict.fromkeys(out))


def closed_commands(rules: AdmissionRules | None) -> list[str]:
    """Each command an allow entry closes to its own entries beside
    ``*`` (``commands.allow closes gh to: gh pr view``), which the
    document means and its reader may not see.

    Args:
        rules (AdmissionRules | None): the compiled document.
    """
    allowed = () if rules is None else allow_patterns(rules)
    if STAR not in allowed:
        return []
    closed: dict[str, list[str]] = {}
    for pattern in allowed:
        head = split_pattern(pattern)[:1]
        if head and head[0] != STAR:
            closed.setdefault(head[0], []).append(pattern)
    return [
        f"commands.allow closes {head} to: {', '.join(entries)}"
        for head, entries in closed.items()
    ]


def check_rules(rules: AdmissionRules | None) -> None:
    """Refuse a document whose rules cannot behave as written.

    The checks name a rule that is dead on arrival, which is worse than
    a missing rule because it reads as a guard, or a pattern a builtin's
    grammar cannot read (``check_patterns``). Raised where the document
    is compiled, so a deployment learns at startup rather than the first
    time an agent types the line the operator thought was covered. What
    loads but may surprise is logged as a warning (``pattern_warnings``),
    and each command the allow list closes as a note (``closed_commands``).

    Args:
        rules (AdmissionRules | None): the compiled document, None for
            an unrestricted session.

    Raises:
        PolicyError: a rule can never fire, or names something its
            command lacks.
    """
    if rules is None:
        return
    for problem in (_uninstalled(rules), _dead_ask(rules)):
        if problem is not None:
            raise PolicyError(problem)
    check_patterns(rules, BUILTIN_GRAMMARS)
    for warning in pattern_warnings(rules):
        logger.warning(warning)
    for note in closed_commands(rules):
        logger.info(note)


def check_cli_patterns(
    rules: AdmissionRules | None, trees: Mapping[str, Grammar]
) -> None:
    """Refuse a pattern an installed CLI cannot read: a verb it does not
    have at any level, a long option written by a prefix, or a
    subcommand ``*`` whose option no verb there declares.

    Deferred to ``create_session`` rather than done beside the other
    checks, because a CLI is registered on the workspace after it is
    built: at compile time ``git push`` is just two words, and only
    once ``git`` is installed is there a program tree to check it
    against. A head word no installed CLI claims is left alone, since
    it may be a command, a function, or a CLI registered later.

    Args:
        rules (AdmissionRules | None): the compiled document.
        trees (Mapping[str, Grammar]): each installed CLI's grammar,
            keyed by head word.

    Raises:
        PolicyError: a pattern names something its CLI lacks.
    """
    check_patterns(rules, trees)


def unread_patterns(
    rules: AdmissionRules | None, trees: Mapping[str, Grammar]
) -> list[str]:
    """The patterns whose options are not read as options: one on a
    command with no grammar, neither an installed CLI nor a builtin,
    whose options match as written, in order, and one naming an option
    its command tree's leaf does not declare, which reads as an operand
    (``undeclared_options``). Asked once a session is created, when
    every CLI it will run is installed.

    Args:
        rules (AdmissionRules | None): the compiled document.
        trees (Mapping[str, Grammar]): each installed CLI's grammar,
            keyed by head word.
    """
    if rules is None:
        return []
    out: list[str] = []
    for where, written, pattern in _written(rules):
        words = split_pattern(pattern)
        grammar = trees.get(words[0]) if words else None
        for word in (
            [] if grammar is None else undeclared_options(grammar, words)
        ):
            out.append(
                f"commands.{where}: {written}: {words[0]} declares no "
                f"{word} there, so it matches only a line with {word} as "
                "an operand"
            )
        if (
            words
            and words[0] not in trees
            and words[0] not in BUILTIN_GRAMMARS
            and any(w.startswith("-") and w != "-" for w in words[1:])
        ):
            out.append(
                f"commands.{where}: {written}: {words[0]} has no grammar "
                "here, so its options match as written, in order"
            )
    return list(dict.fromkeys(out))


def env_filled(
    rules: AdmissionRules | None,
    env: Collection[str],
    trees: Mapping[str, Grammar],
) -> list[str]:
    """Each ``{command, flags}`` entry the profile's own ``env`` closes:
    a variable it sets fills an option of that command, a filled option
    is carried as a typed one is (an agent could set the same variable),
    and the entry's flags leave it out, so the entry refuses the command
    until its flags list the option.

    Args:
        rules (AdmissionRules | None): the compiled document.
        env (Collection[str]): the variable names the profile seeds.
        trees (Mapping[str, Grammar]): each command tree's grammar,
            keyed by head word.
    """
    out: list[str] = []
    for entry in () if rules is None else rules.allow or ():
        if isinstance(entry, str):
            continue
        words = split_pattern(entry.command)
        grammar = trees.get(words[0]) if words else None
        if grammar is None:
            continue
        read = read_pattern(grammar, split_pattern(entry.pattern))
        listed = {f.name for f in read.flags} if read is not None else set()
        out += [
            f"commands.allow: {entry.pattern}: env sets {var}, which fills "
            f"{option}, so this refuses {entry.command} until its flags "
            f"list {option}"
            for var, option in env_options(grammar, words).items()
            if var in env and option not in listed
        ]
    return out


def _at_or_below(node: CommandSpec) -> Iterator[CommandSpec]:
    yield node
    for child in node.subcommands:
        yield from _at_or_below(child)


def _cluster(key: str, node: CommandSpec) -> bool:
    if key.startswith("--") or len(key) < 3:
        return False
    shorts = {
        spelling
        for spec in _at_or_below(node)
        for spelling in compile_spec(spec).dest
    }
    return all(f"-{letter}" in shorts for letter in key[1:])


def _option_name(key: str, node: CommandSpec, at: str) -> str:
    own = compile_spec(node).dest.get(key)
    if own is not None:
        return own
    meanings = sorted(
        {
            dest
            for spec in _at_or_below(node)
            if (dest := compile_spec(spec).dest.get(key)) is not None
        }
    )
    if len(meanings) == 1:
        return meanings[0]
    if meanings:
        raise PolicyError(
            f"{at}: {key} names different options below "
            f"({', '.join(meanings)}); write the long name you mean, or "
            "put the entry under its subcommand"
        )
    if _cluster(key, node):
        keys = " and ".join(f"-{letter}" for letter in key[1:])
        raise PolicyError(
            f"{at}: {key} is a cluster of options; write {keys} as "
            "separate keys"
        )
    raise PolicyError(f"{at}: no option {key} at or below this command")


def _check_values(
    name: str, words: Collection[str], node: CommandSpec, at: str
) -> None:
    arguments = [
        argument
        for spec in _at_or_below(node)
        for argument in spec.arguments
        if argument.names[0].startswith("-")
        and argument_dest(argument) == name
    ]
    if all(
        argument.action in VALUELESS_ACTIONS or argument.nargs == 0
        for argument in arguments
    ):
        raise PolicyError(f"{at}: {name} takes no value")
    choices = {choice for argument in arguments for choice in argument.choices}
    if not choices or any(not argument.choices for argument in arguments):
        return
    for word in words:
        if not GLOB_CHARS & set(word) and word not in choices:
            raise PolicyError(
                f"{at}: {name} takes none of {word!r}; its values are "
                f"{', '.join(sorted(choices))}"
            )


def _options(
    options: Mapping[str, OptionRule],
    node: CommandSpec,
    at: str,
    passthrough: bool,
) -> dict[str, OptionRule]:
    out: dict[str, OptionRule] = {}
    written: dict[str, str] = {}
    for key, rule in options.items():
        here = f"{at}.{key}"
        if passthrough:
            raise PolicyError(
                f"{here}: this command's script reads its own words, so "
                "it has no option to name"
            )
        name = _option_name(key, node, here)
        if name in written:
            raise PolicyError(
                f"{at}: {written[name]} and {key} are the same option"
            )
        written[name] = key
        if rule.values:
            _check_values(name, rule.values, node, here)
        out[name] = OptionRule(
            decision=rule.decision,
            values={
                word: ValueRule(
                    decision=value.decision,
                    options=_options(
                        value.options, node, f"{here}.values.{word}", False
                    ),
                )
                for word, value in rule.values.items()
            },
            options=_options(rule.options, node, here, False),
        )
    return out


def _no_grammar(tree: CommandNode, at: str) -> CommandNode:
    if tree.options or tree.other_options:
        raise PolicyError(
            f"{at}: this command has no grammar here to read an option by"
        )
    if tree.subcommands:
        raise PolicyError(
            f"{at}: {next(iter(tree.subcommands))} is no subcommand here; "
            "an operand goes under operands"
        )
    return replace(
        tree,
        operands={
            word: _no_grammar(node, f"{at}.operands.{word}")
            for word, node in tree.operands.items()
        },
    )


def _reserved(node: CommandSpec) -> str | None:
    return next(
        (
            word
            for child in node.subcommands
            for word in (child.name, *child.aliases)
            if word in RESERVED_WORDS
        ),
        None,
    )


def _plain(tree: CommandNode) -> bool:
    bare = not (
        tree.subcommands or tree.options or tree.other_options or tree.operands
    )
    return bare and all(
        not leaf.reason and not leaf.paths for leaf in tree.decision
    )


def _node(
    tree: CommandNode, node: CommandSpec, at: str, passthrough: bool
) -> CommandNode:
    reserved = _reserved(node)
    if reserved is not None and not _plain(tree):
        raise PolicyError(
            f"{at}: this command has a subcommand named {reserved}, which "
            "a commands block reserves; write it a plain allow, ask or "
            "deny"
        )
    subcommands: dict[str, CommandNode] = {}
    written: dict[str, str] = {}
    for key, child in tree.subcommands.items():
        found = find_child(node, key)
        if found is None and not node.subcommands:
            raise PolicyError(
                f"{at}: {key} is no subcommand here; an operand goes under "
                "operands"
            )
        if found is None:
            raise PolicyError(f"{at}: no subcommand {key}")
        if found.name in written:
            raise PolicyError(
                f"{at}: {written[found.name]} and {key} are the same "
                "subcommand"
            )
        written[found.name] = key
        subcommands[found.name] = _node(
            child, found, f"{at}.{found.name}", passthrough
        )
    if tree.operands and node.subcommands:
        raise PolicyError(
            f"{at}: this command takes a subcommand, so its operands go "
            "under one"
        )
    if tree.other_options and passthrough:
        raise PolicyError(
            f"{at}.-*: this command's script reads its own words, so it "
            "has no option to name"
        )
    return CommandNode(
        decision=tree.decision,
        subcommands=subcommands,
        options=_options(tree.options, node, at, passthrough),
        other_options=tree.other_options,
        operands={
            word: _node(child, node, f"{at}.operands.{word}", passthrough)
            for word, child in tree.operands.items()
        },
    )


def normalize_tree(
    tree: CommandNode,
    grammars: Mapping[str, Grammar],
    where: str = "commands",
    defer: bool = False,
) -> CommandNode:
    """A command tree with every name checked against its command's
    grammar and held by its canonical name, the one the line reader
    reports.

    A subcommand is held by its spec name, an option by its first long
    name or its short name when it has none. Refused: a name the grammar
    lacks; two keys for one option or one subcommand; a cluster of
    short options; a short option meaning different options in the
    subcommands below; operands on a command that takes a subcommand;
    a value under an option that takes none, or outside its choices;
    and options or subcommands on a command with no grammar, since the
    line reader gives it only operands.

    Args:
        tree (CommandNode): the tree as written.
        grammars (Mapping[str, Grammar]): each command's grammar by
            name.
        where (str): the block's name, for the messages.
        defer (bool): keep a command with no grammar as written rather
            than refuse its names, for a check made before every CLI is
            registered.

    Raises:
        PolicyError: a name does not fit its command's grammar.
    """
    commands: dict[str, CommandNode] = {}
    for name, node in tree.subcommands.items():
        grammar = grammars.get(name)
        at = f"{where}.{name}"
        if grammar is None:
            commands[name] = node if defer else _no_grammar(node, at)
            continue
        commands[name] = _node(node, grammar.spec, at, grammar.passthrough)
    return replace(tree, subcommands=commands)
