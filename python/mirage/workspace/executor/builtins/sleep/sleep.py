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

import asyncio
import math

from mirage.commands.config import help_page, version_line
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import NUMERIC_SHORT
from mirage.commands.spec.usage import (ambiguous_option_error,
                                        unexpected_value_error,
                                        unknown_option_error, usage_hint)
from mirage.io import IOResult
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.sleep.constants import (SLEEP_INTERVAL,
                                                                SLEEP_SUFFIXES)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.types import ExecutionNode

# The only two options coreutils sleep declares, through gnulib's
# `parse_gnu_standard_options_only`. They share no prefix, so an
# abbreviation of either resolves and neither can ever be ambiguous.
_STANDARD_OPTIONS = ("--help", "--version")


def _standard_matches(name: str) -> tuple[str, ...]:
    """The standard options a long spelling names, declaration order.

    getopt_long takes an exact word outright and otherwise keeps every
    candidate the word prefixes, so `sleep --h` is one match (help,
    exit 0) and `sleep --=x` is an empty name that prefixes both, which
    GNU refuses as ambiguous. Measured on 9.7.

    Args:
        name (str): the long token's name half, `=value` already cut
            off, as typed.
    """
    if name in _STANDARD_OPTIONS:
        return (name, )
    return tuple(word for word in _STANDARD_OPTIONS if word.startswith(name))


def _standard_response(
        option: str) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """sleep's answer to `--help` or `--version`: stdout, exit 0.

    The page is built by ``help_page``, the one function every
    registered command's `--help` goes through (commands/config.py), so
    the two cannot drift. That matters here because sleep is a shell
    builtin rather than a registered command: nothing injects the two
    standard options into its spec, so rendering that spec directly
    produced a page documenting neither of the options this arm exists
    to answer, under a synthesized `sleep [<text>...]` in place of
    GNU's own `sleep NUMBER[SUFFIX]...`.

    Args:
        option (str): the canonical spelling, from _standard_option.
    """
    text = (help_page("sleep", SPECS["sleep"])
            if option == "--help" else version_line("sleep"))
    return yield_bytes(text), IOResult(), ExecutionNode(command="sleep",
                                                        exit_code=0)


def _sleep_operands(args: list[str]) -> tuple[list[str], str | None]:
    """sleep's operands, and the first dash word that is not one.

    coreutils sleep declares only gnulib's two standard options and
    reads the line through a real getopt_long loop
    (``parse_gnu_standard_options_only``), so it stops at a dash-leading
    word wherever that word sits: measured on 9.4, `sleep --zzz 0` and
    `sleep 0 --zzz` both report the option and neither reports the
    interval. The caller decides what that word means, since a
    `--help`/`--version` spelling is an answer rather than a refusal.
    `--` ends the scan, which is what makes `sleep -- '--zzz=é'` an
    interval diagnostic instead of an option one, and a `-<digits>`
    word stays an operand -- mirage's NUMERIC_SHORT rule, which every
    command shares, and the reason `sleep -1` names the interval where
    GNU names the option letter.

    Args:
        args (list[str]): words after the command name, as typed.

    Returns:
        tuple[list[str], str | None]: the operands, and the offending
            token (long) or option letter (short), or None when every
            dash word was one sleep accepts.
    """
    operands: list[str] = []
    for index, arg in enumerate(args):
        if arg == "--":
            operands.extend(args[index + 1:])
            break
        if (arg.startswith("-") and len(arg) > 1
                and not NUMERIC_SHORT.match(arg)):
            # GNU names the whole token for a long option and the first
            # offending character for a short one, which is the split
            # unknown_option_error already words.
            return operands, arg if arg.startswith("--") else arg[1]
        operands.append(arg)
    return operands, None


