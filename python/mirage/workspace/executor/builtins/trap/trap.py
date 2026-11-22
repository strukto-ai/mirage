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

from mirage.commands.builtin.utils.strtol import bounded_decimal
from mirage.context import current_caller
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.constants import SHELL_IGNORED_SIGNALS, SIGNALS
from mirage.shell.signals import signal_name, signal_number
from mirage.shell.voice import shell_voice
from mirage.workspace.executor.builtins.shared import (
    builtin_error,
    builtin_usage,
    result,
)
from mirage.workspace.executor.builtins.trap.constants import (
    RUN_EVENTS,
    SIGNAL_MAX,
)
from mirage.workspace.executor.builtins.trap.types import TrapEvent
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.traps import arm_signals
from mirage.workspace.session import SessionState


def event_of(spec: str) -> TrapEvent | int | None:
    """What a signal spec names: EXIT, ERR, RETURN or DEBUG, a signal's
    number, or nothing bash would accept.

    Args:
        spec (str): the word, a name with or without ``SIG`` in any case,
            or a number.
    """
    if spec.isascii() and spec.isdigit():
        number = bounded_decimal(spec, SIGNAL_MAX + 1)
        if number is None:
            return None
        return TrapEvent.EXIT if number == 0 else number
    name = spec.upper()
    if name in {event.value for event in TrapEvent}:
        return TrapEvent(name)
    base = name[3:] if name.startswith("SIG") else name
    if base in SIGNALS.values() or base.startswith("RT"):
        return signal_number(base)
    return None


def listing(action: str, event: TrapEvent | int) -> str:
    """One ``trap -p`` row, the action single-quoted the way bash does.

    Args:
        action (str): the registered action.
        event (TrapEvent | int): the event or signal it answers.
    """
    quoted = action.replace("'", "'\\''")
    if isinstance(event, TrapEvent):
        name = event.value
    else:
        known = signal_name(event)
        name = str(event) if known is None else f"SIG{known}"
    return f"trap -- '{quoted}' {name}\n"


def _action_of(session: SessionState, event: TrapEvent | int) -> str | None:
    """The action a shell lists for an event or signal, None for none.

    Args:
        session (SessionState): the shell.
        event (TrapEvent | int): the event or signal.
    """
    if isinstance(event, int):
        return session.signal_traps.get(event)
    if event is TrapEvent.DEBUG:
        return None
    action: str | None = getattr(session, RUN_EVENTS[event][0])
    return action


def _registered(session: SessionState) -> list[TrapEvent | int]:
    """What ``trap -p`` lists with no operand, in bash's order.

    Args:
        session (SessionState): the shell.
    """
    return [
        TrapEvent.EXIT,
        *sorted(session.signal_traps),
        TrapEvent.ERR,
        TrapEvent.RETURN,
    ]


def _own_traps(session: SessionState) -> None:
    """Drop the EXIT and signal actions a child shell lists as its
    parent's, as its first registration does in bash; the signals its
    parent ignores stay ignored.

    Args:
        session (SessionState): the shell registering.
    """
    if session.exit_trap_inherited:
        session.exit_trap = None
        session.exit_trap_inherited = False
    if session.signal_traps_inherited:
        session.signal_traps = {
            signal: action
            for signal, action in session.signal_traps.items()
            if not action
        }
        session.signal_traps_inherited = False


def _own_signal(session: SessionState, signal: int) -> None:
    """Make a signal the shell traps, ignores or resets its own to
    answer: its process stops ignoring the signal its parent's ``trap ''``
    or its job made it ignore, so the shell's action, ignore or default
    decides, as bash's child resets one (``(trap - TERM; ...)``). The
    QUIT every shell's process ignores stays ignored.

    Args:
        session (SessionState): the shell registering.
        signal (int): the signal.
    """
    session.job_ignored = session.job_ignored - {signal}
    process = current_caller().process
    if process is None or signal in SHELL_IGNORED_SIGNALS:
        return
    process.ignores = process.ignores - {signal}
    process.program_ignores = process.program_ignores - {signal}


async def handle_trap(args: list[str], session: SessionState) -> Result:
    """Register, reset or list the shell's actions.

    EXIT runs where the shell ends: at ``exit`` (in the frame that
    called it), at the end of a child shell, or when an error ends the
    shell. A line of a persistent session is not the end of its shell,
    so it runs nothing there. ERR runs after a command fails where
    ``set -e`` would act, RETURN after a function or a sourced file
    returns (``executor/traps.py``). A signal's action runs once the
    command running as it arrives (``kill``) has ended, and an empty one
    ignores the signal; one ignored as the shell started stays ignored,
    and KILL and STOP are listed and never caught, as bash's are. DEBUG
    is refused rather than accepted and never run.

    Args:
        args (list[str]): the words after ``trap``.
        session (SessionState): the shell whose action this is.
    """
    words = list(args)
    printing = False
    while words and words[0].startswith("-") and words[0] != "-":
        word = words.pop(0)
        if word == "--":
            break
        for flag in word[1:]:
            if flag == "p":
                printing = True
            elif flag == "l":
                return result(
                    "trap",
                    exit_code=2,
                    stderr=decode_text(
                        builtin_error("trap", "-l: not supported")
                    ),
                )
            else:
                message = builtin_error("trap", f"-{flag}: invalid option")
                return result(
                    "trap",
                    exit_code=2,
                    stderr=decode_text(message) + builtin_usage("trap"),
                )
    errors: list[str] = []
    if printing or not words:
        out: list[str] = []
        named: list[TrapEvent | int | None] = (
            [event_of(spec) for spec in words]
            if words
            else list(_registered(session))
        )
        for spec, event in zip(words or named, named, strict=True):
            if event is None:
                errors.append(
                    decode_text(
                        builtin_error(
                            "trap", f"{spec}: invalid signal specification"
                        )
                    )
                )
                continue
            action = _action_of(session, event)
            if action is not None:
                out.append(listing(action, event))
        return result(
            "trap",
            out=encode_text("".join(out)) or None,
            exit_code=1 if errors else 0,
            stderr="".join(errors) or None,
        )
    if len(words) == 1:
        if event_of(words[0]) is None:
            return result("trap", exit_code=2, stderr=builtin_usage("trap"))
        action, specs = "-", words
    else:
        action, specs = words[0], words[1:]
    for spec in specs:
        event = event_of(spec)
        if event is None:
            errors.append(
                decode_text(
                    builtin_error(
                        "trap", f"{spec}: invalid signal specification"
                    )
                )
            )
        elif event is TrapEvent.DEBUG:
            if action != "-":
                errors.append(f"{shell_voice()}trap: {spec}: not supported\n")
        elif isinstance(event, int):
            _own_traps(session)
            if event in session.entry_ignored:
                continue
            _own_signal(session, event)
            if action == "-":
                session.signal_traps.pop(event, None)
            else:
                session.signal_traps[event] = action
        else:
            if event is TrapEvent.EXIT:
                _own_traps(session)
            field, scoped = RUN_EVENTS[event]
            setattr(session, field, None if action == "-" else action)
            setattr(session, scoped, False)
    arm_signals(session)
    return result(
        "trap",
        exit_code=1 if errors else 0,
        stderr="".join(errors) or None,
    )


async def trap_builtin(call: BuiltinCall) -> Result:
    """The ``trap`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_trap(list(call.argv.args), call.context.session)
