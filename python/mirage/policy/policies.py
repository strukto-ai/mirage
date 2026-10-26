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

import asyncio
import errno
import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import fields, replace
from typing import TYPE_CHECKING, Any, TypeVar, overload

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import operand_exit_code
from mirage.context.session_context import (
    Caller,
    current_caller,
    explaining,
    reset_explaining,
    set_explaining,
)
from mirage.errors.fs import eacces, erofs
from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition
from mirage.observe.context import command_records
from mirage.policy.base import Policy
from mirage.policy.builtin.mount_mode import MountModePolicy
from mirage.policy.builtin.permissions import PermissionsPolicy
from mirage.policy.constants import POLICY_DENIED_EXIT
from mirage.policy.decisions import Decisions, ask_rule, op_question
from mirage.policy.errors import Explained, PolicyDenied, PolicyError
from mirage.policy.match.decide import source_of
from mirage.policy.match.rule import operand_paths
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (
    VALIDITY,
    Abandoned,
    Ask,
    Claimant,
    CommandContext,
    CommandResultContext,
    Deny,
    DryRun,
    ExecuteResultContext,
    Outcome,
    Pending,
    PolicyCaller,
    Route,
    RouteContext,
    SessionContext,
    SessionResultContext,
    VfsContext,
    VfsExplanation,
    VfsResultContext,
    policy_caller,
)
from mirage.types import FileType, Limit, MountMode, PathSpec, Refusal
from mirage.utils.abort import MirageAbortError
from mirage.vfs.types import VfsCall
from mirage.view.types import FileView, SessionView

if TYPE_CHECKING:
    from mirage.workspace.session.session import SessionState

logger = logging.getLogger(__name__)

MethodContext = (
    CommandContext
    | RouteContext
    | VfsContext
    | VfsResultContext
    | ExecuteResultContext
    | SessionContext
)


def render_deny(subject: str, deny: Deny | Pending) -> tuple[bytes, int]:
    """The command plane's rendering of a refusal: stderr and exit code.

    The one place the outcome table for that plane is written down, so
    a document rule and a coded policy print alike, and the policy's
    reason is never mixed into what the terminal says: a Deny, or an
    unanswered ask, is bash's own ``<subject>: Permission denied`` at
    126, so stderr never tells an agent whether a retry might pass; a
    Deny about a path is the command's own GNU line for that path and
    EACCES; each leaves the reason (and an ask's id) on the result's
    ``refusal`` record. A Deny carrying an error keeps
    ``<subject>: <reason>``, because there the reason is the diagnostic
    a built-in worded in POSIX's terms. A path or an error exits at the
    command's operand-refusal code (1, tar 2).

    Args:
        subject (str): the command name (or ``line`` at the boundary).
        deny (Deny | Pending): the action, or the ledger's open question.
    """
    if isinstance(deny, Deny) and deny.path is not None:
        line = fs_error_line(subject, deny.path, eacces(deny.path))
        return line.encode(), operand_exit_code(subject)
    if isinstance(deny, Deny) and deny.error is not None:
        line = f"{subject}: {deny.reason}\n"
        return line.encode(), operand_exit_code(subject)
    return f"{subject}: Permission denied\n".encode(), POLICY_DENIED_EXIT


async def render_command_deny(
    subject: str, deny: Deny | Pending, ctx: CommandContext
) -> tuple[bytes, int]:
    """``render_deny`` for a refused command whose context is at hand.

    A Deny about a cp or mv operand says what GNU says when the step
    that operand's role takes is refused, which the bare path line
    does not: the context says which operand is a source and which the
    target, and its file view whether each is a directory. Every other
    refusal renders as ``render_deny`` renders it.

    Args:
        subject (str): the command name.
        deny (Deny | Pending): the action, or the ledger's open question.
        ctx (CommandContext): the refused command.
    """
    if isinstance(deny, Deny) and deny.path is not None:
        lines = await transfer_lines(subject, deny.path, ctx)
        if lines is not None:
            return lines.encode(), operand_exit_code(subject)
    return render_deny(subject, deny)


