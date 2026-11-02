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

from mirage.commands.spec import SPECS
from mirage.policy.errors import PolicyError
from mirage.policy.match import head_allowed, split_pattern
from mirage.policy.types import AdmissionRules, CommandRule


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
        any(_covers_pattern(d, a) for d in deny.commands) for a in ask.commands
    )


def _uninstalled(rules: AdmissionRules) -> str | None:
    """The first rule naming a builtin the allow list never allows.

    A rule on a command the allow list leaves out reads as a guard and
    is not one: the allow list refuses the command first, so nothing
    reaches the rule and the operator is protected only in the document. Only a
    name this repo ships a spec for is judged, because any other word
    may be a CLI the host registers after the workspace is built, which
    ``unknown_cli_verbs`` checks at ``create_session`` instead.

    Args:
        rules (AdmissionRules): the compiled document.
    """
    if rules.allow is None:
        return None
    for verb, entries in (("deny", rules.deny), ("ask", rules.ask)):
        for rule in entries:
            for pattern in rule.commands:
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


def check_rules(rules: AdmissionRules | None) -> None:
    """Refuse a document whose rules cannot behave as written.

    Both checks name a rule that is dead on arrival, which is worse
    than a missing rule because it reads as a guard. Raised where the
    document is compiled, so a deployment learns at startup rather than
    the first time an agent types the line the operator thought was
    covered.

    Args:
        rules (AdmissionRules | None): the compiled document, None for
            an unrestricted session.

    Raises:
        PolicyError: a rule can never fire.
    """
    if rules is None:
        return
    for problem in (_uninstalled(rules), _dead_ask(rules)):
        if problem is not None:
            raise PolicyError(problem)


def check_cli_verbs(
    rules: AdmissionRules | None, verbs: dict[str, frozenset[str]]
) -> None:
    """Refuse a rule naming a verb the CLI it names does not have.

    Deferred to ``create_session`` rather than done beside the other
    two, because a CLI is registered on the workspace after it is
    built: at compile time ``git push`` is just two words, and only
    once ``git`` is installed is there a program tree to check the verb
    against. A head word no installed CLI claims is left alone, since
    it may be a command, a function, or a CLI registered later.

    Args:
        rules (AdmissionRules | None): the compiled document.
        verbs (dict[str, frozenset[str]]): the verbs each installed CLI
            declares, keyed by head word.

    Raises:
        PolicyError: a rule names a verb its CLI does not declare.
    """
    if rules is None:
        return
    for verb, entries in (("deny", rules.deny), ("ask", rules.ask)):
        for rule in entries:
            for pattern in rule.commands:
                tokens = split_pattern(pattern)
                if len(tokens) < 2 or tokens[0] not in verbs:
                    continue
                if tokens[1] == "*" or tokens[1] in verbs[tokens[0]]:
                    continue
                raise PolicyError(
                    f"{verb} rule names {pattern}, which the {tokens[0]} CLI "
                    "has no verb for, so the rule can never fire"
                )
