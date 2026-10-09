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

from typing import Any, Callable

from mirage.io.types import materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import (
    get_process_sub_body,
    get_process_sub_direction,
)
from mirage.shell.types import NodeType as NT
from mirage.shell.types import ProcessSubDirection, Redirect, RedirectKind
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.expand.node import child_line, expand_node
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import visible_env


async def expand_redirects(
    redirects: list[Redirect],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
    forked: bool = False,
) -> tuple[list[Redirect], Any]:
    """Expand redirect targets: heredoc vars, target words, pipelines.

    The single expansion path for redirected statements, which the
    executor then applies. Heredoc/herestring bodies get session
    variables substituted; file targets are expanded and classified
    into PathSpec or plain text; the first attached pipeline is
    detached and returned separately.

    Args:
        redirects (list[Redirect]): parsed redirects from get_redirects.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry for classification.
        call_stack (CallStack | None): shell call stack for expansion.
        view (SessionView | None): the gated session view.
        forked (bool): the redirects belong to a program bash forks
            for, which expands them in the child: an error there is
            kept for the command to fail on (``UNEXPANDED``) rather
            than raised into the shell, which discards the line.

    Returns:
        (expanded, pipe_node): expanded redirects and the detached
        pipeline node (or None).
    """
    expanded: list[Redirect] = []
    for index, r in enumerate(redirects):
        try:
            expanded.append(
                await _expand_redirect(
                    r, context, execute_fn, registry, call_stack, view
                )
            )
        except ExitSignal as exc:
            if not forked:
                raise
            # The child performs no redirect after the first that fails;
            # a pipeline the line attached to one of them still runs.
            expanded.append(
                Redirect(
                    fd=r.fd,
                    target=exc,
                    kind=RedirectKind.UNEXPANDED,
                    pipeline=next(
                        (
                            later.pipeline
                            for later in redirects[index:]
                            if later.pipeline is not None
                        ),
                        None,
                    ),
                )
            )
            break
    pipe_node = None
    for r in expanded:
        if r.pipeline is not None:
            pipe_node = r.pipeline
            r.pipeline = None
            break
    return expanded, pipe_node


async def _expand_redirect(
    r: Redirect,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    call_stack: CallStack | None,
    view: SessionView | None,
) -> Redirect:
    """Expand one redirect's body or target.

    Args:
        r (Redirect): the parsed redirect.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry for classification.
        call_stack (CallStack | None): shell call stack for expansion.
        view (SessionView | None): the gated session view.
    """
    session = context.session
    if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
        body = r.target
        if r.target_node is not None and r.expand_vars:
            body = await expand_node(
                r.target_node, context, execute_fn, call_stack, view=view
            )
        elif isinstance(body, str) and r.expand_vars:
            for var, val in visible_env(session).items():
                body = body.replace("$" + var, val)
        return Redirect(
            fd=r.fd,
            target=body,
            target_node=r.target_node,
            kind=r.kind,
            append=r.append,
            clobber=r.clobber,
            pipeline=r.pipeline,
            expand_vars=r.expand_vars,
            continuation=r.continuation,
        )
    if isinstance(r.target, int):
        return r
    if (
        r.target_node is not None
        and r.target_node.type == NT.PROCESS_SUBSTITUTION
    ):
        if (
            r.kind == RedirectKind.STDIN
            and get_process_sub_direction(r.target_node)
            == ProcessSubDirection.INPUT
        ):
            # `cmd < <(inner)` — run the inner command and feed its
            # stdout as stdin, reusing the heredoc delivery path.
            inner = get_process_sub_body(r.target_node)
            inner_data = b""
            if inner:
                io_ps = await child_line(
                    context, execute_fn, inner, r.target_node, call_stack
                )
                inner_data = await materialize(io_ps.stdout)
                context.frame.diagnostics.append(
                    await io_ps.materialize_stderr()
                )
            return Redirect(
                fd=r.fd,
                target=inner_data,
                kind=RedirectKind.HEREDOC,
                expand_vars=False,
            )
        # `> >(cmd)` and friends would otherwise classify the
        # procsub text as a literal filename and write silently
        # wrong state; fail loudly like the argv-position check.
        raise ExitSignal(
            2,
            stderr=b"mirage: unsupported: process substitution >(...)\n",
            contained_code=2,
        )
    target_scope = r.target
    if r.target_node is not None:
        target_str = await expand_node(
            r.target_node, context, execute_fn, call_stack, view=view
        )
        # A redirect target is a path by definition (the operator is
        # the context), so force classification like a PATH-kind word;
        # classify_word alone leaves extensionless relative targets as
        # text. Mirrors the TS classifyBarePath call.
        target_scope = classify_bare_path(target_str, registry, session.cwd)
    return Redirect(
        fd=r.fd,
        target=target_scope,
        target_node=r.target_node,
        kind=r.kind,
        append=r.append,
        clobber=r.clobber,
        pipeline=r.pipeline,
    )