async def transfer_lines(
    subject: str, path: str, ctx: CommandContext
) -> str | None:
    """GNU's lines for the cp or mv operand a path deny names; None for
    another command, or a path that is none of its operands.

    The deny lands before the command touches a file, so each line is
    the one GNU prints when that operand's step is refused: cp opens a
    source file for reading, reads a source directory and creates each
    copy, and mv moves each source onto its target, or swaps the two
    under ``--exchange``. A target given by ``-t``, after more than one
    source or that is a directory takes each source by its base name,
    unless ``-T``. A source named ``.`` or ``..``, or a link cp copies
    as a link, keeps ``render_deny``'s line: GNU's there depends on what
    the directory or the link holds.

    Args:
        subject (str): the command name.
        path (str): the operand the deny names.
        ctx (CommandContext): the refused command.
    """
    if subject not in ("cp", "mv"):
        return None
    spec = SPECS[subject]
    parsed = parse_command(spec, list(ctx.argv), ctx.cwd, subject)
    flags = FlagView(parse_to_kwargs(parsed), spec=spec)
    named = flags.as_str("target_directory")
    operands = operand_paths(ctx)
    directory = next(
        (
            p
            for p in ctx.paths
            if named is not None and named in (p.raw_path, p.virtual)
        ),
        None,
    )
    if directory is not None:
        sources, target = operands, directory
    elif len(operands) > 1:
        sources, target = operands[:-1], operands[-1]
    else:
        return None
    named_source = next(
        (s for s in sources if path in (s.raw_path, s.virtual)), None
    )
    if named_source is not None:
        refused = [named_source]
    elif path in (target.raw_path, target.virtual):
        refused = list(sources)
    else:
        return None
    typed_target = parsed.raw_path_flags.get("target_directory")
    goal = (
        typed_target
        if directory is not None and isinstance(typed_target, str)
        else target.raw_path or target.virtual
    )
    into = directory is not None or (
        not flags.as_bool("no_target_directory")
        and (
            len(sources) > 1
            or await _file_type(ctx, target) == FileType.DIRECTORY
        )
    )

    def landing(name: str) -> str:
        if not into:
            return goal
        return f"{goal.rstrip('/')}/{name.rstrip('/').rsplit('/', 1)[-1]}"

    recursive = subject == "cp" and (
        flags.as_bool("r")
        or flags.as_bool("recursive")
        or flags.as_bool("archive")
    )
    typed = (
        flags.typed_order("dereference", "no_dereference", "H", "d", "archive")
        if subject == "cp"
        else []
    )
    follows = typed[-1] in ("dereference", "H") if typed else not recursive
    exchange = subject == "mv" and flags.as_bool("exchange")
    lines = []
    for src in refused:
        shown = src.raw_path or src.virtual
        if shown.rstrip("/").rsplit("/", 1)[-1] in (".", ".."):
            return None
        if exchange:
            line = f"cannot exchange '{shown}' and '{landing(shown)}'"
        elif subject == "mv":
            line = f"cannot move '{shown}' to '{landing(shown)}'"
        elif (
            not follows
            and await _file_type(ctx, src, nofollow=True) == FileType.SYMLINK
        ):
            return None
        elif await _file_type(ctx, src) != FileType.DIRECTORY:
            line = (
                f"cannot open '{shown}' for reading"
                if named_source is not None
                else f"cannot create regular file '{landing(shown)}'"
            )
        elif not recursive:
            lines.append(
                f"cp: -r not specified; omitting directory '{shown}'\n"
            )
            continue
        else:
            line = (
                f"cannot access '{shown}'"
                if named_source is not None
                else f"cannot create directory '{landing(shown)}'"
            )
        lines.append(f"{subject}: {line}: Permission denied\n")
    return "".join(lines)


async def _file_type(
    ctx: CommandContext, operand: PathSpec, nofollow: bool = False
) -> FileType | None:
    if ctx.vfs is None:
        return None
    token = set_explaining(DryRun.DECIDING)
    try:
        found = await ctx.vfs.stat(operand, nofollow=nofollow)
    except Exception as exc:
        logger.debug(
            "no stat for refused operand %s: %s", operand.virtual, exc
        )
        return None
    finally:
        reset_explaining(token)
    return found.type


def refusal_of(action: Deny | Pending) -> Refusal | None:
    """The record a refused result carries beside its bash-voiced stderr.

    None for a Deny carrying an error: that is the filesystem's own
    failure (a busy mount root, a name that exists), whose stderr line
    already says everything, so no policy refusal is recorded.

    Args:
        action (Deny | Pending): what the command plane refused with.
    """
    if isinstance(action, Deny) and action.error is not None:
        return None
    if isinstance(action, Pending):
        return Refusal(kind="pending", reason=action.reason, ask_id=action.id)
    return Refusal(
        kind="failed" if action.failed else "deny",
        reason=action.reason,
        policy=action.policy,
    )


def describe_refusal(refusal: Refusal) -> str:
    """One line saying why, for a surface that hands the agent text
    rather than a record; the agent adapters append it after stderr.

    Args:
        refusal (Refusal): the record off a refused result.
    """
    if refusal.kind == "pending":
        return f"requires approval: {refusal.reason} (ask {refusal.ask_id})"
    if refusal.kind == "failed":
        return f"policy {refusal.policy} failed"
    return f"policy denied: {refusal.reason}"


