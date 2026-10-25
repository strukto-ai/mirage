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

from collections.abc import Sequence
from functools import lru_cache
from typing import TYPE_CHECKING, TypeAlias

from mirage._rs import (
    PolicyAdmission,
    PolicyVisibility,
)
from mirage._rs import policy_anchor_depth as policy_anchor_depth
from mirage._rs import policy_compile as policy_compile
from mirage._rs import policy_is_glob as policy_is_glob
from mirage._rs import policy_paths as policy_paths
from mirage._rs import policy_pattern as policy_pattern
from mirage._rs import policy_restrict as policy_restrict
from mirage._rs import policy_show_head as policy_show_head
from mirage._rs import policy_subjects as policy_subjects
from mirage._rs import policy_vars as policy_vars
from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ProcessScope,
    ShowEntry,
    ShownPaths,
    Visibility,
)

if TYPE_CHECKING:
    from mirage.policy.types import AdmissionRules, CommandRule

Units: TypeAlias = tuple[int, ...]
RuleValue: TypeAlias = tuple[
    Units, tuple[Units, ...], tuple[Units, ...], Units | None
]
RulesValue: TypeAlias = tuple[
    tuple[Units, ...] | None, tuple[RuleValue, ...], tuple[RuleValue, ...]
]
ShowValue: TypeAlias = tuple[Units, int | None]
ReasonValue: TypeAlias = tuple[tuple[Units, ...], Units]
PathsValue: TypeAlias = tuple[
    tuple[Units, ...], tuple[ShowValue, ...], tuple[ReasonValue, ...]
]
MountValue: TypeAlias = tuple[
    Units, int | None, RulesValue | None, PathsValue | None
]
ProfileValue: TypeAlias = tuple[
    RulesValue | None,
    PathsValue | None,
    tuple[Units, ...] | None,
    tuple[MountValue, ...] | None,
]
PathValue: TypeAlias = tuple[Units, Units]
FactsValue: TypeAlias = tuple[
    Units,
    tuple[Units, ...],
    bool,
    Units,
    tuple[PathValue, ...],
    tuple[PathValue, ...],
    bool,
    Units | None,
]

MODES = (MountMode.READ, MountMode.WRITE, MountMode.EXEC)


@lru_cache(maxsize=4096)
def _short_units(value: str) -> Units:
    return tuple(map(ord, value))


def units(value: str) -> Units:
    return _short_units(value) if len(value) <= 256 else tuple(map(ord, value))


def from_units(value: Sequence[int]) -> str:
    return "".join(map(chr, value))


@lru_cache(maxsize=1024)
def rule_value(rule: CommandRule) -> RuleValue:
    return (
        units(rule.reason),
        tuple(units(value) for value in rule.commands),
        tuple(units(value) for value in rule.paths),
        units(rule.mount),
    )


def rules_value(rules: AdmissionRules | None) -> RulesValue:
    if rules is None:
        return None, (), ()
    return (
        None if rules.allow is None else tuple(units(v) for v in rules.allow),
        tuple(rule_value(rule) for rule in rules.deny),
        tuple(rule_value(rule) for rule in rules.ask),
    )


@lru_cache(maxsize=1024)
def admission_matcher(rules: AdmissionRules | None) -> PolicyAdmission:
    return PolicyAdmission(rules_value(rules), False)


@lru_cache(maxsize=1024)
def rule_matcher(rule: CommandRule) -> PolicyAdmission:
    return PolicyAdmission((None, (rule_value(rule),), ()), False)


@lru_cache(maxsize=1024)
def visibility_matcher(vis: Visibility | None) -> PolicyVisibility:
    hidden = vis.paths if vis is not None else None
    shown = vis.shown if vis is not None else None
    variables = vis.vars if vis is not None else None
    return PolicyVisibility(
        (
            (
                tuple(units(v) for v in hidden.paths) if hidden else (),
                tuple(units(v) for v in hidden.patterns) if hidden else (),
            ),
            tuple(
                (
                    units(v.path),
                    MODES.index(v.mode) if v.mode is not None else None,
                )
                for v in shown.entries
            )
            if shown
            else (),
            (
                tuple(units(v) for v in variables.names) if variables else (),
                tuple(units(v) for v in variables.patterns)
                if variables
                else (),
            ),
        )
    )


def visibility_from_value(
    value: tuple[
        tuple[Sequence[Sequence[int]], Sequence[Sequence[int]]],
        Sequence[tuple[Sequence[int], int | None]],
        tuple[Sequence[Sequence[int]], Sequence[Sequence[int]]],
    ],
    processes: ProcessScope = "session",
) -> Visibility:
    paths, shown, variables = value
    return Visibility(
        paths=HiddenPaths(
            paths=tuple(from_units(v) for v in paths[0]),
            patterns=tuple(from_units(v) for v in paths[1]),
        )
        if paths[0] or paths[1]
        else None,
        shown=ShownPaths(
            entries=tuple(
                ShowEntry(
                    path=from_units(path),
                    mode=None if mode is None else MODES[mode],
                )
                for path, mode in shown
            )
        )
        if shown
        else None,
        vars=HiddenVars(
            names=tuple(from_units(v) for v in variables[0]),
            patterns=tuple(from_units(v) for v in variables[1]),
        )
        if variables[0] or variables[1]
        else None,
        processes=processes,
    )
