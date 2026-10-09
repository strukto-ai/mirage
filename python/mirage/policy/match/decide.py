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

from dataclasses import replace

from mirage.policy.constants import VERB_ORDER
from mirage.policy.match.allow import line_allowed
from mirage.policy.match.rule import (
    Subject,
    better_match,
    matched_operand,
    rule_applies,
    rule_reach,
    rule_scope,
    subjects,
)
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    LiveRules,
    Outcome,
    Ruling,
)


def outranks(current: tuple[int, int], verb: int, depth: int) -> bool:
    """Whether one subject's decision outranks the line's best so far:
    the stronger verb first, then the deeper anchor.

    The mirror image of :func:`better_match`, and deliberately so. Two
    rules about *one* subject are a question of specificity, so depth
    leads there. Two subjects of one line are a question of severity:
    every path a line names has to survive it, so a deny anywhere
    refuses the line however deeply another path was carved out.

    Args:
        current (tuple[int, int]): the chosen (verb, depth) so far.
        verb (int): the candidate subject's verb.
        depth (int): the candidate subject's anchor depth.
    """
    best_verb, best_depth = current
    if verb != best_verb:
        return verb < best_verb
    return depth > best_depth


def rule_at(
    live: LiveRules, subject: Subject
) -> tuple[Outcome, CommandRule, int] | None:
    """The rule that speaks about one subject of a line, None when none
    does: the deepest anchor, deny before ask at equal depth, the
    earlier rule on a full tie.

    Args:
        live (LiveRules): the rules that apply to this line, deny
            before ask, in the order written.
        subject (Subject): one subject of the line.
    """
    best: tuple[int, int] | None = None
    chosen: tuple[Outcome, CommandRule, int] | None = None
    for outcome, rule in live:
        depth = rule_reach(rule, rule_scope(rule), subject)
        if depth is None or not better_match(best, depth, VERB_ORDER[outcome]):
            continue
        best = (depth, VERB_ORDER[outcome])
        chosen = (outcome, rule, depth)
    return chosen


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Ruling:
    """The profile's answer about one line: the whole law, in one place.

    Two rules, because a command name and a path are not the same kind
    of thing. A rule naming no path is read by verb, deny before ask,
    wherever it was written: it is off the path axis entirely, so one
    in a mount section scores 0 exactly as a top-level one does.
    Writing it under ``mounts./repo`` scopes it to lines working inside
    that mount (``rule_applies`` reads ``rule.mount``); it does not
    make it more specific than a rule about the whole session. That is
    what keeps "denied generally, asked inside one mount" inexpressible
    for a pathless rule, which in practice means an account CLI: such a
    CLI reaches a service and touches no mount, so scoping it to one
    was never meaningful.

    A rule carrying paths is read by anchor depth, the deeper entry
    winning, ties broken by verb. The depth is the matched entry's, not
    the rule's deepest, so an entry that says nothing about this
    operand cannot lend it specificity. The allow list is asked first,
    since a line no list covers never reaches a rule.

    All of which is settled *per subject*, and only then across them
    (:func:`outranks`), because a line names more than one path and a
    carve-out written for one of them must not answer for the rest:
    with ``deny cp /protected/*`` and a deeper ``ask cp /review/deep/*``,
    ``cp /protected/secret /review/deep/out`` is the source's deny, and
    reading one best match for the whole line answered it with the
    destination's ask instead, so a nod meant for the destination
    carried the protected file out.

    Ranking across subjects is the whole answer for a deny, which
    refuses the line, and only half of it for an ask, which is a
    question the host still has to answer. So every ask that won a
    subject of its own is reported (``Ruling.asks``) and the entry point
    requires all of them: with ``ask cp /a/*`` and a deeper
    ``ask cp /deep/b/*``, ``cp /a/x /deep/b/y`` used to present the
    deeper one alone, and a nod for the destination ran the line
    without the source ever being asked about.

    ``PermissionsPolicy`` renders this into the outcome table and
    ``explain`` reports it, so the two cannot disagree about what a
    line would do.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's admission rules.
    """
    if rules is None:
        return Ruling(Outcome.ALLOW)
    if not line_allowed(ctx, rules):
        return Ruling(Outcome.DENY, source="commands.allow")
    live: LiveRules = [
        (outcome, rule)
        for outcome, written in (
            (Outcome.DENY, rules.deny),
            (Outcome.ASK, rules.ask),
        )
        for rule in written
        if rule_applies(rule, ctx)
    ]
    best: tuple[int, int] | None = None
    chosen = Ruling(Outcome.ALLOW)
    asked: list[CommandRule] = []
    for subject in subjects(ctx):
        spoke = rule_at(live, subject)
        if spoke is None:
            continue
        outcome, rule, depth = spoke
        if outcome is Outcome.ASK and rule not in asked:
            asked.append(rule)
        verb = VERB_ORDER[outcome]
        if best is not None and not outranks(best, verb, depth):
            continue
        best = (verb, depth)
        chosen = Ruling(
            outcome=outcome,
            rule=rule,
            matched_path=matched_operand(rule, subject),
            source=source_of(rule),
        )
    if chosen.outcome is not Outcome.ASK:
        return chosen
    return replace(chosen, asks=tuple(asked))


def source_of(rule: CommandRule) -> str:
    """Where in the document a rule was written, as a host reads it:
    the mount section it belongs to, or the top level.

    Args:
        rule (CommandRule): the rule that spoke.
    """
    return f"mounts.{rule.mount}" if rule.mount else "top"
