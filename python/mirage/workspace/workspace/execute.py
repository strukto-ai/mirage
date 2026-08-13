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
import logging
from functools import partial
from typing import Any

from mirage.commands.builtin.utils.limit import (CommandTimeoutError,
                                                 run_with_timeout)
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.context import RecordingScope
from mirage.policy import resolve_limit
from mirage.provision import ProvisionResult
from mirage.runtime.policy import PolicyDecision, PolicyDeny, PolicyError
from mirage.shell.parse import (find_syntax_error, find_unterminated_backtick,
                                parse)
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.node import provision_node, run_command_tree
from mirage.workspace.session import (get_current_session,
                                      reset_current_session,
                                      set_current_session)
from mirage.workspace.snapshot import ContentDriftError
from mirage.workspace.workspace.failure import failure_result
from mirage.workspace.workspace.line import run_whole_line
from mirage.workspace.workspace.utils import command_name, fork_for_call

logger = logging.getLogger(__name__)


async def plan_eval_stub(cmd: str, **opts: Any) -> IOResult:
    """Inert evaluator for provision walks.

    A dry run must never execute: a command substitution with side
    effects ($(tee ...)) would otherwise run while "estimating".
    Substitutions expand to empty, so affected words degrade the
    plan to honest UNKNOWN instead of resolving via execution.

    Args:
        cmd (str): the substitution's command line, ignored.
    """
    return IOResult()


async def recurse(ws, cancel: asyncio.Event | None,
                  routing_decision: PolicyDecision | None, cmd: str,
                  **opts: Any) -> Any:
    """The executor's internal eval ($(), source, eval, xargs, ...).

    Never a typed line, so it must not record a history entry or open
    its own recording context (GNU: history is appended by the line
    reader, the evaluator can't touch it). It inherits the typed
    line's routing decision: nested lines never re-route.

    Args:
        ws: the workspace hosting the outer line.
        cancel (asyncio.Event | None): the outer line's abort event.
        routing_decision (PolicyDecision | None): the typed line's
            decision, inherited verbatim.
        cmd (str): the nested command line.
    """
    return await ws.execute(cmd,
                            cancel=cancel,
                            record=False,
                            routing_decision=routing_decision,
                            **opts)


def session_cwd(ws, session_id: str) -> str | None:
    """The session's cwd for history, None once the session is gone.

    Args:
        ws: the workspace owning the session manager.
        session_id (str): session whose cwd the history entry records.
    """
    try:
        return ws._session_mgr.get(session_id).cwd
    except KeyError:
        return None


def syntax_error_result(offending: str) -> IOResult:
    """Exit 2 with the bash-style diagnostic for an unparsable line.

    Args:
        offending (str): the span the parser flagged.
    """
    snippet = offending.strip()
    err = (f"mirage: syntax error near {snippet!r}\n".encode()
           if snippet else b"mirage: syntax error in command\n")
    return IOResult(exit_code=2, stderr=err)


