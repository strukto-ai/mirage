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

import json
from dataclasses import dataclass, replace
from itertools import count
from typing import Any, TypeAlias, TypeGuard

from mirage.policy.decisions import ask_rule
from mirage.policy.errors import PolicyError
from mirage.policy.types import (
    Ask,
    CommandContext,
    CommandRule,
    Deny,
    Route,
    RouteContext,
    SessionContext,
    VfsContext,
)
from mirage.rs.errors import StreamRefusal
from mirage.rs.policy import units
from mirage.rs.stream import open_stream
from mirage.types import Limit

Answer: TypeAlias = Deny | Ask | Route
Context: TypeAlias = (
    CommandContext | RouteContext | VfsContext | SessionContext
)
PACKET_BYTES = 8 * 1024 * 1024
sequence = count(1)
limit_fields = (
    "max_bytes",
    "max_lines",
    "timeout_seconds",
    "walk_limit",
    "on_exceed",
)


def is_answer(value: Any) -> TypeGuard[Answer]:
    return isinstance(value, (Deny, Ask, Route))


def effect_schema(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("op") not in (
        "run_policy",
        "read_action",
        "read_settlement_action",
        "read_ask_rules",
        "replace_ask_rules",
        "read_final_values",
    ):
        raise StreamRefusal("invalid policy effect", b"")
    if not isinstance(value.get("evaluation"), str) or not isinstance(
        value.get("effect"), int
    ):
        raise StreamRefusal("invalid policy effect identity", b"")
    scalar_fields = {
        "run_policy": ("slot",),
        "read_action": ("slot",),
        "read_settlement_action": ("slot",),
        "read_ask_rules": ("first", "next"),
        "replace_ask_rules": ("action",),
        "read_final_values": (),
    }
    for key in scalar_fields[value["op"]]:
        if not isinstance(value.get(key), int) or value[key] < 0:
            raise StreamRefusal("invalid policy effect reference", b"")
    array_fields = {
        "replace_ask_rules": ("rules",),
        "read_final_values": ("routes", "limits"),
    }
    for key in array_fields.get(value["op"], ()):
        if not isinstance(value.get(key), list) or any(
            not isinstance(index, int) or index < 0 for index in value[key]
        ):
            raise StreamRefusal("invalid policy effect references", b"")
    return value


def result_schema(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StreamRefusal("invalid policy result", b"")
    for key in ("answers", "conflict", "ask_rules"):
        entries = value[key]
        if key == "ask_rules" and entries is None:
            continue
        if not isinstance(entries, list) or any(
            not isinstance(v, int) or v < 0 for v in entries
        ):
            raise StreamRefusal("invalid policy result references", b"")
    for key in ("action", "route"):
        index = value[key]
        if index is not None and (not isinstance(index, int) or index < 0):
            raise StreamRefusal("invalid policy result reference", b"")
    limit = value["limit"]
    if limit is not None:
        if not isinstance(limit, dict) or any(
            key not in limit_fields for key in limit
        ):
            raise StreamRefusal("invalid policy limit result", b"")
        Limit(**limit)
    invalid = value["invalid"]
    if invalid is not None and (
        not isinstance(invalid, dict)
        or not isinstance(invalid.get("action"), int)
        or not isinstance(invalid.get("slot"), int)
        or not isinstance(invalid.get("legal"), list)
        or any(not isinstance(kind, str) for kind in invalid["legal"])
    ):
        raise StreamRefusal("invalid policy error result", b"")
    return value


@dataclass(frozen=True, slots=True)
class CompositionResult:
    answers: tuple[Deny | Ask | Route, ...]
    action: Deny | Ask | None
    route: Route | None
    limit: Limit | None


class Composition:
    def __init__(self) -> None:
        self.stream = open_stream("policy_compose", {})
        self.evaluation = f"evaluation-{next(sequence)}"
        self.actions: list[Any] = []
        self.originals: list[Any] = []
        self.rules: list[CommandRule] = []
        self.rule_ids: dict[CommandRule, int] = {}
        self.names: dict[int, str] = {}

    def feed(self, value: dict[str, Any]) -> None:
        self.stream.feed(self.packet(value))

    @staticmethod
    def packet(value: dict[str, Any]) -> bytes:
        data = json.dumps(value).encode()
        if len(data) > PACKET_BYTES:
            raise StreamRefusal(
                "policy composition packet limit exceeded", b""
            )
        return data

    def rule_id(self, rule: CommandRule) -> int:
        index = self.rule_ids.get(rule)
        if index is None:
            index = len(self.rules)
            self.rule_ids[rule] = index
            self.rules.append(rule)
        return index

    def descriptors(self, answered: Any, name: str) -> list[dict[str, Any]]:
        descriptors = []
        for value in answered if isinstance(answered, tuple) else (answered,):
            if value is None:
                continue
            index = len(self.actions)
            self.actions.append(value)
            self.originals.append(value)
            descriptor: dict[str, Any] = {"kind": "invalid", "action": index}
            if isinstance(value, Limit):
                descriptor = {"kind": "limit", "action": index}
            elif is_answer(value):
                action = (
                    value
                    if value.policy or not name
                    else replace(value, policy=name)
                )
                self.actions[index] = action
                descriptor = {"kind": action.kind, "action": index}
            descriptors.append(descriptor)
        return descriptors

    def request(self) -> dict[str, Any] | None:
        requested = self.stream.request()
        return None if requested is None else effect_schema(requested[0])

    def respond(
        self,
        effect: dict[str, Any],
        answered: Any,
        name: str,
        more: bool,
    ) -> None:
        value = {
            "evaluation": self.evaluation,
            "effect": effect["effect"],
            "actions": self.descriptors((answered,), name),
            "more": more,
        }
        self.packet(value)
        self.stream.respond(value, b"")

    def respond_effect(
        self, effect: dict[str, Any], ctx: Context | None = None
    ) -> bool:
        identity = {"evaluation": self.evaluation, "effect": effect["effect"]}
        response: dict[str, Any]
        match effect["op"]:
            case "read_settlement_action":
                index = effect["slot"]
                action = self.actions[index]
                kind = (
                    "deny"
                    if isinstance(action, Deny)
                    else "ask"
                    if isinstance(action, Ask)
                    else "route"
                    if isinstance(action, Route)
                    else "invalid"
                )
                response = {
                    **identity,
                    "actions": [{"kind": kind, "action": index}],
                }
            case "read_ask_rules":
                first = self.actions[effect["first"]]
                other = self.originals[effect["next"]]
                same_ask = first is self.actions[effect["next"]]
                assert (
                    isinstance(first, Ask)
                    and isinstance(other, Ask)
                    and ctx is not None
                )
                self.rules.clear()
                self.rule_ids.clear()
                first_rules: tuple[CommandRule, ...]
                next_rules: tuple[CommandRule, ...]
                if same_ask:
                    first_rules = next_rules = ()
                else:
                    first_rules = first.rules or (ask_rule(ctx, first),)
                    next_rules = other.rules or (ask_rule(ctx, other),)
                response = {
                    **identity,
                    "first_rules": [
                        self.rule_id(rule) for rule in first_rules
                    ],
                    "next_rules": [self.rule_id(rule) for rule in next_rules],
                    "same_ask": same_ask,
                }
            case "replace_ask_rules":
                action = self.actions[effect["action"]]
                assert isinstance(action, Ask)
                self.actions[effect["action"]] = replace(
                    action,
                    rules=tuple(
                        self.rules[index] for index in effect["rules"]
                    ),
                )
                response = identity
            case "read_final_values":
                routes = []
                for index in effect["routes"]:
                    route = self.actions[index]
                    assert isinstance(route, Route)
                    routes.append(
                        {
                            "action": index,
                            "runtime": units(route.runtime),
                        }
                    )
                limits = []
                named_fields = set().union(
                    *(
                        self.actions[index].model_fields_set
                        for index in effect["limits"]
                    )
                )
                for index in effect["limits"]:
                    limit = self.actions[index]
                    assert isinstance(limit, Limit)
                    fields = {
                        key: getattr(limit, key)
                        for key in limit_fields
                        if key in named_fields
                    }
                    for key in ("max_bytes", "max_lines", "walk_limit"):
                        if fields.get(key) is not None:
                            fields[key] = str(fields[key])
                    limits.append({"action": index, "value": fields})
                response = {**identity, "routes": routes, "limits": limits}
            case _:
                return False
        self.packet(response)
        self.stream.respond(response, b"")
        return True

    def result(self, method: str = "") -> CompositionResult:
        result = result_schema(json.loads(self.stream.finish()))
        invalid = result["invalid"]
        if invalid is not None:
            value = self.actions[invalid["action"]]
            name = self.names[invalid["slot"]]
            raise PolicyError(
                f"{method} of {name} returned {value!r}; "
                f"legal kinds here: {invalid['legal']}"
            )
        answers = [self.actions[index] for index in result["answers"]]
        selected = (
            None
            if result["action"] is None
            else self.actions[result["action"]]
        )
        route = (
            None if result["route"] is None else self.actions[result["route"]]
        )
        if isinstance(selected, Route):
            route = selected
            selected = None
        if result["conflict"]:
            routes = [self.actions[index] for index in result["conflict"]]
            said = ", ".join(f"{r.policy} on {r.runtime}" for r in routes)
            selected = Deny(
                f"policies place the line on different runtimes: {said}",
                policy=", ".join(dict.fromkeys(r.policy for r in routes)),
            )
        return CompositionResult(
            tuple(answers),
            selected,
            route,
            None if result["limit"] is None else Limit(**result["limit"]),
        )

    def close(self) -> None:
        self.stream.cancel()


def compose_settled(
    answers: tuple[Deny | Ask | Route, ...], mode: str
) -> Deny | Ask | Route | None:
    composition = Composition()
    try:
        composition.actions.extend(answers)
        composition.feed(
            {
                "op": "settle",
                "mode": mode,
                "evaluation": composition.evaluation,
                "count": len(answers),
            }
        )
        composition.stream.finish()
        while effect := composition.request():
            if not composition.respond_effect(effect):
                raise StreamRefusal("invalid settlement effect", b"")
        result = composition.result()
        return result.action if result.action is not None else result.route
    finally:
        composition.close()
