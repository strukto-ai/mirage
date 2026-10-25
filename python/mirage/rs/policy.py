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
from typing import TYPE_CHECKING, Any, TypeAlias, assert_never

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

if TYPE_CHECKING:
    from mirage.policy.types import AdmissionRules, CommandRule

Wire: TypeAlias = dict[str, Any]

CACHE_SIZE = 1024


def _open(config: Mapping[str, Any]) -> OpenStream:
    return open_stream("policy", {**config, "dialect": "python"})


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
        data = json.dumps({"op": op, **args}).encode()
        with self._lock:
            self._stream.feed(data)
            return json.loads(self._stream.finish())


def units(value: str) -> list[int]:
    """Text as the code points the stream reads, lone surrogates kept.

    Args:
        value (str): the text.
    """
    return [*map(ord, value)]


def from_units(value: Iterable[int]) -> str:
    """Code points from the stream back as text.

    Args:
        value (Iterable[int]): the code points.
    """
    return "".join(map(chr, value))


def rule_wire(rule: CommandRule) -> Wire:
    """One rule in the stream's wire shape.

    Args:
        rule (CommandRule): the rule.
    """
    return {
        "reason": units(rule.reason),
        "commands": [units(v) for v in rule.commands],
        "paths": [units(v) for v in rule.paths],
        "mount": units(rule.mount),
    }


def rules_wire(rules: AdmissionRules) -> Wire:
    """A rule set in the stream's wire shape.

    Args:
        rules (AdmissionRules): the allow list and the deny and ask
            rules.
    """
    return {
        "allow": None
        if rules.allow is None
        else [units(v) for v in rules.allow],
        "deny": [rule_wire(rule) for rule in rules.deny],
        "ask": [rule_wire(rule) for rule in rules.ask],
    }


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
