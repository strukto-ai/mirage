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
from mirage.io.errors import MemoryExhausted
from mirage.io.yield_budget import task_turn
from mirage.policy.errors import PolicyDenied
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

    async def subscript(self, text: str) -> str:
        """Expand a subscript given as text, on the shell the task lent.

        Args:
            text (str): the text between the brackets.
        """
        ...

    async def process(self, shell: Shell, node: ShellNode) -> str:
        """Start a process substitution in ``shell`` and name its pipe.

        Args:
            shell (Shell): the child shell, a copy of the task's.
            node (ShellNode): the process substitution's node.
        """
        ...


def fault_error(fault: Fault) -> BaseException:
    """The exception an operation's stop raises.

    Args:
        fault (Fault): the tagged tuple mirage-rs ended with.
    """
    error: BaseException
    match fault:
        case ("hidden", name):
            return PolicyDenied(
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
    store's flush) reads a copy as the task left it: the pause's view, or
    a copy of the child shell it hands on. A long list of fields comes in
    slices, the host letting others run between them.

    Args:
        task (ShellTask): the running operation.
        host (TaskHost): what answers it.
        diagnostics (list[str | bytes]): where its warnings go, in order,
            whether it ends or stops.
    """
    failure: BaseException | None = None
    records = host.session.vars
    shown = host.session.visibility
    while (ask := task.step()) is not None:
        held = records.shell
        match ask[0]:
            case "pause":
                records.shell = ask[-1]
            case "subscript":
                records.shell = ask[1]
            case _:
                records.shell = ask[1].fork()
        failed: Callable[[], None] = (
            partial(task.answer_subscript, None, ask[1])
            if ask[0] == "subscript"
            else task.answer_failed
        )
        answer: Callable[[], None] = failed
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
                case ("subscript", shell, text):
                    answer = partial(
                        task.answer_subscript,
                        await host.subscript(text),
                        shell,
                    )
                case ("pause", _):
                    await task_turn()
                    answer = task.answer_resumed
        except BaseException as exc:
            failure = exc
            answer = failed
        finally:
            records.shell = held
        # The copies the request lent go before the task goes on, so a
        # write it lands shares its records with none and copies nothing.
        del ask
        try:
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
        raise fault_error(result)
    if not task.more():
        return result[1]
    fields = list(result[1])
    while task.more():
        await task_turn()
        fields.extend(task.slice())
    return fields
