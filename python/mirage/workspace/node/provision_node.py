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

from dataclasses import dataclass, field
from functools import partial
from typing import Any, Callable

from mirage.provision import Precision, ProvisionResult
from mirage.shell.node_kind import NodeKind, node_kind
from mirage.shell.types import FunctionBody
from mirage.shell.types import NodeType as NT
from mirage.shell.types import RedirectKind
from mirage.shell.types import ShellBuiltin as SB
from mirage.types import PathSpec
from mirage.workspace.expand import (classify_parts, expand_and_classify,
                                     expand_parts, expand_redirects)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.provision.builtins import handle_builtin_provision
from mirage.workspace.provision.command import handle_command_provision
from mirage.workspace.provision.control import (handle_for_provision,
                                                handle_function_provision,
                                                handle_if_provision,
                                                handle_while_provision)
from mirage.workspace.provision.pipes import (handle_connection_provision,
                                              handle_pipe_provision)
from mirage.workspace.provision.redirect import handle_redirect_provision
from mirage.workspace.provision.rollup import rollup_list, rollup_pipe
from mirage.workspace.session import Session

from mirage.shell.helpers import (  # isort: skip
    get_case_items, get_command_name, get_for_parts, get_function_body,
    get_function_name, get_if_branches, get_list_parts, get_negated_command,
    get_parts, get_pipeline_commands, get_redirects, get_subshell_body,
    get_text, get_while_parts, has_command_substitution, split_env_prefix)

# eval / source execute their payload, so they are NOT free builtins:
# leaving them out lets them fall through to command resolution, which
# honestly reports UNKNOWN instead of a zero-cost EXACT.
_BUILTIN_NAMES = frozenset({
    SB.CD,
    SB.TRUE,
    SB.FALSE,
    SB.EXPORT,
    SB.UNSET,
    SB.LOCAL,
    SB.PRINTENV,
    SB.READ,
    SB.SET,
    SB.SHIFT,
    SB.TRAP,
    SB.TEST,
    SB.BRACKET,
    SB.DOUBLE_BRACKET,
    SB.WAIT,
    SB.FG,
    SB.KILL,
    SB.JOBS,
    SB.PS,
    SB.ECHO,
    SB.PRINTF,
    SB.SLEEP,
    "return",
    "break",
    "continue",
})


@dataclass
class PlanScope:
    """Walk-local planner state.

    Function definitions seen during this plan are recorded here (not
    on the session: planning must not mutate shell state), and
    `planning` guards recursive functions from looping the planner.
    """
    functions: dict[str, FunctionBody] = field(default_factory=dict)
    planning: set[str] = field(default_factory=set)


async def _provision_redirected(
    recurse: Callable,
    registry: MountRegistry,
    namespace: Namespace | None,
    execute_fn: Callable,
    command: Any,
    redirects: list,
    session: Session,
) -> ProvisionResult:
    """Plan one redirected command: expand targets, cost, degrade.

    Args:
        recurse (Callable): the provision recursion.
        registry (MountRegistry): mount registry.
        namespace (Namespace | None): addressing authority.
        execute_fn (Callable): recursive execute (for expansions).
        command (Any): the redirected command node.
        redirects (list): parsed redirects.
        session (Session): shell session state.
    """
    expanded, pipe_node = await expand_redirects(redirects, session,
                                                 execute_fn, registry)
    # A cmdsub target expands empty under provision, so its
    # classification is garbage; the precision degrade below keeps
    # the plan honest without costing a phantom write (mirrors TS).
    targets: list[tuple[RedirectKind, PathSpec]] = [
        (r.kind, r.target) for r in expanded
        if r.kind in (RedirectKind.STDIN, RedirectKind.STDOUT) and isinstance(
            r.target, PathSpec) and not r.target.virtual.startswith("/dev/")
        and not (r.target_node is not None
                 and has_command_substitution(r.target_node))
    ]
    result = await handle_redirect_provision(recurse, registry, command,
                                             targets, session, namespace)
    if any(r.target_node is not None
           and has_command_substitution(r.target_node) for r in redirects):
        # A suppressed substitution hid the real redirect target.
        result.precision = Precision.UNKNOWN
    if pipe_node is not None:
        return rollup_pipe([result, await recurse(pipe_node, session)])
    return result


async def _provision_reassociated(
    recurse: Callable,
    registry: MountRegistry,
    namespace: Namespace | None,
    execute_fn: Callable,
    redirects: list,
    right: Any,
    node: Any,
    session: Session,
) -> ProvisionResult:
    """Provision recurse wrapper for a re-associated trailing redirect.

    Mirrors the executor: the list's last command carries the hoisted
    redirects; every other node provisions normally.

    Args:
        recurse (Callable): the provision recursion.
        registry (MountRegistry): mount registry.
        namespace (Namespace | None): addressing authority.
        execute_fn (Callable): recursive execute (for expansions).
        redirects (list): parsed redirects hoisted off the list.
        right (Any): the list's last command node.
        node (Any): node being provisioned by the connection handler.
        session (Session): shell session state.
    """
    if node is not right:
        return await recurse(node, session)
    return await _provision_redirected(recurse, registry, namespace,
                                       execute_fn, right, redirects, session)


