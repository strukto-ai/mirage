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

from dataclasses import dataclass, field

from mirage.commands.spec.compile import (
    compile_spec,
    expand_long,
    option_spellings,
)
from mirage.commands.spec.constants import HELP_OPTION, VERSION_OPTION
from mirage.commands.spec.types import Argument, CommandSpec

SHELL_SPECS: dict[str, CommandSpec] = {
    "xargs": CommandSpec(
        description="Build and run command lines from standard input.",
        arguments=(
            Argument(
                "-0",
                "--null",
                action="store_true",
                help="Input items are terminated by NUL.",
            ),
            Argument(
                "-a",
                "--arg-file",
                type="str",
                help="Read items from this file, not standard input.",
            ),
            Argument(
                "-d",
                "--delimiter",
                type="str",
                help="Input items are separated by this character.",
            ),
            Argument(
                "-E",
                type="str",
                help="Stop reading at this logical end-of-file string.",
            ),
            Argument(
                "-e",
                "--eof",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -E; no string turns it off.",
            ),
            Argument(
                "-I",
                type="str",
                help="Replace this string in the initial "
                "arguments with each input line.",
            ),
            Argument(
                "-i",
                "--replace",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -I, with {} when no string is attached.",
            ),
            Argument(
                "-L",
                type="str",
                help="Use at most N non-blank input lines per command line.",
            ),
            Argument(
                "-l",
                "--max-lines",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -L, with 1 when no count is attached.",
            ),
            Argument(
                "-n",
                "--max-args",
                type="str",
                help="Use at most N arguments per command line.",
            ),
            Argument(
                "-o",
                "--open-tty",
                action="store_true",
                help="Reopen stdin as the terminal in each "
                "command (there is no terminal, so this fails).",
            ),
            Argument(
                "-p",
                "--interactive",
                action="store_true",
                help="Prompt before running each command "
                "(there is no terminal, so this fails).",
            ),
            Argument(
                "-r",
                "--no-run-if-empty",
                action="store_true",
                help="Do not run the command on empty input.",
            ),
            Argument(
                "-s",
                "--max-chars",
                type="str",
                help="Limit a command line to N bytes.",
            ),
            Argument(
                "-t",
                "--verbose",
                action="store_true",
                help="Print each command on stderr before running it.",
            ),
            Argument(
                "--show-limits",
                action="store_true",
                help="Show the command-line length limits.",
            ),
            Argument(
                "-x",
                "--exit",
                action="store_true",
                help="Exit if a command line exceeds the size limit.",
            ),
            Argument(
                "-P",
                "--max-procs",
                type="str",
                help="Run up to N commands at a time; 0 runs "
                "them all at once.",
            ),
            Argument(
                "--process-slot-var",
                type="str",
                help="Set this variable to each command's slot number.",
            ),
            VERSION_OPTION,
            HELP_OPTION,
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "timeout": CommandSpec(
        description="Run a command with a time limit.",
        arguments=(
            Argument(
                "-f",
                "--foreground",
                action="store_true",
                help="Signal only the command, not its process group.",
            ),
            Argument(
                "-k",
                "--kill-after",
                type="str",
                help="Also send KILL this long after the first signal.",
            ),
            Argument(
                "-p",
                "--preserve-status",
                action="store_true",
                help="Exit with the command's status even when it times out.",
            ),
            Argument(
                "-s",
                "--signal",
                type="str",
                help="Signal to send on timeout (default TERM).",
            ),
            Argument(
                "-v",
                "--verbose",
                action="store_true",
                help="Report each signal sent on stderr.",
            ),
            HELP_OPTION,
            VERSION_OPTION,
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "read": CommandSpec(
        description="Read a line from standard input into variables.",
        arguments=(
            Argument(
                "-r",
                action="store_true",
                help="Raw mode: backslash is not an escape character.",
            ),
            Argument(
                "-a", type="str", help="Store the words in the named array."
            ),
            Argument(
                "-d",
                type="str",
                help="Read up to this character instead of newline.",
            ),
            Argument(
                "-n", type="str", help="Return after at most N characters."
            ),
            Argument(
                "-N",
                type="str",
                help="Return after exactly N characters, delimiters included.",
            ),
            Argument("-t", type="str", help="Time out after N seconds."),
            Argument(
                "-p", type="str", help="Prompt (shown only on a terminal)."
            ),
            Argument(
                "-s", action="store_true", help="Do not echo (terminal only)."
            ),
            Argument(
                "-e", action="store_true", help="Use readline (terminal only)."
            ),
            Argument(
                "-i",
                type="str",
                help="Initial text for readline (terminal only).",
            ),
            Argument("-u", type="str", help="Read from this descriptor."),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "mapfile": CommandSpec(
        description="Read lines from standard input into an array.",
        arguments=(
            Argument(
                "-d", type="str", help="Line delimiter instead of newline."
            ),
            Argument("-n", type="str", help="Copy at most N lines."),
            Argument("-O", type="str", help="Start storing at this index."),
            Argument("-s", type="str", help="Discard the first N lines."),
            Argument("-t", action="store_true", help="Strip the delimiter."),
            Argument("-u", type="str", help="Read from this descriptor."),
            Argument("-C", type="str", help="Call this every quantum lines."),
            Argument("-c", type="str", help="Lines between callback calls."),
            Argument("texts", nargs="*", metavar=""),
        ),
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
            dashless short or long name; an optional-value option
            given bare is True.
        given (list[tuple[str, str | bool]]): every option in the order
            it was given, for a builtin whose options act in turn
            (xargs -I, -L and -n cancel one another).
        operands (list[str]): everything from the first non-option on.
        invalid (str | None): unknown option char or long token.
        candidates (tuple[str, ...]): the long options an ambiguous
            abbreviation in ``invalid`` names, in declaration order;
            empty when ``invalid`` names none.
        needs_value (str | None): value option with no value: the short
            char, or the long token with its dashes.
        unexpected_value (str | None): a no-argument long option given a
            value, as its full spelling and the value (``--null=x``).
    """

    flags: dict[str, str | bool] = field(default_factory=dict)
    given: list[tuple[str, str | bool]] = field(default_factory=list)
    operands: list[str] = field(default_factory=list)
    invalid: str | None = None
    candidates: tuple[str, ...] = ()
    needs_value: str | None = None
    unexpected_value: str | None = None


def parse_shell_options(spec: CommandSpec, argv: list[str]) -> ShellParse:
    """Scan leading options the way getopt does for a shell builtin.

    An optional-value option takes its value only when attached
    (``-iR``, ``--replace=R``), as getopt's ``::`` does, and a long
    option may be abbreviated to any prefix that names one option, as
    getopt_long reads it; an empty name (``--=x``) prefixes every one.

    Args:
        spec (CommandSpec): options table (SHELL_SPECS entry).
        argv (list[str]): builtin arguments, command name excluded.
    """
    short_bool: set[str] = set()
    short_value: set[str] = set()
    short_optional: set[str] = set()
    long_bool: set[str] = set()
    long_value: set[str] = set()
    long_optional: set[str] = set()
    alias: dict[str, str] = {}
    for opt in compile_spec(spec).options:
        short, long = option_spellings(opt)
        short = short.lstrip("-") if short else None
        long = long.lstrip("-") if long else None
        name = short or long or ""
        if short is not None:
            (
                short_bool
                if opt.action in ("store_true", "count")
                else short_optional
                if opt.nargs == "?"
                else short_value
            ).add(short)
            alias[short] = name
        if long is not None:
            (
                long_bool
                if opt.action in ("store_true", "count")
                else long_optional
                if opt.nargs == "?"
                else long_value
            ).add(long)
            alias[long] = name
    compiled = compile_spec(spec)
    flags: dict[str, str | bool] = {}
    given: list[tuple[str, str | bool]] = []

    def record(key: str, value: str | bool) -> None:
        flags[key] = value
        given.append((key, value))

    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--":
            i += 1
            break
        if tok.startswith("--") and len(tok) > 2:
            typed, eq, value = tok.partition("=")
            matches = (
                compiled.long_spellings
                if typed == "--"
                else expand_long(compiled, typed)
            )
            if len(matches) != 1:
                return ShellParse(
                    flags=flags,
                    given=given,
                    operands=list(argv[i + 1 :]),
                    invalid=tok,
                    candidates=tuple(matches),
                )
            name = matches[0][2:]
            if name in long_bool:
                if eq:
                    return ShellParse(
                        flags=flags,
                        given=given,
                        operands=list(argv[i + 1 :]),
                        unexpected_value=f"--{name}={value}",
                    )
                record(alias[name], True)
            elif name in long_optional:
                record(alias[name], value if eq else True)
            elif name in long_value:
                if eq:
                    record(alias[name], value)
                elif i + 1 < len(argv):
                    i += 1
                    record(alias[name], argv[i])
                else:
                    return ShellParse(
                        flags=flags,
                        given=given,
                        operands=list(argv[i + 1 :]),
                        needs_value=f"--{name}",
                    )
            i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            chars = tok[1:]
            j = 0
            while j < len(chars):
                ch = chars[j]
                if ch in short_bool:
                    record(alias[ch], True)
                    j += 1
                    continue
                if ch in short_optional:
                    record(alias[ch], chars[j + 1 :] or True)
                    break
                if ch in short_value:
                    rest = chars[j + 1 :]
                    if rest:
                        record(alias[ch], rest)
                    elif i + 1 < len(argv):
                        i += 1
                        record(alias[ch], argv[i])
                    else:
                        return ShellParse(
                            flags=flags,
                            given=given,
                            operands=list(argv[i + 1 :]),
                            needs_value=ch,
                        )
                    break
                return ShellParse(
                    flags=flags,
                    given=given,
                    operands=list(argv[i + 1 :]),
                    invalid=ch,
                )
            i += 1
            continue
        break
    return ShellParse(flags=flags, given=given, operands=list(argv[i:]))
