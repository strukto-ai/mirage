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


from mirage.policy.match.allow import line_allowed
from mirage.policy.match.rule import command_facts
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    Outcome,
    Ruling,
)
from mirage.rs.policy import admission, from_units


def decide(ctx: CommandContext, rules: AdmissionRules | None) -> Ruling:
    if rules is None:
        return Ruling(Outcome.ALLOW)
    if not line_allowed(ctx, rules):
        return Ruling(Outcome.DENY, source="commands.allow")
    matcher = admission(rules)
    result = matcher.decide(command_facts(ctx))
    listed = (*rules.deny, *rules.ask) if rules is not None else ()
    rule = listed[result[1]] if result[1] is not None else None
    return Ruling(
        outcome=(Outcome.ALLOW, Outcome.DENY, Outcome.ASK)[result[0]],
        rule=rule,
        matched_path=None if result[2] is None else from_units(result[2]),
        source="commands.allow"
        if result[3]
        else source_of(rule)
        if rule is not None
        else "",
        asks=tuple(listed[index] for index in result[4]),
    )


def source_of(rule: CommandRule) -> str:
    return f"mounts.{rule.mount}" if rule.mount else "top"
