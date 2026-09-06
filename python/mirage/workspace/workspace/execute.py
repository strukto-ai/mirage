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
from collections.abc import Sequence
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING, Any

import tree_sitter

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.errors import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.context import RecordingScope
from mirage.policy import resolve_limit
from mirage.provision import ProvisionResult
from mirage.runtime.routing import RouteDecision, RouteDeny, RouteError
from mirage.shell.parse import (find_syntax_error, find_unterminated_backtick,
                                parse, syntax_error_result)
from mirage.types import Refusal
from mirage.workspace.abort import MirageAbortError, run_cancellable
from mirage.workspace.node import provision_node, run_command_tree
from mirage.workspace.node.admission import admit_line
from mirage.workspace.node.explain import prejudge_line, unrefused_nodes
from mirage.workspace.session import (get_current_session_for,
                                      reset_current_session,
                                      set_current_session)
from mirage.workspace.snapshot import ContentDriftError
from mirage.workspace.workspace.failure import failure_result
from mirage.workspace.workspace.fill import (cli_env_names, fill_env,
                                             fill_names, guest_bound,
                                             line_nodes)
from mirage.workspace.workspace.line import run_whole_line
from mirage.workspace.workspace.utils import command_name, fork_for_call

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace

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


@dataclass(slots=True)
class NestedRefusal:
    """The record the line's nested evaluations earned, latest kept.

    Every nested line re-enters execute through ``recurse``, and a
    substitution keeps only the inner stdout, so that door is the one
    place its record survives. The typed line reports it when its own
    tree earned none: the rightmost rule ``IOResult.merge`` applies,
    with the inner line standing left of the command that consumed
    its output.

    Args:
        latest (Refusal | None): the last record a nested line carried.
    """

    latest: Refusal | None = None


async def recurse(
    ws: "Workspace",
    cancel: asyncio.Event | None,
    routing_decision: RouteDecision | None,
    agent_id: str | None,
    nested: NestedRefusal,
    cmd: str,
    **opts: Any,
) -> Any:
    """The executor's internal eval ($(), source, eval, xargs, ...).

    Never a typed line, so it must not record a history entry or open
    its own recording context (GNU: history is appended by the line
    reader, the evaluator can't touch it). It inherits the typed
    line's routing decision and agent: nested lines never re-route,
    and an approval they raise is the outer line's agent's.

    Args:
        ws: the workspace hosting the outer line.
        cancel (asyncio.Event | None): the outer line's abort event.
        routing_decision (RouteDecision | None): the typed line's
            decision, inherited verbatim.
        agent_id (str | None): the typed line's agent, inherited.
        nested (NestedRefusal): where the record a nested line earned
            is kept for the typed line.
        cmd (str): the nested command line.
    """
    io = await ws.execute(cmd,
                          cancel=cancel,
                          record=False,
                          routing_decision=routing_decision,
                          agent_id=agent_id,
                          **opts)
    if isinstance(io, IOResult) and io.refusal is not None:
        nested.latest = io.refusal
    return io


def session_cwd(
    ws: "Workspace",
    session_id: str,
) -> str | None:
    """The session's cwd for history, None once the session is gone.

    Args:
        ws: the workspace owning the session manager.
        session_id (str): session whose cwd the history entry records.
    """
    try:
        return ws._session_mgr.get(session_id).cwd
    except KeyError:
        return None