def policy_denied(
    action: Deny | Pending,
    filename: str,
    strerror: str = posix_phrase(FsCondition.EACCES),
    caller: Caller | None = None,
) -> PolicyDenied:
    """The error an entry point raises for a policy's Deny, or for a question
    the host has not answered, its record noted for the line running it.

    The error says what the terminal would, EACCES and ``strerror``;
    the reason (or the ask id the agent quotes) rides the record, on the
    error for a caller that catches it and on the line's result for one
    that only reads what a command printed.

    Args:
        action (Deny | Pending): the policy's refusal or the ledger's
            answer.
        filename (str): the path or name refused.
        strerror (str): the terminal's words, ``Permission denied``
            unless the entry point words its own.
        caller (Caller | None): who was refused, whose line notes the
            record; None for the caller bound here.
    """
    refusal = refusal_of(action)
    sink = (caller if caller is not None else current_caller()).refusals
    if refusal is not None and sink is not None:
        sink(refusal)
    return PolicyDenied(
        posix_errno(FsCondition.EACCES), strerror, filename, refusal=refusal
    )


_T = TypeVar("_T")


async def _apart(answer: Awaitable[_T]) -> _T:
    """A VFS call's policy answer, the policy's own reads recorded apart.

    They still reach the ledger, but they are no records of the call
    being judged: counted as its, they would pass for the call's own
    record (a RAM unlink records none, so the facade records it) and be
    charged to the command the call runs in.

    Args:
        answer (Awaitable[_T]): the policies' answer, not yet awaited.
    """
    with command_records(own=True):
        return await answer


async def pre_vfs_gate(
    policies: "Policies",
    call: VfsCall,
    path: PathSpec,
    write: bool,
    prefix: str,
    session_id: str = "",
    *,
    mode: MountMode | None = None,
    decisions: Decisions | None = None,
    final: bool = True,
    caller: Caller | None = None,
) -> None:
    """Fire pre_vfs at a dispatcher; a Deny becomes EACCES.

    The one seam helper both entry points (``ws.vfs`` and the dispatcher)
    call, so a refusal is byte-identical however the mount is reached:
    PermissionError with errno EACCES and the virtual path as filename,
    which the shell renders as "<cmd>: <path>: Permission denied" and
    FUSE translates to -EACCES. Commands and runtimes pass the same
    file gates. A policy method's own read meets the hides, path rules
    and mount mode alone; its write is refused. An Ask is a question only
    where no line is running and the entry
    point holds the ledger (a file tool, the host's facade): the ledger
    answers it from a standing grant or records it, and an unanswered
    one refuses with the ask id on the record. Inside a line an Ask
    refuses like a deny, since the line was admitted without it.

    Args:
        policies (Policies): the workspace's admission policies.
        call (VfsCall): the function called; a destination's with
            ``creates`` set.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the call mutates this path.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the dispatcher serves, empty for the
            unbound host view.
        mode (MountMode | None): the owning mount's mode, judged by the
            mount-mode built-in; None at an entry point that judges it itself.
        decisions (Decisions | None): the approval ledger, None at an
            entry point that cannot ask.
        final (bool): the op's last gate; False for a rename's source,
            whose destination is gated next.
        caller (Caller | None): who makes the call; None for the caller
            bound here.

    Raises:
        Explained: in a dry run (``explaining``), once the gate's answer
            is noted and the op would refuse or has no gate left: the
            entry point stops before any backend or cache is touched.
        ReadOnlyError: a write a policy makes while it decides a dry
            run's op, which the dry run may not let change anything (an
            ask its read meets reads the ledger and records nothing).
    """
    if caller is None:
        caller = current_caller()
    ctx = VfsContext(
        call=call,
        path=path,
        write=write,
        prefix=prefix,
        session_id=session_id,
        mode=mode,
        caller=policy_caller(caller.session),
    )
    trace = caller.explaining
    line = caller.refusals is not None
    if isinstance(trace, list):
        token = set_explaining(DryRun.DECIDING)
        try:
            noted = await _apart(_explained_op(policies, ctx, decisions, line))
        finally:
            reset_explaining(token)
        trace.append(noted)
        if final or noted.error:
            raise Explained()
        return
    deciding = trace is DryRun.DECIDING
    if deciding and write:
        raise erofs(path.virtual)
    if not (policies.wants("pre_vfs") or (write and mode is not None)):
        return
    answer = await _apart(policies.pre_vfs(ctx, rules_only=deciding))
    await _refuse_op(ctx, answer, None if line else decisions, caller)


async def _refuse_op(
    ctx: VfsContext,
    answer: Deny | Ask | None,
    decisions: Decisions | None,
    caller: Caller,
) -> None:
    if isinstance(answer, Ask):
        if decisions is None:
            raise policy_denied(
                Deny(answer.reason), ctx.path.virtual, caller=caller
            )
        refused = await decisions.resolve_op(ctx, answer, caller)
    else:
        refused = answer
    if isinstance(refused, Deny) and refused.error is not None:
        raise refused.error
    if refused is not None:
        raise policy_denied(refused, ctx.path.virtual, caller=caller)


