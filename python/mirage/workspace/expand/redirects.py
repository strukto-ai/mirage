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

from mirage.context import voice_name
from mirage.policy.policies import Policies
from mirage.shell.bytes import encode_text, utf8_locale
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.parse import parse, syntax_refusal
from mirage.shell.types import Redirect, RedirectKind
from mirage.shell.voice import shell_voice
from mirage.view.types import NamespaceLinks
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.expand.node import expand_node
from mirage.workspace.expand.parts import expand_words
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import visible_env


async def expand_redirect(
    redirect: Redirect,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
    forked: bool = False,
    links: NamespaceLinks | None = None,
    words: list[str] | None = None,
) -> Redirect:
    """Expand one redirect immediately before the executor applies it.

    Args:
        redirect (Redirect): the next redirect in source order.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for classification.
        call_stack (CallStack | None): shell call stack for expansion.
        policies (Policies | None): the policies its writes clear.
        forked (bool): retain an expansion error for the child command.
        links (NamespaceLinks | None): namespace links for pathname expansion.
        words (list[str] | None): the target's words when another shell
            expanded them already (``$(< file)``), glob marks kept; None
            expands the target here.
    """
    try:
        return await _expand_target(
            redirect,
            context,
            execute_fn,
            registry,
            call_stack,
            policies,
            links,
            words,
        )
    except ExitSignal as exc:
        if not forked:
            raise
        return Redirect(
            fd=redirect.fd, target=exc, kind=RedirectKind.UNEXPANDED
        )


async def _expand_target(
    r: Redirect,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    call_stack: CallStack | None,
    policies: Policies | None,
    links: NamespaceLinks | None,
    words: list[str] | None = None,
) -> Redirect:
    """Expand one redirect's body or target.

    Args:
        r (Redirect): the parsed redirect.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry for classification.
        call_stack (CallStack | None): shell call stack for expansion.
        policies (Policies | None): the policies its writes clear.
        links (NamespaceLinks | None): namespace links for pathname expansion.
        words (list[str] | None): the target's words, expanded already;
            None expands them here.
    """
    session = context.session
    if r.kind == RedirectKind.HEREDOC and r.expand_vars and r.deferred:
        return Redirect(
            fd=r.fd,
            target=ExitSignal(
                1, stderr=_failed_body(r.target, *r.deferred, session)
            ),
            kind=RedirectKind.UNEXPANDED,
        )
    if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
        body = r.target
        if r.target_node is not None and r.expand_vars:
            body = await expand_node(
                r.target_node, context, execute_fn, call_stack, policies
            )
        return Redirect(
            fd=r.fd,
            target=body,
            target_node=r.target_node,
            kind=r.kind,
            append=r.append,
            clobber=r.clobber,
            expand_vars=r.expand_vars,
        )
    if isinstance(r.target, int):
        return r
    target_scope = r.target
    if r.target_node is not None:
        if words is None:
            words = await expand_words(
                [r.target_node], context, execute_fn, call_stack, policies
            )
        targets = await resolve_globs(
            [
                classify_bare_path(word, registry, session.cwd)
                for word in words
            ],
            registry,
            noglob=session.shell_options.get("noglob", False),
            links=links,
            options=glob_options(session),
        )
        if len(targets) != 1:
            return Redirect(
                fd=r.fd,
                target=r.target,
                target_node=r.target_node,
                kind=RedirectKind.AMBIGUOUS,
            )
        target_scope = targets[0]
    return Redirect(
        fd=r.fd,
        target=target_scope,
        target_node=r.target_node,
        kind=r.kind,
        append=r.append,
        clobber=r.clobber,
    )


def _failed_body(body: str, at: int, row: int, session: SessionState) -> bytes:
    """What bash reports as expanding a heredoc's body fails where what it
    reads only then opens: a ``$( )`` whose commands do not parse or that
    is left open, its lines counted from the body's, or a ``${`` (named by
    the whole body) or backtick left open.

    Args:
        body (str): the heredoc's body.
        at (int): where in it expanding fails.
        row (int): the row the body starts on in the line as typed.
        session (SessionState): the shell expanding it.
    """
    rest = body[at:]
    if rest.startswith("$("):
        text = rest[2:]
        head = f"{voice_name(session)}: command substitution: "
        utf8 = utf8_locale(visible_env(session))
        refused = syntax_refusal(parse(text), head, row + 1, utf8)
        if refused is not None:
            assert isinstance(refused.stderr, bytes)
            return refused.stderr
        line = row + 1 + text.count("\n") + (0 if text.endswith("\n") else 1)
        return encode_text(
            f"{head}line {line}: unexpected EOF while looking for matching `)'\n"
        )
    if rest.startswith("${"):
        return encode_text(f"{shell_voice()}{body}: bad substitution\n")
    return encode_text(
        f'{shell_voice()}bad substitution: no closing "`" in {rest}\n'
    )