async def execute_line(
    ws,
    command: str,
    session_id: str | None,
    stdin: ByteSource | None,
    provision: bool,
    agent_id: str | None,
    cwd: str | None,
    env: dict[str, str] | None,
    cancel: asyncio.Event | None,
    record: bool,
    runtime: str | None,
    routing_decision: PolicyDecision | None,
) -> IOResult | ProvisionResult:
    """The body of ``Workspace.execute``; see its docstring for the
    argument contract.

    Order of gates: hydrate stores, drain any queued drift check,
    resolve the session, parse, syntax gate, policy, then one of three
    strategies (provision walk, whole-line runtime, command tree).
    Failures fold into the line's ``IOResult`` via ``failure_result``,
    except the kinds that are the caller's problem (abort, drift,
    policy misconfiguration), which propagate.

    Args:
        ws: the workspace the line runs in.
    """
    if cancel is not None and cancel.is_set():
        raise MirageAbortError()
    await ws._namespace.ensure_loaded()
    await ws._meta.ensure()
    await ws._session_mgr.ensure_loaded()
    if ws._drift.pending:
        await ws._drift.drain(ws._registry.mount_for)

    # A re-entrant execute (the evaluator's $(), eval, source, xargs, or
    # an embedder callback fired mid-line) continues in the live ambient
    # session unless it names a different one. An id cannot say that: it
    # names a registered session, never the ephemeral per-call fork the
    # outer line actually runs in, and re-resolving through the manager
    # is how a nested line used to escape the fork and its confinement.
    ambient = get_current_session()
    if ambient is not None and session_id in (None, ambient.session_id):
        session = ambient
        session_id = ambient.session_id
    else:
        if session_id is None:
            session_id = ws._session_mgr.default_id
        session = ws._session_mgr.get(session_id)
    effective_session = fork_for_call(session, cwd, env)
    ws._current_agent_id = (agent_id
                            if agent_id is not None else ws._default_agent_id)
    io = IOResult()
    # The line-reader decision (GNU: history is appended where the
    # typed line is read, never inside the evaluator). Internal
    # evaluations and provision runs get an inert scope.
    is_line = record and not provision
    if is_line:
        # Each typed line reads stdin fresh; a buffer left behind by a
        # previous line's read/select would otherwise serve EOF forever.
        effective_session._stdin_buffer = None
    scope = RecordingScope(active=is_line)

    session_token = set_current_session(effective_session)
    try:
        ast = parse(command)
        # Syntax gates before policy, mirroring the TS order and
        # bash: an unparsable line exits 2 and the policy is never
        # consulted about it.
        offending = find_syntax_error(ast)
        if offending is None:
            # tree-sitter accepts an unclosed backtick as a complete
            # command, so the region is scanned separately.
            offending = find_unterminated_backtick(command)
        if offending is not None:
            io = syntax_error_result(offending)
            return io
        decision = await ws._policy_router.decide(ast, command, runtime,
                                                  provision, effective_session,
                                                  session_id,
                                                  ws._current_agent_id or "",
                                                  ws._policy, routing_decision)
        exec_recursion = partial(recurse, ws, cancel, decision)
        if provision:
            name = command_name(command)
            guard = resolve_limit(name) if name else None
            timeout = guard.timeout_seconds if guard is not None else None
            return await run_with_timeout(
                provision_node(ws._registry, ws.dispatch, plan_eval_stub,
                               ws._namespace, ast, effective_session), timeout,
                name)
        line_runtime = ws._runtimes.whole_line(ast, decision)
        if line_runtime is not None:
            io = await run_whole_line(
                line_runtime, command, stdin, effective_session,
                ws._registry.mounts(), ws._registry.policies,
                ws._dispatcher.invalidate_all_after_remote)
            session.last_exit_code = io.exit_code
            return io
        io, _ = await run_command_tree(
            ws.dispatch,
            ws._registry,
            ws._namespace,
            ws.job_table,
            exec_recursion,
            ws._current_agent_id or "",
            ast,
            effective_session,
            stdin,
            cancel,
            routing_decision=decision,
        )
        session.last_exit_code = io.exit_code
        await ws.apply_io(io, records=scope.records)
        return io
    except CommandTimeoutError as exc:
        logger.debug("command %r timed out after %ss", exc.command,
                     exc.seconds)
        if cancel is not None:
            cancel.set()
        io = failure_result(exc, command)
        session.last_exit_code = io.exit_code
        return io
    except PolicyDeny as exc:
        io = failure_result(exc, command)
        session.last_exit_code = io.exit_code
        return io
    except (MirageAbortError, ContentDriftError, PolicyError):
        # The caller's problem, not the line's: an abort it requested,
        # drift it must reconcile, a policy it misconfigured.
        raise
    except Exception as exc:
        io = failure_result(exc, command)
        return io
    finally:
        # One rule on every path: an op that happened is always
        # accounted, in byte accounting (which feeds snapshot
        # fingerprints/drift) and as observer op events. The command
        # event's exit_code says whether the line that emitted them
        # succeeded.
        scope.close()
        reset_current_session(session_token)
        await ws._session_mgr.flush()
        ws._ops.records.extend(scope.records)
        if is_line:
            await ws.observer.log_execution(command, io, scope.records,
                                            ws._current_agent_id or "",
                                            session_id,
                                            session_cwd(ws, session_id))