def _interval_seconds(raw: str) -> float | None:
    """One operand's seconds, or None when it is not an interval.

    GNU's grammar is `NUMBER[SUFFIX]`, which the help page advertises:
    gnulib reads the number with strtod, then allows at most ONE
    trailing character and looks it up in `apply_suffix`. Measured on
    coreutils 9.7: `sleep 0.005m` takes 0.3s, `sleep 1e-3s` is
    accepted, and `sleep 0S`, `sleep 0ss`, `sleep 0sx` and `sleep s`
    are each `invalid time interval`.

    Args:
        raw (str): one operand, as typed.

    Returns:
        float | None: the seconds it names, or None when the word is
            not one mirage accepts (which includes GNU's own "inf",
            a documented divergence carried by SLEEP_INTERVAL).
    """
    multiplier = SLEEP_SUFFIXES.get(raw[-1:], 0)
    number = raw[:-1] if multiplier else raw
    if not SLEEP_INTERVAL.fullmatch(number):
        return None
    seconds = float(number) * (multiplier or 1)
    # "1e309" passes the regex and overflows to inf.
    return seconds if math.isfinite(seconds) else None


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    operands, bad_option = _sleep_operands(args)
    if bad_option is not None:
        # The scan stops at the first dash word, and that word decides
        # the whole line: `sleep --help --zzz` is help and
        # `sleep --zzz --help` is the refusal (measured on 9.7). A long
        # spelling is first offered to the two standard options, which
        # are real getopt_long options, so an abbreviation resolves and
        # a value on one is refused for the VALUE rather than as an
        # unknown option (`sleep --hel=x` is `option '--help' doesn't
        # allow an argument`).
        name, eq, _value = bad_option.partition("=")
        matches = _standard_matches(name) if name.startswith("--") else ()
        if len(matches) > 1:
            # `--=x` is an empty long name, which prefixes both, and
            # getopt_long quotes the WHOLE token here where the
            # doesn't-allow-an-argument refusal quotes the canonical
            # spelling.
            message, code = ambiguous_option_error("sleep", bad_option,
                                                   matches)
        elif not matches:
            message, code = unknown_option_error("sleep", bad_option)
        elif not eq:
            return _standard_response(matches[0])
        else:
            message, code = unexpected_value_error("sleep", matches[0])
        return None, IOResult(exit_code=code,
                              stderr=message), ExecutionNode(command="sleep",
                                                             exit_code=code)
    if not operands:
        # Missing operand is the same `usage (EXIT_FAILURE)` refusal the
        # invalid-interval one is, so it carries the same Try-help line
        # (measured on 9.4: `sleep` is two lines, not one).
        err = (f"sleep: missing operand\n{usage_hint('sleep')}\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    # `NUMBER[SUFFIX]...`: every operand is an interval and the line
    # sleeps their SUM (measured on 9.7: `sleep 0.3 0.3` takes 0.6s).
    # All of them are checked before any of them is slept, so a bad one
    # anywhere refuses the whole line immediately rather than after
    # sleeping its predecessors (`sleep 0.2 x 0.2` exits 1 at once).
    total = 0.0
    bad: list[str] = []
    for raw in operands:
        seconds = _interval_seconds(raw)
        if seconds is None:
            bad.append(raw)
            continue
        # The SUM is what gets slept, so an operand that carries it past
        # the representable range is refused exactly like one that is
        # not finite on its own: `sleep 1e308 1e308` overflows to inf,
        # and an inf total slipped past the check each operand passes
        # alone. GNU sleeps forever on it (measured on 9.7, as it does
        # on `sleep inf`); refusing it is the same deliberate divergence
        # SLEEP_INTERVAL already carries, for the same reason.
        if not math.isfinite(total + seconds):
            bad.append(raw)
            continue
        total += seconds
    if bad:
        # coreutils calls `error()` per offending operand and only then
        # `usage (EXIT_FAILURE)`, so EVERY bad operand is named, in line
        # order and repeated if it repeats, under one closing Try-help
        # line (measured on 9.7: `sleep 1x 2y` is three lines, `sleep 1x
        # 1x` names 1x twice). Each operand goes through gnulib's
        # `quote()` like every other coreutils operand diagnostic
        # (measured on 9.4: `sleep -- <e-acute>` names `'\303\251'`).
        err = ("".join(f"sleep: invalid time interval '{quote_text(raw)}'\n"
                       for raw in bad) + f"{usage_hint('sleep')}\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(total, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)


async def sleep_builtin(call: BuiltinCall) -> Result:
    """The ``sleep`` arm.

    Args:
        call (BuiltinCall): the invocation; its cancel event ends the
            wait early.
    """
    return await handle_sleep(list(call.argv.args), cancel=call.cancel)
