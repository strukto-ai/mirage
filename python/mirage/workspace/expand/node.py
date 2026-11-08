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

from functools import partial
from typing import Any

from mirage._rs import Shell, ShellNode
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.policy.policies import Policies
from mirage.rs.session import ShellVars
from mirage.shell.bytes import decode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.shell.literal import LiteralNode
from mirage.shell.parse import parse
from mirage.shell.parse.program import ProgramNode, shell_node
from mirage.shell.types import TSNodeLike
from mirage.utils.glob_walk import mark_globs
from mirage.workspace.evaluation import EvaluationContext, child_context
from mirage.workspace.executor.statement import record_status
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.session.state import frame
from mirage.workspace.session.task import SessionGate, drive, listens


async def child_line(
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    text: str,
    node: TSNodeLike,
    call_stack: CallStack | None,
    span: tuple[int, int] | None = None,
    *,
    records: ShellVars | None = None,
    read: list[str] | None = None,
    stdin: ByteSource | None = None,
    sink: JobConsole | None = None,
) -> IOResult:
    """Run a substitution's line in a child shell.

    The line reaches the executor unwrapped, under the node that named
    it, so the pass places its commands where they were typed rather
    than under a subshell of their own. The child runs on a copy of the
    caller's frames: inside a function it reads the function's ``$1``,
    ``return`` ends it, and so does a ``break`` from a loop the caller is
    in.

    Args:
        context (EvaluationContext): the parent shell's session.
        execute_fn (Callable[..., Any]): the workspace's nested-line
            executor.
        text (str): the line the substitution holds.
        node (Any): the parsed node the substitution stands under.
        call_stack (CallStack | None): the caller's frames.
        span (tuple[int, int] | None): the pair's byte span within the
            node, for a backtick region holding several.
        records (ShellVars | None): the child shell's variables, the
            copy the expansion made where the substitution stood.
        read (list[str] | None): for ``$(< file)``, the words the
            expanding shell expanded the file's name to, which the read
            uses instead of expanding the line's own a second time.
        stdin (ByteSource | None): the line's stdin, a process
            substitution's pipe for ``>(...)``.
        sink (JobConsole | None): where the line writes as it runs.
    """
    session = context.session
    return await execute_fn(
        text,
        session_id=session.session_id,
        context=context,
        node=node,
        span=span,
        substitution=True,
        records=records,
        read=read,
        stdin=stdin,
        sink=sink,
        call_stack=(call_stack or CallStack()).fork(paren=False),
    )


class ExpandHost:
    """What a word's expansion asks of the shell running it: a command
    substitution's line, a process substitution's pipe, and the session
    policies on the writes it makes.

    Args:
        context (EvaluationContext): the evaluation the word is in.
        execute_fn (ExecuteFn): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
        word (TSNodeLike): the word, whose program the nodes it names
            belong to.
    """

    def __init__(
        self,
        context: EvaluationContext,
        execute_fn: ExecuteFn,
        call_stack: CallStack | None,
        policies: Policies | None,
        word: TSNodeLike,
    ) -> None:
        self.context = context
        self.session = context.session
        self.execute_fn = execute_fn
        self.call_stack = call_stack
        self.gates = SessionGate(context.session, policies)
        self.program = word.program if isinstance(word, ProgramNode) else None

    def _node(self, node: ShellNode) -> TSNodeLike:
        if self.program is None:
            return node
        return ProgramNode(node, self.program)

    async def substitute(
        self,
        shell: Shell,
        body: str,
        node: ShellNode,
        span: tuple[int, int] | None,
        read: list[str] | None,
    ) -> tuple[bytes, bytes, int]:
        context = self.context
        io = await child_line(
            context,
            self.execute_fn,
            body,
            self._node(node),
            self.call_stack,
            span,
            records=ShellVars(shell),
            read=read,
        )
        stdout = await io.materialize_stdout()
        stderr = await io.materialize_stderr()
        # An assignment-only statement whose value ran substitutions
        # reports the last one's status as its own, and `$?` reads it in
        # the words that follow (`false; echo $(true) $?` prints 0).
        context.frame.cmdsub_seq += 1
        context.frame.cmdsub_status = io.exit_code
        record_status(context.session, io.exit_code, transparent=True)
        return stdout, stderr, io.exit_code

    async def process(self, shell: Shell, node: ShellNode) -> str:
        context = self.context
        named = self._node(node)
        if context.frame.process_sub is None:
            return decode_text(named.text or b"")
        # The child shell is taken where the word expands, its function's
        # locals included, so the substitution sees the shell as it stood
        # then while the command naming it goes on.
        child = child_context(context, ShellVars(shell))
        return await context.frame.process_sub(
            named,
            partial(
                child_line,
                child,
                self.execute_fn,
                node=named,
                call_stack=self.call_stack,
            ),
        )

    async def gate(
        self,
        post: bool,
        verb: str,
        key: str,
        value: str | None,
        old: str | None,
    ) -> None:
        await self.gates.gate(post, verb, key, value, old)

    async def listens(self) -> bool:
        return await self.gates.listens()


