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

import errno
from collections.abc import Callable
from functools import partial
from typing import Any, Protocol

from mirage._rs import Shell, ShellNode, ShellTask
from mirage.context.session_context import explaining
from mirage.io.errors import MemoryExhausted
from mirage.io.yield_budget import task_turn
from mirage.policy.errors import PolicyDenied
from mirage.policy.policies import (
    Policies,
    post_session_gate,
    pre_session_gate,
)
from mirage.policy.types import DryRun, SessionContext
from mirage.shell.errors import (
    ArithError,
    BadSubstitution,
    DiscardSignal,
    ExitSignal,
    ReadonlyVariableError,
    UnboundVariable,
)
from mirage.workspace.session.session import SessionState

Fault = tuple[Any, ...]


class TaskHost(Protocol):
    """What a running shell task asks the host for, on the session whose
    shell the task holds."""

    session: SessionState

    async def substitute(
        self,
        shell: Shell,
        body: str,
        node: ShellNode,
        span: tuple[int, int] | None,
        read: list[str] | None,
    ) -> tuple[bytes, bytes, int]:
        """Run a command substitution's body in the child ``shell``.

        Args:
            shell (Shell): the child shell, a copy of the task's.
            body (str): the line the substitution holds.
            node (ShellNode): the substitution's node.
            span (tuple[int, int] | None): the body's span within the
                node, for a backtick region holding several.
            read (list[str] | None): for ``$(< file)``, the words the
                task's shell expanded the file's name to, glob marks kept;
                any but one is an ambiguous redirect.
        """
        ...

    async def process(self, shell: Shell, node: ShellNode) -> str:
        """Start a process substitution in ``shell`` and name its pipe.

        Args:
            shell (Shell): the child shell, a copy of the task's.
            node (ShellNode): the process substitution's node.
        """
        ...

    async def gate(
        self,
        post: bool,
        verb: str,
        key: str,
        value: str | None,
        old: str | None,
    ) -> None:
        """Ask the session policies about one write; a refusal raises.
        The session reads as the write finds it while they answer.

        Args:
            post (bool): ``post_session``, after the write landed.
            verb (str): ``set`` or ``unset``.
            key (str): the variable.
            value (str | None): the value rendered, None for an unset.
            old (str | None): the value it replaced, for ``post``.
        """
        ...

    async def listens(self) -> bool:
        """Whether a policy hears the session's writes now, which a task
        is told again each time the host answers it."""
        ...


async def listens(policies: Policies | None, session_id: str) -> bool:
    """Whether a session write asks anyone: a policy that hears this
    session's writes, or a dry run deciding, which refuses every write. A
    profile's programs speak for its own sessions only, so a session none
    governs writes without a gate, and an element write lands in place.

    Args:
        policies (Policies | None): the workspace's policies.
        session_id (str): the session written.
    """
    if explaining() is DryRun.DECIDING:
        return True
    return policies is not None and (
        await policies.wants_for("pre_session", session_id)
        or await policies.wants_for("post_session", session_id)
    )


class SessionGate:
    """A task host that gates writes on one session's policies and runs
    nothing: a builtin's write, or arithmetic.

    Args:
        session (SessionState): the session written.
        policies (Policies | None): its policies.
    """

    def __init__(
        self, session: SessionState, policies: Policies | None
    ) -> None:
        self.session = session
        self.policies = policies

    async def substitute(
        self,
        shell: Shell,
        body: str,
        node: ShellNode,
        span: tuple[int, int] | None,
        read: list[str] | None,
    ) -> tuple[bytes, bytes, int]:
        raise RuntimeError("a write runs no substitution")

    async def process(self, shell: Shell, node: ShellNode) -> str:
        raise RuntimeError("a write runs no process substitution")

    async def gate(
        self,
        post: bool,
        verb: str,
        key: str,
        value: str | None,
        old: str | None,
    ) -> None:
        ctx = SessionContext(
            verb=verb,
            key=key,
            value=value,
            session_id=self.session.session_id,
        )
        if post:
            await post_session_gate(self.policies, ctx, old)
        else:
            await pre_session_gate(self.policies, ctx)

    async def listens(self) -> bool:
        return await listens(self.policies, self.session.session_id)


