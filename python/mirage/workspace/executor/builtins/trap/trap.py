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

from mirage.shell.bytes import decode_text, encode_text
from mirage.workspace.executor.builtins.shared import builtin_error, result
from mirage.workspace.executor.builtins.timeout.constants import SIGNAL_NAMES
from mirage.workspace.executor.builtins.trap.constants import (
    EXIT_EVENT,
    PSEUDO_SIGNALS,
    RUN_EVENTS,
    SIGNAL_MAX,
    USAGE,
)
from mirage.workspace.executor.builtins.trap.types import TrapEvent
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState


def event_of(spec: str) -> TrapEvent | None:
    """What a signal spec names: EXIT, ERR or RETURN, another signal bash
    knows (which mirage cannot deliver), or nothing bash would accept.

    Args:
        spec (str): the word, a name with or without ``SIG`` in any case,
            or a number.
    """
    if spec.isascii() and spec.isdigit():
        number = int(spec)
        if number == 0:
            return TrapEvent.EXIT
        return TrapEvent.OTHER if number <= SIGNAL_MAX else None
    name = spec.upper()
    if name in {event.value for event in RUN_EVENTS}:
        return TrapEvent(name)
    if name in PSEUDO_SIGNALS:
        return TrapEvent.OTHER
    base = name[3:] if name.startswith("SIG") else name
    if base != EXIT_EVENT and any(known == base for known, _ in SIGNAL_NAMES):
        return TrapEvent.OTHER
    if base.startswith(("RTMIN", "RTMAX")):
        return TrapEvent.OTHER
    return None


def listing(action: str, event: TrapEvent) -> str:
    """One ``trap -p`` row, the action single-quoted the way bash does.

    Args:
        action (str): the registered action.
        event (TrapEvent): the event it answers.
    """
    quoted = action.replace("'", "'\\''")
    return f"trap -- '{quoted}' {event.value}\n"


async def handle_trap(args: list[str], session: SessionState) -> Result:
    """Register, reset or list the shell's ``EXIT``, ``ERR`` and
    ``RETURN`` actions.

    EXIT runs where the shell ends: at ``exit`` (in the frame that
    called it), at the end of a child shell, or when an error ends the
    shell. A line of a persistent session is not the end of its shell,
    so it runs nothing there. ERR runs after a command fails where
    ``set -e`` would act, RETURN after a function or a sourced file
    returns (``executor/traps.py``). Mirage delivers no signals, so any
    other event bash knows is refused rather than accepted and never
    run.

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
                    stderr="mirage: trap: -l: not supported\n",
                )
            else:
                message = builtin_error("trap", f"-{flag}: invalid option")
                return result(
                    "trap", exit_code=2, stderr=decode_text(message) + USAGE
                )
    errors: list[str] = []
    if printing or not words:
        out: list[str] = []
        for spec in words or [event.value for event in RUN_EVENTS]:
            event = event_of(spec)
            if event is None:
                errors.append(
                    decode_text(
                        builtin_error(
                            "trap", f"{spec}: invalid signal specification"
                        )
                    )
                )
            elif event is not TrapEvent.OTHER:
                action = getattr(session, RUN_EVENTS[event][0])
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
            return result("trap", exit_code=2, stderr=USAGE)
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
        elif event is not TrapEvent.OTHER:
            field, scoped = RUN_EVENTS[event]
            setattr(session, field, None if action == "-" else action)
            setattr(session, scoped, False)
        elif action != "-":
            errors.append(f"mirage: trap: {spec}: not supported\n")
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