async def execute_line(
    ws: "Workspace",
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
    routing_decision: RouteDecision | None,
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
    cacheable = ws._dispatcher.capture_cacheable_paths()
    await ws._namespace.ensure_loaded()
    await ws._meta.ensure()
    await ws._session_mgr.ensure_loaded()
    if ws._drift.pending:
        await ws._drift.drain(ws._registry.try_mount_for)

    # A re-entrant execute (the evaluator's $(), eval, source, xargs, or
    # an embedder callback fired mid-line) continues in the live ambient
    # session unless it names a different one. An id cannot say that: it
    # names a registered session, never the ephemeral per-call fork the
    # outer line actually runs in, and re-resolving through the manager
    # is how a nested line used to escape the fork and its confinement.
    # Only this workspace's own binding counts: a session carries one
    # workspace's cwd, env and mount grants, so a callback reaching a
    # second workspace must resolve that workspace's session instead.
    ambient = get_current_session_for(ws._session_mgr)
    if ambient is not None and session_id in (None, ambient.session_id):
        session = ambient
        session_id = ambient.session_id
    else:
        if session_id is None:
            session_id = ws._session_mgr.default_id
        session = ws._session_mgr.get(session_id)
    effective_session = fork_for_call(session, cwd, env)
    # The agent of this line, carried with the execution rather than
    # held on the workspace: a nested line inherits it through
    # `recurse`, a concurrent line keeps its own.
    agent = agent_id if agent_id is not None else ws._default_agent_id
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

    session_token = set_current_session(effective_session,
                                        owner=ws._session_mgr)
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
        decision = await ws._router.decide(ast, command, runtime, provision,
                                           effective_session, session_id, agent
                                           or "", ws._route_policy,
                                           routing_decision)
        nested = NestedRefusal()
        exec_recursion = partial(recurse, ws, cancel, decision, agent, nested)
        if provision:
            name = command_name(command)
            guard = resolve_limit(name) if name else None
            timeout = guard.timeout_seconds if guard is not None else None
            return await run_with_timeout(
                provision_node(ws._registry,
                               ws.dispatch,
                               plan_eval_stub,
                               ws._namespace,
                               ast,
                               effective_session,
                               agent_id=agent or ""), timeout, name)
        line_runtime = ws._runtimes.whole_line(ast, decision)
        if line_runtime is not None:
            # A whole line is a command like any other: the same
            # visibility and admission gate as the tree, per parsed
            # command, before the runtime sees a byte of it.
            refused = await admit_line(ast, effective_session, ws._registry,
                                       ws._namespace, agent or "", cancel)
            if refused is not None:
                io = IOResult(exit_code=refused.exit_code,
                              stderr=refused.stderr,
                              refusal=refused.refusal)
                session.last_exit_code = io.exit_code
                return io
            if ws._has_managed_env:
                # Filled only after the line is admitted (a refused
                # line must never reach a secret store) and before the
                # runtime snapshots the env; a whole-line program may
                # read any name, so the walk is not consulted. A dry
                # run (provision) returned above and never fetches. A
                # SecretsError raises through to the generic fold
                # below: the line exits 1 and never runs.
                whole_names = fill_names(effective_session, [ast],
                                         whole=True,
                                         cli_env_names=frozenset())
                # Names first, and the declarations only if there are
                # any: both arguments would otherwise be evaluated, so
                # a session with nothing pending (a profile hiding
                # every managed name) still read a bootstrap source.
                # The TypeScript twin shares one helper with the
                # per-command path and skipped this by construction.
                if whole_names:
                    await fill_env(effective_session, whole_names, await
                                   ws._secret_sources())
            io = await run_whole_line(
                line_runtime, command, stdin, effective_session,
                ws._registry.mounts(), ws._registry.policies,
                ws._dispatcher.invalidate_all_after_remote)
            session.last_exit_code = io.exit_code
            return io
        # The line is the unit a rule judges, so every command in it is
        # judged before any of it runs. Nothing here replaces the
        # per-command gate below, which still binds each command's own
        # entry gate; this only stops a line a rule refuses from
        # running half-way.
        refused = await prejudge_line(ast, effective_session, ws._registry,
                                      ws._namespace, agent or "", cancel)
        if refused is not None:
            io = IOResult(exit_code=refused.exit_code,
                          stderr=refused.stderr,
                          refusal=refused.refusal)
            session.last_exit_code = io.exit_code
            return io
        if ws._has_managed_env:
            # Filled only after the line-tier admission and before the
            # tree's expansion reads the vars. The walked set carries
            # stored function bodies too, so a function invoked by bare
            # name still fills what its body reads. The prejudge pass
            # leaves single-command lines to the per-command gate, so
            # the fetch asks the same text-tier question itself, over
            # the same walked set the names came from: a node already
            # denied on its literal words never reaches a source, and a
            # rule that asks is answered before the fetch, with the
            # approval left for the gate to spend. A deny only the
            # value gate can see still follows the fetch, because
            # expansion is what consumes the values.
            nodes = line_nodes(ast, effective_session)
            policies = ws._registry.policies
            writes_gated = (policies is not None and await policies.wants_for(
                "pre_session", effective_session.session_id))

            def plan_names(
                    subset: Sequence[tree_sitter.Node]) -> frozenset[str]:
                return fill_names(
                    effective_session,
                    subset,
                    whole=guest_bound(subset, decision,
                                      ws._registry.runtime_bindings),
                    cli_env_names=cli_env_names(subset, effective_session,
                                                ws._registry),
                    writes_gated=writes_gated)

            names = plan_names(nodes)
            if names:
                served = await unrefused_nodes(nodes, effective_session,
                                               ws._registry, ws._namespace,
                                               agent or "", cancel)
                if len(served) != len(nodes):
                    nodes = served
                    names = plan_names(served) if served else frozenset()
                # A fetched value can name another managed variable
                # (the arithmetic chase recurses through values), and
                # what a value spells is unknowable before its fetch,
                # so the plan reruns over the same admitted nodes until
                # it reaches nothing new. fill_names returns pending
                # names only, so every pass fetches names the last one
                # could not see and the loop settles.
                while names:
                    # Built here, not above the plan: the declarations
                    # are read only once an admitted node actually
                    # wants a value, so a line the per-command gate
                    # refuses never reaches a bootstrap source either.
                    # An unknown source name already fails at
                    # construction; what is left for this to discover
                    # is an unreadable dotenv or a config the source
                    # refuses, which is the same treatment an
                    # unreachable store gets. Memoized, so the loop's
                    # later passes cost one await.
                    sources = await ws._secret_sources()
                    await fill_env(effective_session, names, sources)
                    names = plan_names(nodes)
        io, _ = await run_cancellable(
            run_command_tree(
                ws.dispatch,
                ws._registry,
                ws._namespace,
                ws.job_table,
                exec_recursion,
                agent or "",
                ast,
                effective_session,
                stdin,
                cancel,
                routing_decision=decision,
            ), cancel)
        # A record a nested line earned is the line's to report when
        # its own tree earned none (see NestedRefusal).
        if io.refusal is None:
            io.refusal = nested.latest
        session.last_exit_code = io.exit_code
        await ws.apply_io(io, records=scope.records, is_cacheable=cacheable)
        return io
    except CommandTimeoutError as exc:
        logger.debug("command %r timed out after %ss", exc.command,
                     exc.seconds)
        if cancel is not None:
            cancel.set()
        io = failure_result(exc, command)
        session.last_exit_code = io.exit_code
        return io
    except RouteDeny as exc:
        io = failure_result(exc, command)
        session.last_exit_code = io.exit_code
        return io
    except (MirageAbortError, ContentDriftError, RouteError):
        # The caller's problem, not the line's: an abort it requested,
        # drift it must reconcile, a policy it misconfigured.
        raise
    except Exception as exc:
        # The fold is a failed command like any other (a SecretsError
        # folds here), so $? must report it, mirroring the TS catch.
        io = failure_result(exc, command)
        session.last_exit_code = io.exit_code
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
            await ws.observer.log_execution(command, io, scope.records, agent
                                            or "", session_id,
                                            session_cwd(ws, session_id))