def fault_error(
    fault: Fault, refusals: dict[int, BaseException]
) -> BaseException:
    """The exception an operation's stop raises.

    Args:
        fault (Fault): the tagged tuple mirage-rs ended with.
        refusals (dict[int, BaseException]): the policy refusals the host
            reported, by the record it gave each.
    """
    error: BaseException
    match fault:
        case ("hidden", name):
            return PolicyDenied(
                errno.EACCES, f"{name}: permission denied", name
            )
        case ("denied", name, record):
            return refusals.get(record) or PolicyDenied(
                errno.EACCES, f"{name}: permission denied", name
            )
        case ("readonly", name, in_subscript):
            return ReadonlyVariableError(name, in_subscript)
        case ("arith", ("arith", reason, expression, token, in_subscript)):
            error = ArithError(reason, expression, token)
            error.in_subscript = in_subscript
            return error
        case ("arith", ("readonly", name, in_subscript)):
            return ReadonlyVariableError(name, in_subscript)
        case ("arith", ("unbound", name)):
            return UnboundVariable(name)
        case ("exit", status, stderr, contained):
            return ExitSignal(status, stderr=stderr, contained_code=contained)
        case ("discard", stderr, contained):
            return DiscardSignal(stderr, contained_code=contained)
        case ("bad", text, fixed):
            error = BadSubstitution(text)
            error.fixed = fixed
            return error
        case ("memory",):
            return MemoryExhausted()
    return RuntimeError(f"shell task stopped: {fault!r}")


async def drive(
    task: ShellTask, host: TaskHost, diagnostics: list[str | bytes]
) -> Any:
    """Run a task to its end, answering what it asks.

    A failure of the host's stops the task and raises once the shell is
    back with its owner; so does the task's own stop. The session's own
    shell is the task's until it ends, so while the host answers, whatever
    reads the session by its id (a policy's view, a call forking it, the
    store's flush) reads a copy as the task left it: the request's view,
    or a copy of the child shell it hands on. A long list of fields comes
    in slices, the host letting others run between them.

    Args:
        task (ShellTask): the running operation.
        host (TaskHost): what answers it.
        diagnostics (list[str | bytes]): where its warnings go, in order,
            whether it ends or stops.
    """
    refusals: dict[int, BaseException] = {}
    failure: BaseException | None = None
    records = host.session.vars
    shown = host.session.visibility
    while (ask := task.step()) is not None:
        held = records.shell
        records.shell = (
            ask[-1] if ask[0] in ("gate", "pause") else ask[1].fork()
        )
        answer: Callable[[], None] = task.answer_failed
        heard: bool | None = None
        try:
            match ask:
                case ("substitute", _, body, node, span, read):
                    try:
                        out, err, status = await host.substitute(
                            ask[1], body, node, span, read
                        )
                    finally:
                        # The child shell ends with its substitution.
                        ask[1].close()
                    answer = partial(task.answer_substituted, out, err, status)
                case ("process", _, node):
                    path = await host.process(ask[1], node)
                    answer = partial(task.answer_path, path)
                case ("gate", post, verb, key, value, old, _):
                    try:
                        await host.gate(post, verb, key, value, old)
                    except PolicyDenied as exc:
                        record = len(refusals) + 1
                        refusals[record] = exc
                        answer = partial(task.answer_gate, (key, record))
                    else:
                        answer = partial(task.answer_gate, None)
                case ("pause", _):
                    await task_turn()
                    answer = task.answer_resumed
            # Asked while the lent copy stands in for the session, so a
            # policy reading the session to answer finds one to read.
            heard = await host.listens()
        except BaseException as exc:
            failure = exc
            answer = task.answer_failed
        finally:
            records.shell = held
        # The copies the request lent go before the task goes on, so a
        # write it lands shares its records with none and copies nothing;
        # a policy added while the host answered hears what comes next.
        del ask
        try:
            if heard is not None:
                task.listen(heard)
            answer()
        except BaseException as exc:
            failure = exc
            task.answer_failed()
    result, said = task.finish()
    # A profile changed while the host answered hid its names on a copy
    # lent meanwhile; the shell, back with its owner, takes them now.
    if host.session.visibility is not shown:
        host.session.hide_vars()
    diagnostics.extend(said)
    if failure is not None:
        raise failure
    if result[0] != "ok":
        raise fault_error(result, refusals)
    if not task.more():
        return result[1]
    fields = list(result[1])
    while task.more():
        await task_turn()
        fields.extend(task.slice())
    return fields
