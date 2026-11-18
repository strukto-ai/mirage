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
from collections.abc import Collection, Sequence
from typing import Any

from mirage.commands.spec.types import WordKind
from mirage.policy.constants import DEFAULT_DENY_REASON
from mirage.policy.match.allow import line_tokens
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRead,
    CommandRule,
    Outcome,
)
from mirage.rs.document import units
from mirage.rs.policy import Encoded, admission_matcher, rule_table
from mirage.types import Matched, PathSpec


def not_allowed(words: Sequence[str]) -> str:
    """The reason a refusal gives when nothing wrote one: the words
    that fired, ``rm --recursive is not allowed``.

    Args:
        words (Sequence[str]): the command path and options that fired.
    """
    return f"{' '.join(words)} is not allowed"


def reason_of(rule: CommandRule, matched: Matched | None) -> str:
    """Why a leaf refuses or asks: the reason written on it, else, for
    a deny that covers every path, the command path, options and keys
    that fired (``rm --recursive is not allowed``, ``echo secret* is not
    allowed``), else the default.

    A deny scoped to paths keeps the default: the line's own error
    names the path it refused.

    Args:
        rule (CommandRule): the leaf that spoke.
        matched (Matched | None): what fired; None when unknown.
    """
    if rule.reason:
        return rule.reason
    if (
        rule.decision is Outcome.DENY
        and not rule.paths
        and matched is not None
    ):
        return not_allowed((*matched.command, *matched.flags, *matched.keys))
    return DEFAULT_DENY_REASON


def operand_paths(ctx: CommandContext) -> list[PathSpec]:
    """The paths a command's operands name, in order: what ``rm -r``
    removes or ``mv``, ``tar`` and ``cp`` take as sources, never an
    option's value.

    Args:
        ctx (CommandContext): the classified command.
    """
    return [
        word.path
        for word in ctx.words
        if word.kind is WordKind.OPERAND and word.path is not None
    ]


def _path_fact(path: PathSpec) -> dict[str, list[int]]:
    return {
        "virtual_path": units(path.virtual),
        "display_path": units(path.raw_path or path.virtual),
    }


def read_wire(read: CommandRead) -> dict[str, Any]:
    """A line's read in the stream's wire shape.

    Args:
        read (CommandRead): the line's read.
    """
    return {
        "path": [units(v) for v in read.path],
        "flags": [
            {"name": units(f.name), "values": [units(v) for v in f.values]}
            for f in read.flags
        ],
        "operands": [units(v) for v in read.operands],
    }


def line_words(ctx: CommandContext) -> dict[str, Any]:
    """What a tree walks, in the stream's wire shape: the line's read
    when its grammar read it, else its tokens, and whether a tool runs it
    (a shell function is no tool). A read already holds every word, so
    the tokens are not sent beside it.

    Args:
        ctx (CommandContext): the classified command.
    """
    return {
        "tokens": (
            [units(v) for v in line_tokens(ctx)] if ctx.read is None else []
        ),
        "line": None if ctx.read is None else read_wire(ctx.read),
        "tool": ctx.tool,
    }


def command_facts(ctx: CommandContext) -> dict[str, Any]:
    """What a line's trees are judged on, in the stream's wire shape:
    its words (``line_words``) and paths, and the host's word on its
    command: whether it moves or removes whole subtrees
    (``CommandContext.subtree``) and whether it is a move whose last
    operand is the destination.

    Args:
        ctx (CommandContext): the classified command.
    """
    moves = ctx.command == "mv"
    target = ctx.move_target if moves and ctx.paths else None
    return {
        **line_words(ctx),
        "cwd": units(ctx.cwd),
        "paths": [_path_fact(path) for path in ctx.paths],
        "operands": [_path_fact(path) for path in operand_paths(ctx)],
        "walks": ctx.walks,
        "subtree": ctx.subtree,
        "moves": moves,
        "move_target": None if target is None else units(target),
    }


def naming_rules(
    rules: AdmissionRules | None, ctx: CommandContext
) -> Encoded | None:
    """The running line's walk through every tree, which each entry its
    command reaches is judged under; None when no leaf speaks for the
    line. Asked once per line, since an entry changes the path and
    never the line.

    Args:
        rules (AdmissionRules | None): the session's command trees.
        ctx (CommandContext): the running command.
    """
    if rules is None:
        return None
    walked = admission_matcher(rules).ask("naming_rules", **line_words(ctx))
    if not any(w["branches"] for w in walked):
        return None
    return Encoded(json.dumps(walked))


def io_reach(
    rules: AdmissionRules | None, named: Encoded | None, virtual: str
) -> bool:
    """Whether a leaf the running line walked could refuse an entry at
    or under this path: its paths could cover something in the subtree.

    What a native walk asks before it trusts the raw tree, per operand
    the way a hide is: a leaf on ``/repo/.env`` leaves ``find /s3`` its
    native op.

    Args:
        rules (AdmissionRules | None): the session's command trees.
        named (Encoded | None): the line's walk (``naming_rules``).
        virtual (str): absolute virtual path of the walk's start point.
    """
    return (
        rules is not None
        and named is not None
        and admission_matcher(rules).ask(
            "io_reach", walked=named, path=units(virtual)
        )
        is True
    )


def io_refusal(
    rules: AdmissionRules | None,
    named: Encoded | None,
    virtual: str,
    granted: Collection[CommandRule],
) -> str | None:
    """The reason a command may not touch an entry it reached on its
    own, None when it may.

    The entry is judged as one more path of the line, by the walk the
    gate judged the line on: the strictest leaf over every tree whose
    mount holds it. A deny refuses; an ask refuses unless the line holds
    a grant under it (the nod the gate took for ``rm -r /x`` covers the
    entries under ``/x``; a walk that wanders into an asked scope from
    outside gets no nod mid-command, so it is refused and the agent
    names the path to be asked).

    Args:
        rules (AdmissionRules | None): the session's command trees.
        named (Encoded | None): the line's walk (``naming_rules``).
        virtual (str): absolute virtual path of the entry.
        granted (Collection[CommandRule]): the asks the line runs under
            a grant for.
    """
    if rules is None or named is None:
        return None
    table = rule_table(rules)
    result = admission_matcher(rules).ask(
        "io_refusal",
        walked=named,
        path=units(virtual),
        granted=[i for i, rule in enumerate(table) if rule in granted],
    )
    return None if result is None else reason_of(table[result], None)


def skipped_at_dispatch(rules: AdmissionRules | None) -> tuple[str, ...]:
    """The command trees an entry point that sees only ops (a kernel
    mount, SFTP, codex-exec's file calls) cannot apply, each named for
    the operator's warning: every tree, since a tree judges lines.

    Args:
        rules (AdmissionRules | None): the session's command trees.
    """
    if rules is None:
        return ()
    return tuple(
        f"mounts.{scoped.mount}.commands" if scoped.mount else "commands"
        for scoped in rules.trees
    )