def _literal(node: LiteralNode) -> str:
    while node.type != "raw_string" and node.children:
        node = node.children[0]  # type: ignore[assignment]
    text = decode_text(node.text)
    return text[1:-1] if node.type == "raw_string" else text


async def expand(
    word: TSNodeLike,
    mode: str,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> Any:
    """Expand one word on the session's shell, as ``mode`` reads it:
    ``fields`` (argument words, each glob-ready with quoting as marks),
    ``text`` (nothing splits), ``assignment``, ``pattern`` (runs, each
    quoted or live), ``regex`` or ``arith`` (the expression text).

    Args:
        word (TSNodeLike): the word's node.
        mode (str): how the word is read.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
    """
    node = shell_node(word)
    if node is None:
        text = _literal(word)  # type: ignore[arg-type]
        if mode == "fields":
            return [mark_globs(text)]
        return [(text, True)] if mode == "pattern" else text
    session = context.session
    heard = await listens(policies, session.session_id)
    frame(session, call_stack)
    task = session.vars.shell.expand(node, mode, heard)
    host = ExpandHost(context, execute_fn, call_stack, policies, word)
    return await drive(task, host, context.frame.diagnostics)


async def expand_node(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> str:
    """Expand a parsed node to the string it stands for, where nothing
    splits: a splat reads as its elements joined (``$@`` on a space,
    ``$*`` on IFS's first character).

    Args:
        ts_node (TSNodeLike): the node to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
    """
    return str(
        await expand(
            ts_node, "text", context, execute_fn, call_stack, policies
        )
    )


async def expand_assignment(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> str:
    """An assignment's value, where nothing splits and a tilde prefix
    expands at its start and after each unquoted ``:``
    (``PATH=/a:~/b``).

    Args:
        ts_node (TSNodeLike): the value's node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
    """
    return str(
        await expand(
            ts_node, "assignment", context, execute_fn, call_stack, policies
        )
    )


async def expand_arith(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None,
    policies: Policies | None = None,
) -> str:
    """An arithmetic command's expression text: ``$``-expansions
    substitute textually, as bash expands before it evaluates, while bare
    names stay names for the evaluator to read and assign.

    Args:
        ts_node (TSNodeLike): the arithmetic node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
    """
    return str(
        await expand(
            ts_node, "arith", context, execute_fn, call_stack, policies
        )
    )


async def expand_subscript(
    text: str,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> str:
    """A subscript a builtin was given as text (``unset 'a[$i]'``,
    ``read 'm[$k]'``), expanded as one typed in ``${a[...]}`` is: an
    associative key with its quoting removed, an indexed one the text
    its arithmetic reads. One with no expansion, quote or escape stays
    as typed.

    Args:
        text (str): the text between the brackets.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
    """
    if not any(ch in "$`'\"\\" for ch in text):
        return text
    word = parse("${x[" + text + "]}")
    return str(
        await expand(
            word, "subscript", context, execute_fn, call_stack, policies
        )
    )
