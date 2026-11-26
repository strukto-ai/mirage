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
from typing import Any, NotRequired, TypedDict

from mirage.policy.profile import command_tree, tree_doc
from mirage.policy.types import (
    AdmissionRules,
    CommandRule,
    Decision,
    Outcome,
    ProfileScript,
    ProfileScripts,
    Scope,
    ScopedTree,
)
from mirage.runtime.types import ScriptSource
from mirage.secrets.config import SecretRef
from mirage.workspace.session.constants import OLDER_FORMAT


class RuleJSON(TypedDict):
    reason: str
    decision: NotRequired[str]
    paths: list[str]
    at: NotRequired[str]
    mount: NotRequired[str]
    commands: NotRequired[list[str]]


class ScriptJSON(TypedDict):
    profile: str
    language: str
    source: str
    runtime: str
    config: NotRequired[dict[str, Any]]
    env: NotRequired[dict[str, str | dict[str, Any]]]


class DecisionJSON(TypedDict):
    id: str
    session_id: str
    command: str
    argv: list[str]
    cwd: str
    paths: list[str]
    reason: str
    rule: RuleJSON
    outcome: str | None
    scope: str
    note: str


def rule_to_dict(rule: CommandRule) -> RuleJSON:
    """The rule an approval is keyed on, as the session record stores
    it.

    Args:
        rule (CommandRule): the rule.
    """
    data: RuleJSON = {"reason": rule.reason, "paths": list(rule.paths)}
    if rule.decision is not Outcome.ASK:
        data["decision"] = rule.decision.value
    if rule.at:
        data["at"] = rule.at
    if rule.mount:
        data["mount"] = rule.mount
    if rule.commands:
        data["commands"] = list(rule.commands)
    return data


def rule_from_dict(data: Mapping[str, Any]) -> CommandRule:
    """The rule an approval is keyed on, read back from a session
    record.

    Args:
        data (Mapping[str, Any]): what ``rule_to_dict`` wrote.
    """
    return CommandRule(
        reason=data["reason"],
        decision=Outcome(data.get("decision", Outcome.ASK.value)),
        at=data.get("at", ""),
        paths=tuple(data.get("paths", ())),
        mount=data.get("mount", ""),
        commands=tuple(data.get("commands", ())),
    )


def commands_to_dict(rules: AdmissionRules) -> list[dict[str, Any]]:
    """A session's command trees as the record stores them, each with
    the mount it belongs to, under the ``command_trees`` field.

    Args:
        rules (AdmissionRules): the trees.
    """
    return [
        {
            "mount": scoped.mount,
            "commands": tree_doc(scoped.tree),
            **({"inline": True} if scoped.inline else {}),
        }
        for scoped in rules.trees
    ]


def commands_from_dict(
    data: Sequence[Mapping[str, Any]] | None,
    flat: Mapping[str, Any] | None = None,
) -> AdmissionRules | None:
    """A session's command trees read back from a record.

    A record written before command trees holds flat ``commands`` lists
    and no ``command_trees``. Such a session comes back closed, every
    line denied, so a restart never leaves it less restricted than it
    was; recreating the session gives it its profile's trees.

    Args:
        data (Sequence[Mapping[str, Any]] | None): what
            ``commands_to_dict`` wrote, None for a record without it.
        flat (Mapping[str, Any] | None): the record's flat ``commands``,
            None for a record without them.
    """
    if data is None:
        return None if flat is None else OLDER_FORMAT
    return AdmissionRules(
        tuple(
            ScopedTree(
                command_tree(entry["commands"]),
                entry["mount"],
                entry.get("inline", False),
            )
            for entry in data
        )
    )


def script_to_dict(entry: ProfileScript) -> ScriptJSON:
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
        "env": {
            name: (
                value
                if isinstance(value, str)
                else value.model_dump(by_alias=True)
            )
            for name, value in entry.env.items()
        },
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
        env={
            name: (
                value
                if isinstance(value, str)
                else SecretRef.model_validate(value)
            )
            for name, value in (data.get("env") or {}).items()
        },
    )


def scripts_to_dict(scripts: ProfileScripts) -> dict[str, Any]:
    """A session's policy programs as the record stores them.

    Args:
        scripts (ProfileScripts): each method's programs.
    """
    return {
        method: [script_to_dict(entry) for entry in entries]
        for method, entries in scripts.items()
    }


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


def decision_to_dict(record: Decision) -> DecisionJSON:
    """A decision record as the session record stores it.

    Args:
        record (Decision): the record.
    """
    return {
        "id": record.id,
        "session_id": record.session_id,
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
    """A decision record read back from a session record.

    Args:
        data (Mapping[str, Any]): what ``decision_to_dict`` wrote.
    """
    outcome = data.get("outcome")
    return Decision(
        id=data["id"],
        session_id=data.get("session_id", ""),
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
