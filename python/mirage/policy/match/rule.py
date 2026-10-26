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
from typing import Any

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import WordKind
from mirage.policy.constants import (
    METADATA_OPS,
    SUBTREE_COMMANDS,
    SUBTREE_OPS,
)
from mirage.policy.match.allow import line_tokens
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    VfsContext,
)
from mirage.rs.policy import admission_matcher, units
from mirage.types import PathSpec


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


def target_directory(ctx: CommandContext) -> str | None:
    """The target directory an ``mv`` line names by option (``-t``,
    ``--target-directory``), as its grammar reads the line, so a
    ``-S.txt`` suffix is no target; None when it names none.

    Args:
        ctx (CommandContext): the classified command.
    """
    spec = SPECS["mv"]
    parsed = parse_command(spec, list(ctx.argv), ctx.cwd, "mv")
    flags = FlagView(parse_to_kwargs(parsed), spec=spec)
    return flags.as_str("target_directory")


def _path_fact(path: PathSpec) -> dict[str, list[int]]:
    return {
        "virtual_path": units(path.virtual),
        "display_path": units(path.raw_path or path.virtual),
    }


def command_facts(ctx: CommandContext) -> dict[str, Any]:
    """What a line's rules are read against, in the stream's wire shape:
    its tokens and paths, and the host's word on its command, a subtree
    command (``SUBTREE_COMMANDS``) or a move whose last operand is the
    destination.

    Args:
        ctx (CommandContext): the classified command.
    """
    moves = ctx.command == "mv"
    target = target_directory(ctx) if moves and ctx.paths else None
    return {
        "tokens": [units(v) for v in line_tokens(ctx)],
        "tool": ctx.tool,
        "cwd": units(ctx.cwd),
        "paths": [_path_fact(path) for path in ctx.paths],
        "operands": [_path_fact(path) for path in operand_paths(ctx)],
        "walks": ctx.walks,
        "subtree": ctx.command in SUBTREE_COMMANDS,
        "moves": moves,
        "move_target": None if target is None else units(target),
    }


def io_reach(
    rules: AdmissionRules | None, tokens: Sequence[str], virtual: str
) -> bool:
    """Whether a rule in force could reach an entry at or under this
    path for the running line: the rule names the line and its paths,
    or a mount rule's mount, could cover something in the subtree.

    What a native walk asks before it trusts the raw tree, per operand
    the way a hide is: a rule on ``/repo/.env`` leaves ``find /s3`` its
    native op.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        tokens (Sequence[str]): the line as an admission pattern reads
            it, command name first.
        virtual (str): absolute virtual path of the walk's start point.
    """
    return (
        rules is not None
        and admission_matcher(rules).ask(
            "io_reach",
            tokens=[units(v) for v in tokens],
            path=units(virtual),
        )
        is True
    )


def _grant_indices(
    rules: AdmissionRules, granted: Collection[CommandRule]
) -> list[int]:
    if not granted:
        return []
    return [
        index
        for index, rule in enumerate((*rules.deny, *rules.ask))
        if rule in granted
    ]


def io_refusal(
    rules: AdmissionRules | None,
    tokens: Sequence[str],
    virtual: str,
    granted: Collection[CommandRule],
) -> str | None:
    """The reason a command may not touch an entry it reached on its
    own, None when it may.

    The same law the admission gate applies to a line, and literally
    the same loop: anchor depth first,
    deny before ask at equal depth. Reading every deny before any ask
    instead would let a broad deny on ``/repo/*`` overrule an approved
    ask on ``/repo/sealed/*`` that the gate had just admitted the line
    under, so the carve-out would survive admission and then refuse
    every entry it was written for.

    The winning rule then answers: a deny refuses, an ask refuses
    unless the line holds a grant under it (the nod the gate took for
    ``rm -r /x`` covers the entries under ``/x``; a walk that wanders
    into an asked scope from outside gets no nod mid-command, so it is
    refused and the agent names the path to be asked).

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        tokens (Sequence[str]): the line's tokens, command name first.
        virtual (str): absolute virtual path of the entry.
        granted (Collection[CommandRule]): the ask rules the line runs
            under a grant for.
    """
    if rules is None:
        return None
    result = admission_matcher(rules).ask(
        "io_refusal",
        tokens=[units(v) for v in tokens],
        path=units(virtual),
        granted=_grant_indices(rules, granted),
    )
    return None if result is None else (*rules.deny, *rules.ask)[result].reason


def posix_level(rule: CommandRule) -> bool:
    """Whether a rule holds at a dispatcher too: a pure path rule, which
    names no command and has paths to match, the one kind an op can meet.

    The sort of a profile's rules: a POSIX-level rule holds at every
    entry point, a command-level one (it names a command, or no path) only
    where a line is judged.

    Args:
        rule (CommandRule): the rule.
    """
    return (
        admission_matcher(AdmissionRules(deny=(rule,))).ask(
            "posix_level", rule=0
        )
        is True
    )


def skipped_at_dispatch(rules: AdmissionRules | None) -> tuple[str, ...]:
    """The command-level parts of a profile's rules, which an entry point that
    sees only ops (a kernel mount, SFTP, codex-exec's file calls) cannot
    apply, each described for the operator's warning: the allow list and
    every rule that is not POSIX level.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
    """
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


def op_ruling(
    rules: AdmissionRules | None,
    ctx: VfsContext,
    granted: Collection[CommandRule],
) -> tuple[CommandRule, bool] | None:
    """The rule an op meets and whether it asks, None when the op may
    run.

    The dispatcher twin of :func:`io_refusal`, and the same law: anchor
    depth first, deny before ask at equal depth, and an ask satisfied
    by a grant the line already holds. Reading every deny before any
    ask instead let a broad deny on ``/repo/*`` overrule an approved
    ask on ``/repo/outbox/*``, so the carve-out command admission had
    just admitted the line under could not authorize the redirect it
    was written for: the write reached the dispatcher and was refused there.

    What an ask means is the entry point's to say: inside a running line it
    refuses like a deny, since the line was admitted without it, and
    outside one (a file tool, the host's facade) it goes to the
    approval ledger, keyed by rule and path.

    Args:
        rules (AdmissionRules | None): the session's admission rules.
        ctx (VfsContext): the op about to run.
        granted (Collection[CommandRule]): the ask rules the running
            line holds a grant under, empty when no command is bound.
    """
    if rules is None or ctx.call.name in METADATA_OPS:
        return None
    result = admission_matcher(rules).ask(
        "op_ruling",
        subtree=ctx.call.name in SUBTREE_OPS,
        path=units(ctx.path.virtual),
        granted=_grant_indices(rules, granted),
    )
    if result is None:
        return None
    index, asks = result
    return (*rules.deny, *rules.ask)[index], asks
