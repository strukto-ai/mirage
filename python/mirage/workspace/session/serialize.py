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

from collections.abc import Mapping, Sequence
from typing import Any

from mirage.policy.match import Outcome
from mirage.policy.types import (
    AdmissionRules,
    CommandRule,
    Decision,
    ProfileScript,
    ProfileScripts,
    Scope,
)
from mirage.runtime.types import ScriptSource


def rule_to_dict(rule: CommandRule) -> dict[str, Any]:
    """One admission rule as the session record stores it.

    Args:
        rule (CommandRule): the rule.
    """
    data: dict[str, Any] = {
        "reason": rule.reason,
        "commands": list(rule.commands),
        "paths": list(rule.paths),
    }
    if rule.mount:
        data["mount"] = rule.mount
    return data


def rule_from_dict(data: Mapping[str, Any]) -> CommandRule:
    """One admission rule read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``rule_to_dict`` wrote.
    """
    return CommandRule(
        reason=data["reason"],
        commands=tuple(data.get("commands", ())),
        paths=tuple(data.get("paths", ())),
        mount=data.get("mount", ""),
    )


def commands_to_dict(rules: AdmissionRules) -> dict[str, Any]:
    """A session's compiled admission rules as the record stores them.

    Args:
        rules (AdmissionRules): the compiled rules.
    """
    return {
        "allow": list(rules.allow) if rules.allow is not None else None,
        "ask": [rule_to_dict(r) for r in rules.ask],
        "deny": [rule_to_dict(r) for r in rules.deny],
    }


def commands_from_dict(data: Mapping[str, Any]) -> AdmissionRules:
    """A session's compiled admission rules read back from a record.

    Args:
        data (Mapping[str, Any]): what ``commands_to_dict`` wrote.
    """
    allow = data.get("allow")
    return AdmissionRules(
        allow=tuple(allow) if allow is not None else None,
        ask=tuple(rule_from_dict(r) for r in data.get("ask", ())),
        deny=tuple(rule_from_dict(r) for r in data.get("deny", ())),
    )


def script_to_dict(entry: ProfileScript) -> dict[str, Any]:
    """A session's profile script as the record stores it.

    Args:
        entry (ProfileScript): the compiled script entry.
    """
    return {
        "profile": entry.profile,
        "language": entry.script.language,
        "source": entry.script.source,
        "runtime": entry.runtime,
        "config": dict(entry.config),
    }


def script_from_dict(data: Mapping[str, Any]) -> ProfileScript:
    """A session's profile script read back from a record.

    Args:
        data (Mapping[str, Any]): what ``script_to_dict`` wrote.
    """
    return ProfileScript(
        profile=data.get("profile", ""),
        script=ScriptSource(data["source"], language=data["language"]),
        runtime=data["runtime"],
        config=dict(data.get("config") or {}),
    )


def scripts_from_dict(
    data: Mapping[str, Sequence[Mapping[str, Any]]],
) -> ProfileScripts:
    """A session's policy programs read back from a record.

    Args:
        data (Mapping[str, Sequence[Mapping[str, Any]]]): each method's
            programs, as ``script_to_dict`` wrote them.
    """
    return {
        method: tuple(script_from_dict(entry) for entry in entries)
        for method, entries in data.items()
    }


def decision_to_dict(record: Decision) -> dict[str, Any]:
    """A ledger record as the session record stores it.

    Args:
        record (Decision): the record.
    """
    return {
        "id": record.id,
        "session_id": record.session_id,
        "agent_id": record.agent_id,
        "command": record.command,
        "argv": list(record.argv),
        "cwd": record.cwd,
        "paths": list(record.paths),
        "reason": record.reason,
        "rule": rule_to_dict(record.rule),
        "outcome": record.outcome.value if record.outcome else None,
        "scope": record.scope.value,
        "note": record.note,
    }


def decision_from_dict(data: Mapping[str, Any]) -> Decision:
    """A ledger record read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``decision_to_dict`` wrote.
    """
    outcome = data.get("outcome")
    return Decision(
        id=data["id"],
        session_id=data.get("session_id", ""),
        agent_id=data.get("agent_id", ""),
        command=data.get("command", ""),
        argv=tuple(data.get("argv", ())),
        cwd=data.get("cwd", "/"),
        paths=tuple(data.get("paths", ())),
        reason=data.get("reason", ""),
        rule=rule_from_dict(data["rule"]),
        outcome=Outcome(outcome) if outcome else None,
        scope=Scope(data.get("scope", Scope.ONCE.value)),
        note=data.get("note", ""),
    )
