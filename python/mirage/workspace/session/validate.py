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
from collections.abc import Mapping, Sequence
from types import MappingProxyType

from mirage.commands.spec import SPECS
from mirage.policy.errors import PolicyError
from mirage.policy.match import expand_pattern, head_allowed, split_pattern
from mirage.policy.match.grammar import pattern_problem
from mirage.policy.types import (
    AdmissionRules,
    AllowFlags,
    CommandRule,
    Grammar,
)

logger = logging.getLogger(__name__)

BUILTIN_GRAMMARS: Mapping[str, Grammar] = MappingProxyType(
    {name: Grammar(spec) for name, spec in SPECS.items()}
)


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
    two commands), and a subcommand ``*`` in the allow list, which
    admits a subcommand the command gains later.

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


def check_rules(rules: AdmissionRules | None) -> None:
    """Refuse a document whose rules cannot behave as written.

    The checks name a rule that is dead on arrival, which is worse than
    a missing rule because it reads as a guard, or a pattern a builtin's
    grammar cannot read (``check_patterns``). Raised where the document
    is compiled, so a deployment learns at startup rather than the first
    time an agent types the line the operator thought was covered. What
    loads but may surprise is logged as a warning (``pattern_warnings``).

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
    """The patterns that carry an option on a command with no grammar,
    neither an installed CLI nor a builtin, so their options match as
    written, in order. Asked once a session is created, when every CLI
    it will run is installed.

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
