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


from collections.abc import Collection, Sequence
from dataclasses import dataclass
from functools import lru_cache

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import WordKind
from mirage.policy.match.allow import line_tokens
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    VfsContext,
)
from mirage.rs.policy import (
    FactsValue,
    PathValue,
    admission,
    from_units,
    policy_subjects,
    units,
)
from mirage.types import HiddenPaths, PathSpec
from mirage.utils.hidden import classify_paths


@dataclass(frozen=True, slots=True)
class Subject:
    path: PathSpec | None
    holds: bool = False
    ancestors: bool = True


def operand_paths(ctx: CommandContext) -> list[PathSpec]:
    return [
        word.path
        for word in ctx.words
        if word.kind is WordKind.OPERAND and word.path is not None
    ]


def _target_directory(ctx: CommandContext) -> str | None:
    spec = SPECS["mv"]
    parsed = parse_command(spec, list(ctx.argv), ctx.cwd, "mv")
    flags = FlagView(parse_to_kwargs(parsed), spec=spec)
    return flags.as_str("target_directory")


def path_value(path: PathSpec) -> PathValue:
    return units(path.virtual), units(path.raw_path or path.virtual)


def command_facts(ctx: CommandContext) -> FactsValue:
    return (
        units(ctx.command),
        tuple(units(value) for value in line_tokens(ctx)),
        ctx.tool,
        units(ctx.cwd),
        tuple(path_value(path) for path in ctx.paths),
        tuple(path_value(path) for path in operand_paths(ctx)),
        ctx.walks,
        units(target)
        if ctx.command == "mv"
        and ctx.paths
        and (target := _target_directory(ctx)) is not None
        else None,
    )


def subjects(ctx: CommandContext) -> tuple[Subject, ...]:
    paths = (*ctx.paths, *operand_paths(ctx))
    return tuple(
        Subject(
            next(
                (
                    path
                    for path in paths
                    if path.virtual == from_units(value[0])
                    and (path.raw_path or path.virtual) == from_units(value[1])
                ),
                None,
            )
            if value is not None
            else None,
            holds=holds,
            ancestors=ancestors,
        )
        for value, holds, ancestors in policy_subjects(command_facts(ctx))
    )


@lru_cache(maxsize=1024)
def _single(rule: CommandRule) -> AdmissionRules:
    return AdmissionRules(deny=(rule,))


def rule_applies(rule: CommandRule, ctx: CommandContext) -> bool:
    return admission(_single(rule)).rule_applies(0, command_facts(ctx))


def rule_reach(
    rule: CommandRule, scope: HiddenPaths | None, subject: Subject
) -> int | None:
    return admission(_single(rule)).rule_reach(
        0,
        (
            path_value(subject.path) if subject.path is not None else None,
            subject.holds,
            subject.ancestors,
        ),
    )


def hidden_depth(rule: CommandRule, virtual: str) -> int:
    return admission(_single(rule)).hidden_depth(0, units(virtual))


def covers_depth(
    rule: CommandRule, virtual: str, ancestors: bool = True
) -> int:
    return admission(_single(rule)).covers_depth(0, units(virtual), ancestors)


@lru_cache(maxsize=1024)
def rule_scope(rule: CommandRule) -> HiddenPaths | None:
    return classify_paths(rule.paths)


def match_io(
    rule: CommandRule,
    scope: HiddenPaths | None,
    tokens: Sequence[str],
    virtual: str,
    subtree: bool = False,
) -> bool:
    return admission(_single(rule)).match_io(
        0, tuple(units(value) for value in tokens), units(virtual), subtree
    )


def io_reach(
    rules: AdmissionRules | None, tokens: Sequence[str], virtual: str
) -> bool:
    return admission(rules).io_reach(
        tuple(units(value) for value in tokens), units(virtual)
    )


def _granted(
    rules: AdmissionRules, granted: Collection[CommandRule]
) -> tuple[int, ...]:
    return tuple(
        index
        for index, rule in enumerate((*rules.deny, *rules.ask))
        if rule in granted
    )


def io_refusal(
    rules: AdmissionRules | None,
    tokens: Sequence[str],
    virtual: str,
    granted: Collection[CommandRule],
) -> str | None:
    if rules is None:
        return None
    result = admission(rules).io_refusal(
        tuple(units(value) for value in tokens),
        units(virtual),
        _granted(rules, granted),
    )
    return None if result is None else (*rules.deny, *rules.ask)[result].reason


def posix_level(rule: CommandRule) -> bool:
    return admission(_single(rule)).posix_level(0)


def skipped_at_dispatch(rules: AdmissionRules | None) -> tuple[str, ...]:
    if rules is None:
        return ()
    skipped = ["commands.allow"] if rules.allow is not None else []
    for verb, listed in (("deny", rules.deny), ("ask", rules.ask)):
        skipped.extend(
            f"commands.{verb}: {rule.reason}"
            for rule in listed
            if not posix_level(rule)
        )
    return tuple(skipped)


def op_reach(
    rule: CommandRule, scope: HiddenPaths | None, ctx: VfsContext
) -> int | None:
    return admission(_single(rule)).op_reach(
        0, units(ctx.call.name), units(ctx.path.virtual)
    )


def op_ruling(
    rules: AdmissionRules | None,
    ctx: VfsContext,
    granted: Collection[CommandRule],
) -> tuple[CommandRule, bool] | None:
    if rules is None:
        return None
    result = admission(rules).op_ruling(
        units(ctx.call.name), units(ctx.path.virtual), _granted(rules, granted)
    )
    return (
        None
        if result is None
        else ((*rules.deny, *rules.ask)[result[0]], result[1])
    )