async def provision_node(
    registry: MountRegistry,
    dispatch: Callable,
    execute_fn: Callable,
    namespace: Namespace | None,
    node: Any,
    session: Session,
    scope: PlanScope | None = None,
) -> ProvisionResult:
    """Walk tree-sitter AST and estimate execution cost.

    Dispatches on the same NodeKind classification as the executor
    (`mirage.shell.classify`), so every construct the executor runs
    has a planner branch; kinds neither walker supports fall through
    to an honest UNKNOWN.

    Args:
        registry (MountRegistry): mount registry for path resolution.
        dispatch (Callable): VFS op dispatcher (op, path, **kw).
        execute_fn (Callable): recursive execute (for expansions).
        node (Any): tree-sitter node to plan.
        session (Session): shell session state.
        scope (PlanScope | None): walk-local planner state; created at
            the root and threaded through recursion.
    """
    plan_scope = scope if scope is not None else PlanScope()
    recurse = partial(provision_node,
                      registry,
                      dispatch,
                      execute_fn,
                      namespace,
                      scope=plan_scope)
    kind = node_kind(node)

    if kind == NodeKind.COMMENT:
        return ProvisionResult(precision=Precision.EXACT)

    if kind in (NodeKind.PROGRAM, NodeKind.SUBSHELL, NodeKind.COMPOUND):
        if kind == NodeKind.SUBSHELL:
            body = get_subshell_body(node)
        else:
            body = [c for c in node.named_children if c.type != NT.COMMENT]
        children = []
        for child in body:
            children.append(await recurse(child, session))
        if not children:
            return ProvisionResult(precision=Precision.EXACT)
        return rollup_list(";", children)

    if kind == NodeKind.COMMAND:
        name = get_command_name(node)
        func_body = plan_scope.functions.get(name)
        if func_body is None:
            func_body = session.functions.get(name)
        if func_body is not None:
            return await handle_function_provision(recurse, name, func_body,
                                                   plan_scope.planning,
                                                   session)
        if name in _BUILTIN_NAMES:
            return await handle_builtin_provision()
        _, parts = split_env_prefix(get_parts(node))
        if not parts:
            return ProvisionResult(precision=Precision.EXACT)
        expanded = await expand_parts(parts, session, execute_fn)
        classified = classify_parts(expanded, registry, session.cwd)
        result = await handle_command_provision(registry, classified, session,
                                                namespace)
        if any(has_command_substitution(p) for p in parts):
            # The plan walk suppressed the substitution, so the operand
            # list is incomplete: the totals are floors, not answers.
            result.precision = Precision.UNKNOWN
        return result

    if kind == NodeKind.PIPELINE:
        commands, _ = get_pipeline_commands(node)
        return await handle_pipe_provision(recurse, commands, session)

    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection_provision(recurse, left, op, right,
                                                 session)

    if kind == NodeKind.REDIRECT:
        command, redirects = get_redirects(node)
        if command.type == NT.LIST:
            # Mirror the executor: a trailing redirect hoisted over an
            # &&/|| list binds to the last command.
            left, op, right = get_list_parts(command)
            wrapped = partial(_provision_reassociated, recurse, registry,
                              namespace, execute_fn, redirects, right)
            return await handle_connection_provision(wrapped, left, op, right,
                                                     session)
        return await _provision_redirected(recurse, registry, namespace,
                                           execute_fn, command, redirects,
                                           session)

    if kind == NodeKind.IF:
        branches, else_body = get_if_branches(node)
        return await handle_if_provision(recurse, branches, else_body, session)

    if kind == NodeKind.FOR:
        _, values, body = get_for_parts(node)
        if any(has_command_substitution(v) for v in values):
            # The iteration count comes from a suppressed substitution:
            # plan one pass as a floor and degrade.
            result = await handle_for_provision(recurse, body, 1, session)
            result.precision = Precision.UNKNOWN
            return result
        classified = await expand_and_classify(values, session, execute_fn,
                                               registry, session.cwd)
        n = len(classified) or 1
        return await handle_for_provision(recurse, body, n, session)

    if kind == NodeKind.SELECT:
        # select re-prompts until break: unbounded like while.
        _, _, body = get_for_parts(node)
        return await handle_while_provision(recurse, body, session)

    if kind in (NodeKind.WHILE, NodeKind.UNTIL):
        _, body = get_while_parts(node)
        return await handle_while_provision(recurse, body, session)

    if kind == NodeKind.CASE:
        items = get_case_items(node)
        children = []
        for _, body in items:
            if not body:
                continue
            stmts = [await recurse(stmt, session) for stmt in body]
            children.append(stmts[0] if len(stmts) ==
                            1 else rollup_list(";", stmts))
        if children:
            return rollup_list("||", children)
        return ProvisionResult(precision=Precision.EXACT)

    if kind == NodeKind.FUNCTION_DEF:
        name = get_function_name(node)
        fn_body = get_function_body(node)
        if name:
            plan_scope.functions[name] = fn_body
        return await handle_builtin_provision()

    if kind in (NodeKind.DECLARATION, NodeKind.UNSET, NodeKind.TEST,
                NodeKind.VAR_ASSIGN):
        return await handle_builtin_provision()

    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        return await recurse(inner, session)

    return ProvisionResult(command=get_text(node), precision=Precision.UNKNOWN)
