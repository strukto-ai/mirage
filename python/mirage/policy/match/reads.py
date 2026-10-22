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

from mirage.policy.match.pattern import pattern_reaches, split_pattern
from mirage.policy.types import AdmissionRules, CommandRule


def has_rules(rules: AdmissionRules | None) -> bool:
    """Whether the profile states any admission rule at all: an allow
    list, an ask or a deny.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
    """
    return rules is not None and (
        rules.allow is not None or bool(rules.ask) or bool(rules.deny)
    )


def _rule_reads_args(rule: CommandRule, name: str) -> bool:
    """Whether a rule needs a line's words past the command name to
    decide about a command: it names the command (or every command)
    and reads paths, a mount, or a token after the name.

    Args:
        rule (CommandRule): an ask or deny rule.
        name (str): the command name.
    """
    names = not rule.commands or any(
        pattern_reaches(p, (name,)) for p in rule.commands
    )
    if not names:
        return False
    if rule.paths or rule.mount:
        return True
    return any(
        pattern_reaches(p, (name,)) and len(split_pattern(p)) > 1
        for p in rule.commands
    )


def reads_args(rules: AdmissionRules | None, name: str) -> bool:
    """Whether a rule in force reads a command's words past its name.

    The whole-line gate asks this for a word the runtime, not the gate,
    will expand: the head of every command is read by every rule, but an
    argument only matters to a pattern with a token after the name
    (``git push``), a path-scoped rule, or a mount-scoped one, so a
    dynamic argument to a command no such rule names is nothing a rule
    would have seen anyway.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        name (str): the command name, as typed.
    """
    if rules is None:
        return False
    for pattern in rules.allow or ():
        if (
            pattern_reaches(pattern, (name,))
            and len(split_pattern(pattern)) > 1
        ):
            return True
    return any(
        _rule_reads_args(rule, name) for rule in (*rules.ask, *rules.deny)
    )


def scopes_paths(rules: AdmissionRules | None, name: str) -> bool:
    """Whether a path rule in force reads this command's paths.

    The argv builder asks this before deciding who resolves a glob
    operand: a mount command's pattern is normally pushed down to the
    backend, so the gate would see the pattern, not the matches, and
    ``cat /scratch/*/k`` would pass a rule on ``/scratch/private``
    that ``cat /scratch/private/k`` fails. When a rule that reads
    paths (or a mount) applies to the command, whether it names the
    command or every command, the shell expands the glob first, so
    the gate judges the paths the command will touch.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        name (str): the command name, as typed.
    """
    if rules is None:
        return False
    for rule in (*rules.ask, *rules.deny):
        if not rule.paths and not rule.mount:
            continue
        if not rule.commands or any(
            pattern_reaches(p, (name,)) for p in rule.commands
        ):
            return True
    return False
