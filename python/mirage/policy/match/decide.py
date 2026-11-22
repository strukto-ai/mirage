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

from collections.abc import Sequence

from mirage.policy.match.grammar import unread_reason
from mirage.policy.match.rule import command_facts, reason_of
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    Outcome,
    Ruling,
)
from mirage.rs.document import from_units, units
from mirage.rs.policy import admission_matcher, rule_table
from mirage.types import Matched, PathSpec


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Ruling:
    """The profile's answer about one line: the whole law, in one place.

    Each tree that applies to the line is walked once: the words pick
    the deepest node with a decision, its options and operands only
    tighten it, and the strictest decision wins, deny over ask over
    allow. A mount's tree applies to a line working inside that mount;
    the top-level tree to every line. Every tree speaks, and the
    strictest answer is the line's.

    Ranking across trees is the whole answer for a deny, which refuses
    the line, and only half of it for an ask, which is a question the
    host still has to answer: with ``mounts: {/protected: {commands:
    {cp: ask}}, /review: {commands: {cp: ask}}}``, ``cp /protected/a
    /review/b`` meets both. So every ask that spoke is reported
    (``Ruling.asks``) and the entry point requires all of them.

    ``PermissionsPolicy`` renders this into the outcome table and
    ``explain`` reports it, so the two cannot disagree about what a
    line would do.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's command trees.
    """
    if rules is None:
        return Ruling(Outcome.ALLOW)
    if ctx.command in rules.unread:
        refused = unread_ruling(ctx.command, rules)
        if refused is not None:
            return refused
    result = admission_matcher(rules).ask("decide", facts=command_facts(ctx))
    table = rule_table(rules)
    rule = None if result["rule"] is None else table[result["rule"]]
    fired = result["matched"]
    matched = (
        None
        if fired is None
        else Matched(
            command=tuple(from_units(v) for v in fired["command"]),
            flags=tuple(from_units(v) for v in fired["flags"]),
            keys=tuple(from_units(v) for v in fired["keys"]),
        )
    )
    return Ruling(
        outcome=Outcome(result["outcome"]),
        rule=rule,
        source="" if rule is None else source_of(rule),
        asks=tuple(table[index] for index in result["asks"]),
        matched=matched,
        reason="" if rule is None else reason_of(rule, matched),
    )


def unread_ruling(command: str, rules: AdmissionRules) -> Ruling | None:
    """The deny for a command whose rule names options or subcommands
    while no grammar reads it, so the line reader could not tell them
    apart from operands: the refusal ``create_session`` gives such a
    tree, as the line's reason; None when no tree names one.

    Args:
        command (str): the command the line runs.
        rules (AdmissionRules): the session's command trees.
    """
    for scoped in rules.trees:
        held = scoped.tree.subcommands.get(command)
        reason = (
            None
            if held is None
            else unread_reason(held, f"commands.{command}")
        )
        if reason is not None:
            rule = CommandRule(
                reason=reason,
                decision=Outcome.DENY,
                at=f"/{command}",
                mount=scoped.mount,
            )
            return Ruling(
                outcome=Outcome.DENY,
                rule=rule,
                source=source_of(rule),
                matched=Matched(command=(command,), flags=(), keys=()),
                reason=reason,
            )
    return None


def redirect_ruling(
    paths: Sequence[PathSpec], rules: AdmissionRules | None
) -> Ruling:
    """The profile's answer about the files a redirect opens that no
    command owns: a compound statement's (``{ cat; } < f``, a loop, a
    subshell) or a bare one (``> f``). Only the root leaf of a folder
    entry holding a path the redirect opens speaks, so ``mounts: {/keep:
    {commands: {"*": deny}}}`` refuses ``> /keep/f``. The top-level tree
    is about commands, so under ``{"*": deny, ls: allow}`` the group
    ``{ ls; } > out`` meets the same answer as ``ls > out``.

    Args:
        paths (Sequence[PathSpec]): the redirect's targets, links
            followed.
        rules (AdmissionRules | None): the session's command trees.
    """
    if rules is None or not paths:
        return Ruling(Outcome.ALLOW)
    result = admission_matcher(rules).ask(
        "redirect", paths=[units(p.virtual) for p in paths]
    )
    table = rule_table(rules)
    rule = None if result["rule"] is None else table[result["rule"]]
    path = result["matched_path"]
    return Ruling(
        outcome=Outcome(result["outcome"]),
        rule=rule,
        matched_path=None if path is None else from_units(path),
        source="" if rule is None else source_of(rule),
        asks=tuple(table[index] for index in result["asks"]),
        reason="" if rule is None else reason_of(rule, None),
    )


def source_of(rule: CommandRule) -> str:
    """Where in the document a leaf was written, as a host reads it:
    the mount section it belongs to, or the top level.

    Args:
        rule (CommandRule): the leaf that spoke.
    """
    return f"mounts.{rule.mount}" if rule.mount else "top"