async def _explained_op(
    policies: "Policies",
    ctx: VfsContext,
    decisions: Decisions | None,
    line: bool,
) -> VfsExplanation:
    """What the gate would answer one VFS call, as ``pre_vfs_gate``
    decides it and without its consequences: every policy's answer, the
    one that wins, and the error the entry point would raise. A question reads
    the ledger's settled records and records nothing.

    Args:
        policies (Policies): the workspace's admission policies.
        ctx (VfsContext): the call the gate sees.
        decisions (Decisions | None): the approval ledger, None at an
            entry point that cannot ask.
        line (bool): whether the call is a running line's, which asks
            no question.
    """
    said = await policies.answers("pre_vfs", ctx)
    answers = tuple(a for a in said if isinstance(a, (Deny, Ask)))
    winner = settled(answers)
    base = VfsExplanation(
        call=ctx.call.name, paths=(ctx.path.virtual,), answers=answers
    )
    if winner is None:
        return base
    action: Deny | Pending | None = (
        winner if isinstance(winner, Deny) else None
    )
    if isinstance(winner, Ask):
        action = (
            Deny(winner.reason, policy=winner.policy)
            if decisions is None or line
            else decisions.held_op(ctx, winner)
        )
    decided = replace(
        base,
        outcome=Outcome.ASK if isinstance(winner, Ask) else Outcome.DENY,
        reason=winner.reason,
        source="" if winner.rule is None else source_of(winner.rule),
    )
    if action is None:
        return decided
    error = action.error if isinstance(action, Deny) else None
    return replace(
        decided,
        refusal=None if error is not None else refusal_of(action),
        error=errno.errorcode.get(
            error.errno if error is not None and error.errno else errno.EACCES,
            "EACCES",
        ),
    )


async def post_vfs_gate(
    policies: "Policies",
    call: VfsCall,
    path: PathSpec,
    write: bool,
    prefix: str,
    result: Any,
    session_id: str = "",
    *,
    mode: MountMode | None = None,
    decisions: Decisions | None = None,
    caller: Caller | None = None,
) -> None:
    """Fire post_vfs at a dispatcher; a Deny, or an Ask the host has not
    approved, drops the result with EACCES.

    Nothing cuts what a call returns: a call that asks for a range, as
    a kernel or protocol mount does, must get it whole. Commands and
    runtimes pass the same gate; a policy method's own read is exempt.

    Args:
        policies (Policies): the workspace's admission policies.
        call (VfsCall): the function called.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the call mutated this path.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result, offered to the methods.
        session_id (str): the session the dispatcher serves.
        mode (MountMode | None): the owning mount's mode, as pre_vfs saw
            it.
        decisions (Decisions | None): the approval ledger, None at an
            entry point that cannot ask.
        caller (Caller | None): who made the call; None for the caller
            bound here.
    """
    if caller is None:
        caller = current_caller()
    if caller.explaining is DryRun.DECIDING or not await policies.wants_for(
        "post_vfs", session_id
    ):
        return None
    ctx = VfsResultContext(
        call=call,
        path=path,
        write=write,
        prefix=prefix,
        session_id=session_id,
        mode=mode,
        caller=policy_caller(caller.session),
        result=result,
    )
    await _refuse_op(
        ctx,
        await _apart(policies.post_vfs(ctx)),
        None if caller.refusals is not None else decisions,
        caller,
    )


async def pre_session_gate(
    policies: "Policies | None", ctx: SessionContext
) -> None:
    """Fire pre_session on the session plane; a Deny, or an Ask the host
    has not approved, becomes EACCES.

    The one seam helper the session view calls, so a refusal
    is identical however the state is reached: shell builtin, command
    view, or a later tier. None policies (a view constructed outside a
    workspace) gate nothing. An Ask goes to the workspace's ledger
    (``Policies.decisions``), inside a line too.

    Args:
        policies (Policies | None): the workspace's admission policies.
        ctx (SessionContext): the mutation, built by the session view so
            the verb, rendering and session identity are stated in
            exactly one place.

    Raises:
        PermissionError: a write a method makes while it decides
            (``ctx.session``), which may read the session but not change
            it.
    """
    if explaining() is DryRun.DECIDING:
        raise eacces(ctx.key)
    if policies is None or not policies.wants("pre_session"):
        return
    await _session_refused(policies, ctx, await policies.pre_session(ctx))


