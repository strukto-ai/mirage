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

from __future__ import annotations

import json
import threading
from collections.abc import Iterable, Mapping
from functools import lru_cache
from typing import Any, TypeAlias, assert_never

from mirage.policy.constants import DEFAULT_ASK_REASON
from mirage.policy.types import (
    AdmissionRules,
    CommandNode,
    CommandRule,
    OptionRule,
    Outcome,
    RuleLeaf,
)
from mirage.rs.document import from_units, units
from mirage.rs.stream import OpenStream, open_stream
from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ProcessScope,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.path import (
    LinkEnter,
    LinkFollow,
    LinkHopLimit,
    LinkLanding,
    LinkStep,
)

Wire: TypeAlias = dict[str, Any]

CACHE_SIZE = 1024


def _open(config: Mapping[str, Any]) -> OpenStream:
    return open_stream("policy", config)


class Encoded:
    """A request field already encoded as JSON, which ``ask`` places as
    written: a value asked about on every line, such as the reads of the
    patterns on a command, is encoded once.

    Args:
        text (str): the field's JSON.
    """

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


def request(op: str, args: Mapping[str, Any]) -> bytes:
    """One request's JSON, each ``Encoded`` field placed as written.

    Args:
        op (str): the request's name.
        args (Mapping[str, Any]): its fields in the wire shape.
    """
    held: list[str] = []

    def place(value: Encoded) -> str:
        if not isinstance(value, Encoded):
            raise TypeError(f"{type(value).__name__} is not JSON")
        held.append(value.text)
        return f"\0{len(held) - 1}\0"

    text = json.dumps({"op": op, **args}, default=place)
    for at, raw in enumerate(held):
        text = text.replace(f'"\\u0000{at}\\u0000"', raw, 1)
    return text.encode()


class PolicyMatcher:
    """A profile's rules and visibility, compiled once by mirage-rs's
    ``policy`` stream and asked one request at a time. Mirrors
    TypeScript's PolicyMatcher.

    Args:
        config (Mapping[str, Any]): the ``rules`` and ``visibility`` to
            compile, in the stream's wire shape; empty for neither.
    """

    def __init__(self, config: Mapping[str, Any]) -> None:
        self._lock = threading.Lock()
        self._stream = _open(config)

    def ask(self, op: str, **args: Any) -> Any:
        """The answer to one request, decoded from its JSON.

        Args:
            op (str): the request's name, e.g. ``"path_visible"``.
            **args (Any): its fields in the wire shape, text as code
                points.
        """
        data = request(op, args)
        with self._lock:
            self._stream.feed(data)
            return json.loads(self._stream.finish())


def _leaves_wire(leaves: tuple[RuleLeaf, ...]) -> list[Wire]:
    return [
        {"decision": leaf.decision.value, "reason": units(leaf.reason)}
        for leaf in leaves
    ]


def _option_wire(rule: OptionRule) -> Wire:
    return {
        "decision": _leaves_wire(rule.decision),
        "values": [
            [
                units(word),
                {
                    "decision": _leaves_wire(value.decision),
                    "options": [
                        [units(name), _option_wire(option)]
                        for name, option in value.options.items()
                    ],
                },
            ]
            for word, value in rule.values.items()
        ],
        "options": [
            [units(name), _option_wire(option)]
            for name, option in rule.options.items()
        ],
    }


def tree_wire(node: CommandNode) -> Wire:
    """A command tree in the stream's wire shape: each map a list of
    pairs, text as code points.

    Args:
        node (CommandNode): the tree, or one node of it.
    """
    return {
        "decision": _leaves_wire(node.decision),
        "subcommands": [
            [units(name), tree_wire(child)]
            for name, child in node.subcommands.items()
        ],
        "options": [
            [units(name), _option_wire(option)]
            for name, option in node.options.items()
        ],
        "other_options": _leaves_wire(node.other_options),
        "operands": [
            [units(word), tree_wire(child)]
            for word, child in node.operands.items()
        ],
    }


def rules_wire(rules: AdmissionRules) -> Wire:
    """A session's command trees in the stream's wire shape.

    Args:
        rules (AdmissionRules): the trees, each with its mount.
    """
    return {
        "trees": [
            {
                "mount": units(scoped.mount) if scoped.mount else None,
                "root": tree_wire(scoped.tree),
            }
            for scoped in rules.trees
        ]
    }


