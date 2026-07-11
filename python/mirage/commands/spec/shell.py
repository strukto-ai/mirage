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
from dataclasses import dataclass, field

from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)

# GNU echo is not getopt, so its option surface is a word shape, not a
# CommandSpec: options are LEADING words matching this pattern only.
ECHO_OPTION = re.compile(r"-[neE]+")

SHELL_SPECS: dict[str, CommandSpec] = {
    "xargs":
    CommandSpec(
        description="Build and run command lines from standard input.",
        options=(
            Option(short="-n",
                   long="--max-args",
                   value_kind=OperandKind.TEXT,
                   description="Use at most N arguments per command line."),
            Option(short="-d",
                   long="--delimiter",
                   value_kind=OperandKind.TEXT,
                   description="Input items are separated by this character."),
            Option(short="-0",
                   long="--null",
                   description="Input items are terminated by NUL."),
            Option(short="-r",
                   long="--no-run-if-empty",
                   description="Do not run the command on empty input."),
            Option(short="-I",
                   value_kind=OperandKind.TEXT,
                   description="Replace occurrences of the token "
                   "(not supported)."),
            Option(short="-P",
                   long="--max-procs",
                   value_kind=OperandKind.TEXT,
                   description="Run up to N processes (not supported)."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "timeout":
    CommandSpec(
        description="Run a command with a time limit.",
        options=(
            Option(short="-s",
                   long="--signal",
                   value_kind=OperandKind.TEXT,
                   description="Signal to send on timeout (not supported)."),
            Option(short="-k",
                   long="--kill-after",
                   value_kind=OperandKind.TEXT,
                   description="Also send KILL after this long "
                   "(not supported)."),
            Option(long="--preserve-status",
                   description="Exit with the command's status on timeout "
                   "(not supported)."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "read":
    CommandSpec(
        description="Read a line from standard input into variables.",
        options=(Option(
            short="-r",
            description="Raw mode: backslash is not an escape character."), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
}


@dataclass(frozen=True, slots=True)
class ShellParse:
    """Result of a strict leading-option scan for a shell builtin.

    Wrapper builtins (xargs, timeout) stop option parsing at the first
    operand, since everything after it belongs to the wrapped command;
    the mount-command parser scans the whole line and warns-ignores
    unknown flags, which is wrong on both counts here. The builtin owns
    the error message and exit code (GNU shapes differ per tool), so
    the parse only reports what went wrong.

    Args:
        flags (dict[str, str | bool]): parsed options keyed by their
            dashless short or long name.
        operands (list[str]): everything from the first non-option on.
        invalid (str | None): unknown option char or long token.
        needs_value (str | None): value option with no value.
    """
    flags: dict[str, str | bool] = field(default_factory=dict)
    operands: list[str] = field(default_factory=list)
    invalid: str | None = None
    needs_value: str | None = None


def parse_shell_options(spec: CommandSpec, argv: list[str]) -> ShellParse:
    """Scan leading options the way getopt does for a shell builtin.

    Args:
        spec (CommandSpec): options table (SHELL_SPECS entry).
        argv (list[str]): builtin arguments, command name excluded.
    """
    short_bool: set[str] = set()
    short_value: set[str] = set()
    long_bool: set[str] = set()
    long_value: set[str] = set()
    alias: dict[str, str] = {}
    for opt in spec.options:
        short = opt.short.lstrip("-") if opt.short else None
        long = opt.long.lstrip("-") if opt.long else None
        name = short or long or ""
        if short is not None:
            (short_bool
             if opt.value_kind == OperandKind.NONE else short_value).add(short)
            alias[short] = name
        if long is not None:
            (long_bool
             if opt.value_kind == OperandKind.NONE else long_value).add(long)
            alias[long] = name
    flags: dict[str, str | bool] = {}
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--":
            i += 1
            break
        if tok.startswith("--") and len(tok) > 2:
            name, eq, value = tok[2:].partition("=")
            if name in long_bool:
                flags[alias[name]] = True
            elif name in long_value:
                if eq:
                    flags[alias[name]] = value
                elif i + 1 < len(argv):
                    i += 1
                    flags[alias[name]] = argv[i]
                else:
                    return ShellParse(flags=flags,
                                      operands=list(argv[i + 1:]),
                                      needs_value=name)
            else:
                return ShellParse(flags=flags,
                                  operands=list(argv[i + 1:]),
                                  invalid=tok)
            i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            chars = tok[1:]
            j = 0
            while j < len(chars):
                ch = chars[j]
                if ch in short_bool:
                    flags[alias[ch]] = True
                    j += 1
                    continue
                if ch in short_value:
                    rest = chars[j + 1:]
                    if rest:
                        flags[alias[ch]] = rest
                    elif i + 1 < len(argv):
                        i += 1
                        flags[alias[ch]] = argv[i]
                    else:
                        return ShellParse(flags=flags,
                                          operands=list(argv[i + 1:]),
                                          needs_value=ch)
                    break
                return ShellParse(flags=flags,
                                  operands=list(argv[i + 1:]),
                                  invalid=ch)
            i += 1
            continue
        break
    return ShellParse(flags=flags, operands=list(argv[i:]))
