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

import re
from functools import partial
from typing import Any, Callable

import tree_sitter

from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import (ProcessSubDirection, get_process_sub_body,
                                  get_process_sub_direction, get_text)
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.expand.node import expand_node, unescape_heredoc
from mirage.workspace.expand.variable import _lookup_var
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session

# tree-sitter-bash misses bare `$_name` refs preceded by a non-space
# character inside heredoc bodies (they stay literal text instead of
# becoming simple_expansion nodes); this catches them in literal pieces.
_VAR_REF = re.compile(r"(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)")


def _lookup_match(match: re.Match[str], session: Session,
                  call_stack: CallStack | None) -> str:
    return _lookup_var(match.group(1), session, call_stack)


def _finish_heredoc_literal(text: str, session: Session,
                            call_stack: CallStack | None) -> str:
    """Expand quirk-missed `$name` refs, then apply heredoc escapes."""
    if "$" in text:
        masked = text.replace("\\\\", "\x00")
        masked = _VAR_REF.sub(
            partial(_lookup_match, session=session, call_stack=call_stack),
            masked)
        text = masked.replace("\x00", "\\\\")
    return unescape_heredoc(text)


def _strip_heredoc_tabs(text: str, at_line_start: bool) -> str:
    """Strip leading tabs at each physical line start (`<<-`)."""
    lines = text.split("\n")
    out = []
    for i, line in enumerate(lines):
        if i == 0 and not at_line_start:
            out.append(line)
        else:
            out.append(line.lstrip("\t"))
    return "\n".join(out)


async def expand_heredoc_body(
    redirect_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> str:
    """Structurally expand an unquoted heredoc body.

    tree-sitter parses expansions inside heredoc_body as named children;
    the literal text between them (including the leading chunk, which is
    NOT a named child) is gap-filled from byte spans. Literal pieces get
    heredoc backslash escapes and `<<-` tab stripping; expansion nodes
    route through expand_node.
    """
    body_node = None
    dash = False
    for c in redirect_node.children:
        if c.type == "<<-":
            dash = True
        elif c.type == NT.HEREDOC_BODY:
            body_node = c
    if body_node is None:
        return ""
    raw = body_node.text or b""
    base = body_node.start_byte
    parts: list[str] = []
    pos = 0
    at_line_start = True
    for child in body_node.named_children:
        pieces = [(raw[pos:child.start_byte - base].decode(), True)]
        if child.type == NT.HEREDOC_CONTENT:
            pieces.append((get_text(child), True))
        else:
            pieces.append((await expand_node(child, session, execute_fn,
                                             call_stack), False))
        for text, literal in pieces:
            if not text:
                continue
            if literal:
                if dash:
                    text_out = _strip_heredoc_tabs(text, at_line_start)
                else:
                    text_out = text
                parts.append(
                    _finish_heredoc_literal(text_out, session, call_stack))
                at_line_start = text.endswith("\n")
            else:
                parts.append(text)
                at_line_start = False
        pos = child.end_byte - base
    tail = raw[pos:].decode()
    if tail:
        if dash:
            tail = _strip_heredoc_tabs(tail, at_line_start)
        parts.append(_finish_heredoc_literal(tail, session, call_stack))
    body = "".join(parts)
    if body and not body.endswith("\n"):
        # bash heredoc bodies always end with a newline (see
        # get_heredoc_meta for the tree-sitter edge this papers over).
        body += "\n"
    return body


async def expand_redirects(
    redirects: list[Redirect],
    session: Session,
    execute_fn: Callable[..., Any],
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
            if (r.kind == RedirectKind.HEREDOC and r.expand_vars
                    and r.target_node is not None
                    and r.target_node.type == NT.HEREDOC_REDIRECT):
                body = await expand_heredoc_body(r.target_node, session,
                                                 execute_fn, call_stack)
            elif (r.kind == RedirectKind.HERESTRING
                  and r.target_node is not None):
                body = await expand_node(r.target_node, session, execute_fn,
                                         call_stack)
            elif isinstance(body, str) and r.expand_vars:
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
        if (r.target_node is not None
                and r.target_node.type == NT.PROCESS_SUBSTITUTION):
            if (r.kind == RedirectKind.STDIN and get_process_sub_direction(
                    r.target_node) == ProcessSubDirection.INPUT):
                # `cmd < <(inner)` — run the inner command and feed its
                # stdout as stdin, reusing the heredoc delivery path.
                inner = get_process_sub_body(r.target_node)
                inner_data = b""
                if inner:
                    io_ps = await execute_fn(inner,
                                             session_id=session.session_id)
                    inner_data = io_ps.stdout or b""
                expanded.append(
                    Redirect(fd=0,
                             target=inner_data,
                             kind=RedirectKind.HEREDOC,
                             expand_vars=False))
                continue
            # `> >(cmd)` and friends would otherwise classify the
            # procsub text as a literal filename and write silently
            # wrong state; fail loudly like the argv-position check.
            raise ExitSignal(
                2,
                stderr=b"mirage: unsupported: process substitution "
                b">(...)\n",
                contained_code=2)
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