@lru_cache(maxsize=CACHE_SIZE)
def rule_table(rules: AdmissionRules) -> tuple[CommandRule, ...]:
    """Every leaf of a session's trees as the rule a ruling names, in
    the order the stream numbers them. An ask with no reason reads as
    the default one; a deny's stays empty, since what its refusal names
    depends on the line (``reason_of``).

    Args:
        rules (AdmissionRules): the trees.
    """
    out: list[CommandRule] = []
    for row in admission_matcher(rules).ask("rules"):
        decision = Outcome(row["decision"])
        reason = from_units(row["reason"])
        if not reason and decision is Outcome.ASK:
            reason = DEFAULT_ASK_REASON
        out.append(
            CommandRule(
                reason=reason,
                decision=decision,
                at=from_units(row["at"]),
                mount=from_units(row["mount"] or []),
            )
        )
    return tuple(out)


def visibility_wire(vis: Visibility) -> Wire:
    """A session's visibility in the stream's wire shape.

    Args:
        vis (Visibility): the hides, shows and hidden variables.
    """
    hidden, shown, variables = vis.paths, vis.shown, vis.vars
    return {
        "hidden": {
            "paths": [units(v) for v in hidden.paths],
            "patterns": [units(v) for v in hidden.patterns],
        }
        if hidden is not None
        else {},
        "shown": [
            {
                "path": units(entry.path),
                "mode": entry.mode,
            }
            for entry in shown.entries
        ]
        if shown is not None
        else [],
        "vars": {
            "names": [units(v) for v in variables.names],
            "patterns": [units(v) for v in variables.patterns],
        }
        if variables is not None
        else {},
    }


def visibility_from(
    value: Mapping[str, Any], processes: ProcessScope = "session"
) -> Visibility:
    """A compiled visibility from the stream's wire shape.

    Args:
        value (Mapping[str, Any]): the ``visibility`` a compile answered.
        processes (ProcessScope): which processes the session sees.
    """
    hidden, shown, variables = value["hidden"], value["shown"], value["vars"]
    return Visibility(
        paths=HiddenPaths(
            paths=tuple(from_units(v) for v in hidden["paths"]),
            patterns=tuple(from_units(v) for v in hidden["patterns"]),
        )
        if hidden["paths"] or hidden["patterns"]
        else None,
        shown=ShownPaths(
            entries=tuple(
                ShowEntry(
                    path=from_units(entry["path"]),
                    mode=None
                    if entry["mode"] is None
                    else MountMode(entry["mode"]),
                )
                for entry in shown
            )
        )
        if shown
        else None,
        vars=HiddenVars(
            names=tuple(from_units(v) for v in variables["names"]),
            patterns=tuple(from_units(v) for v in variables["patterns"]),
        )
        if variables["names"] or variables["patterns"]
        else None,
        processes=processes,
    )


def link_trace_wire(trace: Iterable[LinkStep]) -> list[Any]:
    """A symlink walk's steps in the stream's wire shape.

    Args:
        trace (Iterable[LinkStep]): the steps ``trace_symlinks`` took.
    """
    out: list[Any] = []
    for step in trace:
        if isinstance(step, LinkFollow):
            out.append({"follow": units(step.path)})
        elif isinstance(step, LinkEnter):
            out.append(
                {
                    "enter": {
                        "path": units(step.path),
                        "next_is_parent": step.next_is_parent,
                    }
                }
            )
        elif isinstance(step, LinkLanding):
            out.append({"landing": units(step.path)})
        elif isinstance(step, LinkHopLimit):
            out.append("hop_limit")
        else:
            assert_never(step)
    return out


@lru_cache(maxsize=CACHE_SIZE)
def admission_matcher(rules: AdmissionRules | None) -> PolicyMatcher:
    """The compiled matcher for a rule set, shared by every caller asking
    the same; None answers the requests no profile scopes.

    Args:
        rules (AdmissionRules | None): the rules, None for none.
    """
    return PolicyMatcher({} if rules is None else {"rules": rules_wire(rules)})


@lru_cache(maxsize=CACHE_SIZE)
def visibility_matcher(vis: Visibility | None) -> PolicyMatcher:
    """The compiled matcher for a visibility, shared by every caller
    asking the same.

    Args:
        vis (Visibility | None): the visibility, None for an unrestricted
            one.
    """
    return PolicyMatcher(
        {} if vis is None else {"visibility": visibility_wire(vis)}
    )