async def post_execute_gate(
    policies: "Policies",
    ctx: ExecuteResultContext,
    claimant: Claimant | None = None,
    cancel: asyncio.Event | None = None,
) -> tuple[Deny | Pending | None, Limit | None]:
    """Fire post_execute at the workspace boundary.

    Returns what drops the line's output (a Deny, or the ledger's
    answer to an Ask), else the merged Limit bound for the boundary to
    enforce. Nothing the line did is undone.

    Args:
        policies (Policies): the workspace's policies.
        ctx (ExecuteResultContext): the finished line's facts.
        claimant (Claimant | None): the line, so an approval is claimed
            on its hand-off like a ``pre_execute`` one; None outside a
            line.
        cancel (asyncio.Event | None): the run's kill channel.

    Raises:
        MirageAbortError: the run was killed while the host decided.
    """
    if not await policies.wants_for("post_execute", ctx.session_id):
        return None, None
    answer, bound = await policies.post_execute(ctx)
    if not isinstance(answer, Ask):
        return answer, bound
    said = await policies.decisions.resolve(
        *op_question(ctx, answer), cancel, claimant
    )
    if isinstance(said, Abandoned):
        raise MirageAbortError()
    return said, None if said is not None else bound


async def post_command_gate(
    policies: "Policies",
    ctx: CommandResultContext,
    claimant: Claimant | None = None,
    cancel: asyncio.Event | None = None,
) -> Deny | Pending | None:
    """Fire post_command once a command or CLI ran and its output drained.

    Returns what refuses it after the fact (a Deny, or the ledger's
    answer to an Ask), which the caller turns into exit 126 and a
    refusal record. Nothing the command did is undone.

    Args:
        policies (Policies): the workspace's policies.
        ctx (CommandResultContext): the command and what came back.
        claimant (Claimant | None): the command and its line, None
            outside a line.
        cancel (asyncio.Event | None): the run's kill channel.

    Raises:
        MirageAbortError: the run was killed while the host decided.
    """
    if not await policies.wants_for("post_command", ctx.session_id):
        return None
    answer = await policies.post_command(ctx)
    if not isinstance(answer, Ask):
        return answer
    said = await policies.decisions.resolve(ctx, answer, cancel, claimant)
    if isinstance(said, Abandoned):
        raise MirageAbortError()
    return said


async def post_session_gate(
    policies: "Policies | None", ctx: SessionContext, old: str | None
) -> None:
    """Fire post_session once a session write landed; a Deny, or an Ask
    the host has not approved, becomes EACCES, for the writer to put the
    old value back before it reports.

    Args:
        policies (Policies | None): the workspace's policies; None gates
            nothing.
        ctx (SessionContext): the write, as pre_session saw it.
        old (str | None): the value it replaced, rendered as ``value``
            is; None when the name was unset.
    """
    if policies is None or not await policies.wants_for(
        "post_session", ctx.session_id
    ):
        return
    facts = {f.name: getattr(ctx, f.name) for f in fields(ctx)}
    landed = SessionResultContext(**facts, old=old)
    await _session_refused(
        policies, landed, await policies.post_session(landed)
    )


async def _session_refused(
    policies: "Policies", ctx: SessionContext, answer: Deny | Ask | None
) -> None:
    refused = (
        await policies.decisions.resolve_op(ctx, answer)
        if isinstance(answer, Ask)
        else answer
    )
    if refused is not None:
        raise policy_denied(refused, ctx.key, f"{ctx.key}: permission denied")


def agreed(routes: list[Route]) -> Deny | Route | None:
    """The placement the policies agree on: their one runtime, None
    when none placed the line, and a Deny when two disagree.

    Args:
        routes (list[Route]): every Route the stage answered, in order.
    """
    runtimes = dict.fromkeys(route.runtime for route in routes)
    if len(runtimes) < 2:
        return routes[0] if routes else None
    said = ", ".join(f"{r.policy} on {r.runtime}" for r in routes)
    return Deny(
        f"policies place the line on different runtimes: {said}",
        policy=", ".join(dict.fromkeys(r.policy for r in routes)),
    )


@overload
def settled(answers: tuple[Deny | Ask, ...]) -> Deny | Ask | None: ...


@overload
def settled(
    answers: tuple[Deny | Ask | Route, ...],
) -> Deny | Ask | Route | None: ...


def settled(
    answers: tuple[Deny | Ask | Route, ...],
) -> Deny | Ask | Route | None:
    """What a stage's answers come to, by kind: the first Deny, else the
    first Ask, else the Route every placing answer agrees on.

    Args:
        answers (tuple[Deny | Ask | Route, ...]): every answer, in order.
    """
    deny = next((a for a in answers if isinstance(a, Deny)), None)
    if deny is not None:
        return deny
    ask = next((a for a in answers if isinstance(a, Ask)), None)
    if ask is not None:
        return ask
    return agreed([a for a in answers if isinstance(a, Route)])


