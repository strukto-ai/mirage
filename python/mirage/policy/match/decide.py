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

from mirage.policy.match.rule import command_facts, reason_of
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    Outcome,
    Ruling,
)
from mirage.rs.document import from_units
from mirage.rs.policy import admission_matcher, rule_table
from mirage.types import Matched


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Ruling:
    """The profile's answer about one line: the whole law, in one place.

    Each tree that applies to the line is walked once: the words pick
    the deepest node with a decision, its options and operands only
    tighten it, and the strictest decision wins, deny over ask over
    allow. A mount's tree applies to a line working inside that mount;
    the top-level tree to every line. Every tree speaks, and the
    strictest answer is the line's.

    All of which is settled *per subject*, and only then across them,
    because a line names more than one path and a leaf written for one
    of them must not answer for the rest: with ``cp: {decision: deny,
    paths: [/protected/*]}`` and ``cp: {decision: ask, paths:
    [/review/*]}``, ``cp /protected/secret /review/out`` is the source's
    deny. A line naming no path is judged once, and a leaf with paths
    says nothing for it.

    Ranking across subjects is the whole answer for a deny, which
    refuses the line, and only half of it for an ask, which is a
    question the host still has to answer. So every ask that spoke for
    a subject is reported (``Ruling.asks``) and the entry point requires
    all of them.

    ``PermissionsPolicy`` renders this into the outcome table and
    ``explain`` reports it, so the two cannot disagree about what a
    line would do.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's command trees.
    """
    if rules is None:
        return Ruling(Outcome.ALLOW)
    result = admission_matcher(rules).ask("decide", facts=command_facts(ctx))
    table = rule_table(rules)
    rule = None if result["rule"] is None else table[result["rule"]]
    path = result["matched_path"]
    fired = result["matched"]
    matched = (
        None
        if fired is None
        else Matched(
            command=tuple(from_units(v) for v in fired["command"]),
            flags=tuple(from_units(v) for v in fired["flags"]),
        )
    )
    return Ruling(
        outcome=Outcome(result["outcome"]),
        rule=rule,
        matched_path=None if path is None else from_units(path),
        source="" if rule is None else source_of(rule),
        asks=tuple(table[index] for index in result["asks"]),
        matched=matched,
        reason="" if rule is None else reason_of(rule, matched),
    )


def source_of(rule: CommandRule) -> str:
    """Where in the document a leaf was written, as a host reads it:
    the mount section it belongs to, or the top level.

    Args:
        rule (CommandRule): the leaf that spoke.
    """
    return f"mounts.{rule.mount}" if rule.mount else "top"
