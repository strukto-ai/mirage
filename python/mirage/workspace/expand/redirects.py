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

from mirage.shell.call_stack import CallStack
from mirage.shell.types import Redirect, RedirectKind
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.expand.node import expand_node
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session


async def expand_redirects(
    redirects: list[Redirect],
    session: Session,
    execute_fn: Callable,
    registry: MountRegistry,
    call_stack: CallStack | None = None,
) -> tuple[list[Redirect], Any]:
    """Expand redirect targets: heredoc vars, target words, pipelines.

    The single expansion path for redirected statements, shared by the
    executor (which then applies the redirects) and the provision
    planner (which only costs them). Heredoc/herestring bodies get
    session variables substituted; file targets are expanded and
    classified into PathSpec or plain text; the first attached
    pipeline is detached and returned separately.

    Args:
        redirects (list[Redirect]): parsed redirects from get_redirects.
        session (Session): shell session state.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry for classification.
        call_stack (CallStack | None): shell call stack for expansion.

    Returns:
        (expanded, pipe_node): expanded redirects and the detached
        pipeline node (or None).
    """
    expanded: list[Redirect] = []
    for r in redirects:
        if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
            body = r.target
            if isinstance(body, str) and r.expand_vars:
                for var, val in session.env.items():
                    body = body.replace("$" + var, val)
            expanded.append(
                Redirect(fd=r.fd,
                         target=body,
                         target_node=r.target_node,
                         kind=r.kind,
                         append=r.append,
                         pipeline=r.pipeline,
                         expand_vars=r.expand_vars))
            continue
        if isinstance(r.target, int):
            expanded.append(r)
            continue
        target_node = r.target_node
        if target_node is not None:
            target_str = await expand_node(target_node, session, execute_fn,
                                           call_stack)
            # A redirect target is a path by definition (the operator is
            # the context), so force classification like a PATH-kind word;
            # classify_word alone leaves extensionless relative targets as
            # text. Mirrors the TS classifyBarePath call.
            target_scope = classify_bare_path(target_str, registry,
                                              session.cwd)
        else:
            target_scope = r.target
        expanded.append(
            Redirect(fd=r.fd,
                     target=target_scope,
                     target_node=r.target_node,
                     kind=r.kind,
                     append=r.append,
                     pipeline=r.pipeline))
    pipe_node = None
    for r in expanded:
        if r.pipeline is not None:
            pipe_node = r.pipeline
            r.pipeline = None
            break
    return expanded, pipe_node