class Policies:
    """Ordered policies; at every method the first Deny wins, and every
    Ask is put to the host.

    Built-ins are seeded first (MountRegistry registers
    MountRootPolicy), then the document's deny rules compiled by the
    workspace, then user policies in registration order
    (``Workspace(policies=...)``, then anything added later through
    ``add``). There is no allow arm, so adding a policy can only
    tighten the workspace, never loosen it; order decides which refusal
    message is shown, never whether a refusal holds.

    A policy that raises fails closed: the command is refused with a
    whole-command Deny naming the policy, and the error is logged. A
    policy that returns something the method may not return (VALIDITY)
    raises PolicyError: that is a programming error, not a refusal.

    A method may be ``async def`` or a plain ``def``; the seam awaits
    whatever it returns, the way the TypeScript seam accepts a value
    or a promise. Without that a plain ``def`` raised inside the
    fail-closed arm and every command read ``policy X failed``.

    The chain holds the decision ledger an Ask is put to
    (``decisions``), and ``views``, which the workspace sets to fill a
    method's read-only ``session`` and ``vfs``.

    Args:
        policies (list[Policy] | None): initial policies, consulted in
            order before anything registered later through add().
    """

    def __init__(self, policies: list[Policy] | None = None) -> None:
        self._policies: list[Policy] = list(policies or [])
        self._placement: Policy | None = None
        self._wanted: frozenset[str] = frozenset()
        self._rescan()
        self._mode = MountModePolicy()
        self.decisions = Decisions()
        self.views: (
            Callable[
                [str, "SessionState | None"],
                tuple[SessionView, FileView, PolicyCaller] | None,
            ]
            | None
        ) = None

    def place(self, placement: Policy | None) -> None:
        """Install the built-in placement, the workspace's ``route_policy``
        compiled as a policy, which answers ``pre_execute`` ahead of every
        registered one.

        It sits outside the fail-closed fold: a misconfigured route
        policy raises ``RouteError`` to the caller rather than refusing
        the line, since the mistake is the deployment's to fix.

        Args:
            placement (Policy | None): the built-in, None for none.
        """
        self._placement = placement
        self._rescan()

    def add(self, policy: Policy) -> None:
        """Register a policy after the existing ones.

        Code only: a declarative rule belongs in the permissions
        document (``commands.deny``), which the workspace compiles.

        Args:
            policy (Policy): the policy to consult after the rest.
        """
        self._policies.append(policy)
        self._rescan()

    def remove(self, policy: Policy) -> bool:
        """Remove one registration by identity; return whether it existed.

        Host-side only, like add(). Other policies keep their order.

        Args:
            policy (Policy): the exact instance passed to add().
        """
        for index, entry in enumerate(self._policies):
            if entry is policy:
                del self._policies[index]
                self._rescan()
                return True
        return False

    def wants(self, method: str) -> bool:
        """True when any policy overrides ``method``.

        O(1); the op seams gate on it so a workspace with no op
        policies pays nothing per VFS op.

        Args:
            method (str): method name (pre_command, pre_vfs, post_vfs).
        """
        return method in self._wanted

    async def wants_for(
        self, method: str, session_id: str, coded_only: bool = False
    ) -> bool:
        """True when some policy will speak at ``method`` for this session.

        The per-session refinement of ``wants``: a policy that overrides
        the method counts, unless it speaks per session
        (``SessionScopedMixin``) and says this is not one of its. For
        a seam that pays ahead for a method rather than gating on it: the
        secret fill drops its masks under a session-write gate, and a
        profile's policy at that entry point is one profile's, not every
        session's.

        Args:
            method (str): method name (pre_command, pre_vfs, pre_session).
            session_id (str): the session, empty when none is bound.
            coded_only (bool): leave the profile's rules out, for a
                caller whose line's gate already answers for them.
        """
        base = getattr(Policy, method)
        for policy in (*self._policies, *filter(None, [self._placement])):
            if coded_only and isinstance(policy, PermissionsPolicy):
                continue
            if getattr(type(policy), method) is base:
                continue
            if not isinstance(policy, SessionScopedMixin):
                return True
            if await policy.wants_for(method, session_id):
                return True
        return False

    def _rescan(self) -> None:
        wanted = set()
        policies = [*self._policies, *filter(None, [self._placement])]
        for method in VALIDITY:
            base = getattr(Policy, method)
            for policy in policies:
                if getattr(type(policy), method) is not base:
                    wanted.add(method)
                    break
        self._wanted = frozenset(wanted)

    def _chain(
        self, method: str, placed: bool, rules_only: bool = False
    ) -> tuple[Policy, ...]:
        """The policies a stage asks, in order: the built-in placement
        first at ``pre_execute`` (unless the caller placed the line),
        the registered ones, and the built-in mount mode last at
        ``pre_vfs``, after every policy that could explain the refusal
        in its own words.

        Args:
            method (str): the method in python spelling.
            placed (bool): the caller placed the line itself.
            rules_only (bool): ask the profile's rules alone
                (``PermissionsPolicy``), not the policies registered in
                code or a profile's script. Used for preliminary rule
                passes and a policy's own file reads to avoid recursion.
        """
        # A snapshot, so the order holds if the host edits registrations
        # while a method awaits. Changes take effect at the next gate.
        chain: tuple[Policy, ...] = tuple(
            p
            for p in self._policies
            if isinstance(p, PermissionsPolicy) or not rules_only
        )
        if method == "pre_execute" and self._placement and not placed:
            chain = (self._placement, *chain)
        if method == "pre_vfs":
            chain = (*chain, self._mode)
        return chain

    async def _said(
        self,
        method: str,
        ctx: MethodContext,
        every: bool,
        placed: bool = False,
        rules_only: bool = False,
    ) -> tuple[list[Deny | Ask | Route], list[Limit]]:
        """The one loop every stage runs: each policy's answer, named and
        checked against what the method may carry; a policy answering a
        tuple has each read in turn, as if its own policy had said it.
        A later Ask's rules are appended to the first Ask's, so the first
        Ask carries every question the stage raised and the host grants
        each. Each method runs as a policy deciding, with its views filled
        unless the profile's rules alone are asked.

        The entry point stops at the first Deny, since nothing after it can
        change the outcome; ``every`` goes on, so ``explain`` shows the
        answers a Deny would hide. A policy that raises answers with a
        Deny naming it (fail closed), except the built-in placement,
        which raises to the caller. A kind the method cannot carry
        (VALIDITY) raises PolicyError: a programming error, not a
        refusal, and as loud in a dry run as at the entry point.

        Args:
            method (str): the method in python spelling.
            ctx (MethodContext): the context the stage sees.
            every (bool): ask every policy, past a Deny.
            placed (bool): the caller placed the line itself, so the
                built-in placement is not asked.
            rules_only (bool): ask the profile's rules alone, as
                ``_chain`` takes it.
        """
        base = getattr(Policy, method)
        legal = VALIDITY[method]
        said: list[Deny | Ask | Route] = []
        limits: list[Limit] = []
        for policy in self._chain(method, placed, rules_only):
            if getattr(type(policy), method) is base:
                continue
            name = type(policy).__name__
            handles = (
                self.views(ctx.session_id, None)
                if not rules_only
                and self.views is not None
                and ctx.session is None
                else None
            )
            if handles is not None:
                session, vfs, caller = handles
                ctx = replace(ctx, session=session, vfs=vfs, caller=caller)
            token = set_explaining(DryRun.DECIDING)
            try:
                answered = getattr(policy, method)(ctx)
                if inspect.isawaitable(answered):
                    answered = await answered
            except Exception as exc:
                if policy is self._placement:
                    raise
                # The agent reads which policy broke, never what it
                # raised: the exception text is the deployment's to
                # debug, in the log.
                logger.error("%s policy %s raised: %s", method, name, exc)
                said.append(Deny(f"{name} failed", policy=name, failed=True))
                if not every:
                    return said, []
                continue
            finally:
                reset_explaining(token)
            for action in (
                answered if isinstance(answered, tuple) else (answered,)
            ):
                if action is None:
                    continue
                if not isinstance(action, (Deny, Ask, Route, Limit)) or (
                    action.kind not in legal
                ):
                    raise PolicyError(
                        f"{method} of {name} returned {action!r}; "
                        f"legal kinds here: {sorted(legal)}"
                    )
                if isinstance(action, Limit):
                    limits.append(action)
                    continue
                said.append(
                    action if action.policy else replace(action, policy=name)
                )
                first = next((a for a in said if isinstance(a, Ask)), None)
                if (
                    isinstance(action, Ask)
                    and first is not None
                    and first is not said[-1]
                ):
                    rules = (
                        *(first.rules or (ask_rule(ctx, first),)),
                        *(action.rules or (ask_rule(ctx, action),)),
                    )
                    said[said.index(first)] = replace(
                        first, rules=tuple(dict.fromkeys(rules))
                    )
                if isinstance(action, Deny) and not every:
                    return said, []
        return said, limits

    async def _fire(
        self,
        method: str,
        ctx: MethodContext,
        placed: bool = False,
        rules_only: bool = False,
    ) -> tuple[Deny | Ask | None, Limit | None, tuple[Route, ...]]:
        """One stage at an entry point: the first Deny wins, Limits merge.

        A refusal short-circuits (limits are moot once the result is
        suppressed); Limit actions aggregate to the tightest value per
        field, and Routes are collected for the caller to reconcile. An
        Ask is remembered and the loop goes on looking for a Deny, so a
        later policy's refusal outranks an earlier policy's question and
        an approval can never re-open a deny; the first Ask is returned,
        carrying every Ask's rules, when nothing refused.

        Args:
            method (str): the method in python spelling.
            ctx (MethodContext): the context the stage sees.
            placed (bool): the caller placed the line itself.
            rules_only (bool): ask the profile's rules alone, as
                ``_chain`` takes it.
        """
        said, limits = await self._said(method, ctx, False, placed, rules_only)
        action = settled(tuple(a for a in said if isinstance(a, (Deny, Ask))))
        if isinstance(action, Deny):
            return action, None, ()
        routes = tuple(a for a in said if isinstance(a, Route))
        return action, Limit.aggr(limits), routes

    async def answers(
        self,
        method: str,
        ctx: MethodContext,
        every: bool = True,
        rules_only: bool = False,
    ) -> tuple[Deny | Ask | Route, ...]:
        """The policies' answers at one stage, in the order the stage
        asks them, each naming its policy: what ``explain`` shows, from
        the same loop the entry point runs.

        With ``every`` no answer stops the loop, so a Deny does not hide
        the answers after it; without it the answers end at the first
        Deny, as the entry point's do. A hide never answers here, since
        the walk answers a hidden path before any policy; the built-in
        placement answers first
        at ``pre_execute`` and the built-in mount mode last at
        ``pre_vfs``, as they do at the entry point.

        Args:
            method (str): the method in python spelling.
            ctx (MethodContext): the context the stage would see.
            every (bool): ask every policy, past a Deny.
            rules_only (bool): ask the profile's rules alone, as
                ``_chain`` takes it.
        """
        said, _ = await self._said(method, ctx, every, rules_only=rules_only)
        return tuple(said)

    async def pre_command(self, ctx: CommandContext) -> Deny | Ask | None:
        """Fire pre_command across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (CommandContext): the classified command.
        """
        action, _, _ = await self._fire("pre_command", ctx)
        return action

    async def post_command(
        self, ctx: CommandResultContext
    ) -> Deny | Ask | None:
        """Fire post_command across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (CommandResultContext): the command and what came back.
        """
        action, _, _ = await self._fire("post_command", ctx)
        return action

    async def pre_execute(
        self, ctx: RouteContext, placed: bool = False
    ) -> tuple[Deny | Ask | None, Route | None]:
        """Fire pre_execute: a Deny wins, else the first Ask, which
        holds the line until the host approves it; and the Route every
        placing policy agrees on, two placing the line on different
        runtimes refusing it.

        Args:
            ctx (RouteContext): the line about to run.
            placed (bool): the caller placed the line (the runtime
                argument), so the built-in placement is not asked and a
                Route is moot; a Deny or an Ask still holds the line.
        """
        action, _, routes = await self._fire("pre_execute", ctx, placed)
        if isinstance(action, Deny) or placed:
            return action, None
        route = agreed(list(routes))
        if isinstance(route, Deny):
            return route, None
        return action, route

    async def pre_vfs(
        self,
        ctx: VfsContext,
        *,
        rules_only: bool = False,
    ) -> Deny | Ask | None:
        """Fire pre_vfs across the policies; first Deny wins, else the
        first Ask, which the entry point decides how to put.

        A hidden path never gets here: the dispatcher's walk answers it as
        absent first (``sees``), so a refusal never tells a session a
        hidden name exists. The built-in mount mode answers after the
        policies, whether or not any policy overrides the method.

        Args:
            ctx (VfsContext): the op about to run.
            rules_only (bool): ask the profile's path rules alone, for an
                op a running command makes; the mount mode answers either
                way.
        """
        action, _, _ = await self._fire("pre_vfs", ctx, rules_only=rules_only)
        return action

    async def pre_session(self, ctx: SessionContext) -> Deny | Ask | None:
        """Fire pre_session across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        action, _, _ = await self._fire("pre_session", ctx)
        return action

    async def post_session(
        self, ctx: SessionResultContext
    ) -> Deny | Ask | None:
        """Fire post_session across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (SessionResultContext): the write and the value it
                replaced.
        """
        action, _, _ = await self._fire("post_session", ctx)
        return action

    async def post_vfs(self, ctx: VfsResultContext) -> Deny | Ask | None:
        """Fire post_vfs; a Deny or an Ask holds the result back.

        Args:
            ctx (VfsResultContext): the op and its raw result.
        """
        action, _, _ = await self._fire("post_vfs", ctx)
        return action

    async def post_execute(
        self, ctx: ExecuteResultContext
    ) -> tuple[Deny | Ask | None, Limit | None]:
        """Fire post_execute; a Deny or an Ask holds the output back,
        Limits merge to the boundary bound.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        action, limit, _ = await self._fire("post_execute", ctx)
        return action, limit
