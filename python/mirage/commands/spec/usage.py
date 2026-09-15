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

from mirage.commands.errors import UsageError
from mirage.commands.spec.constants import (OLD_OPTION_EXIT, OPERAND_EXIT,
                                            PYTHON_NAMES, PYTHON_USAGE,
                                            READ_FAIL_EXIT,
                                            READ_FAIL_EXIT_ISDIR, USAGE_EXIT,
                                            USAGE_HINT_PREFIX)
from mirage.commands.spec.types import CommandName
from mirage.utils.errors import fs_strerror


def usage_exit_code(cmd_name: str) -> int:
    """GNU usage-error exit code for a command.

    Args:
        cmd_name (str): command name.
    """
    return USAGE_EXIT.get(cmd_name, 1)


def operand_exit_code(cmd_name: str) -> int:
    """Exit code of a command refused on one operand before it ran.

    Args:
        cmd_name (str): command name.
    """
    return OPERAND_EXIT.get(cmd_name, 1)


# What "could not read this operand" looks like as an errno, and nothing
# wider. The tables below are keyed by command, and the executor's
# chokepoints catch every error a command can raise, so the gate has to be
# the narrow thing or the tables answer in the wrong voice. Two cases
# proved it: a bad script is not a filesystem error at all (`sed
# 's/o/O/0'` is exit 1, not sed's 2), and EACCES is as often a WRITE
# refusal as a read one (`sed -i` on a read-only backend raises
# PermissionError and is exit 1, not 4). EACCES on a genuine read is the
# one case this leaves at 1 where GNU would answer the command's code;
# that is the safe side to err on, and it is what the executor already
# did before the tables existed.
_READ_FAIL_ERRORS = (FileNotFoundError, IsADirectoryError, NotADirectoryError)


def _read_fail_code(cmd_name: str, is_dir: bool) -> int:
    if is_dir:
        code = READ_FAIL_EXIT_ISDIR.get(cmd_name)
        if code is not None:
            return code
    return READ_FAIL_EXIT.get(cmd_name, 1)


def read_fail_exit(cmd_name: str, exc: BaseException) -> int:
    """The exit code for a command that could not read an operand.

    Read off the command, not off the errno, because that is how GNU's
    own codes fall; the errno is consulted only for the four commands
    that answer a directory and a missing file differently. Mirrors
    ``readFailExitCode`` in usage.ts.

    Gated on ``_READ_FAIL_ERRORS`` rather than on the whole of
    ``FS_ERRORS``; see the comment on that tuple for the two cases that
    set its width.

    Args:
        cmd_name (str): the command reporting the failure.
        exc (BaseException): the error it hit.
    """
    if not isinstance(exc, _READ_FAIL_ERRORS):
        return 1
    return _read_fail_code(cmd_name, isinstance(exc, IsADirectoryError))


def _line_read_fail_code(cmd_name: str, line: str) -> int | None:
    """The code one rendered stderr line's terminal errno asks for.

    Read off the LAST field, not searched for anywhere in the line: the
    renderer writes ``<cmd>: <path>: <strerror>`` and a path is free to
    spell a strerror itself, so a directory named ``No such file or
    directory`` read as ENOENT under a global scan and sed answered 2
    where GNU answers 4. None when the terminal field is not a strerror
    this family knows, which is what a line that is not a failed read
    looks like.

    Args:
        cmd_name (str): the command the line was respelled into.
        line (str): one rendered stderr line, newline already stripped.
    """
    terminal = line.rsplit(": ", 1)[-1]
    for exc_type in _READ_FAIL_ERRORS:
        if fs_strerror(exc_type()) == terminal:
            return _read_fail_code(cmd_name, exc_type is IsADirectoryError)
    return None


def read_fail_exit_line(cmd_name: str, rendered: bytes) -> int:
    """The same code, for a read failure known only as a rendered line.

    The cross-mount stream path fetches each operand with a native ``cat``
    sub-run, so a failed operand arrives as cat's rendered stderr rather
    than as an exception. That line is already respelled into the real
    command's voice, and the exit code has to follow it or `sort a
    /other/missing` answers 1 while `sort missing` answers 2, a split GNU
    does not have. Classified against the very strerrors the renderer
    wrote, so the forward and backward directions cannot drift; a blob
    that carries no failed-read line keeps the catch-all 1.

    One fetch can render several lines, because one operand can be a glob
    the owning mount expanded, and the most severe code is the answer:
    sed is the only stream command whose code depends on the errno, and
    its rule is the most severe (4 beats 2), which is also how the caller
    folds one operand's code into the next.

    Args:
        cmd_name (str): the command the line was respelled into.
        rendered (bytes): the fetch's stderr, GNU-formatted.
    """
    code = 0
    for line in rendered.decode("utf-8", "replace").splitlines():
        one = _line_read_fail_code(cmd_name, line)
        if one is not None:
            code = max(code, one)
    return code or 1


def python_option_error(cmd_name: str, line: str) -> tuple[bytes, int]:
    """CPython's option refusal: one message line, then its usage block.

    Args:
        cmd_name (str): the interpreter as invoked, which names the
            usage line ('python' or 'python3').
        line (str): the message line, newline included.
    """
    return (line + PYTHON_USAGE.format(name=cmd_name)).encode(), \
        usage_exit_code(cmd_name)


def curl_option_error(line: str) -> tuple[bytes, int]:
    """curl's option refusal: one message line, then its own help hint.

    Pinned on curl 8.14.1 (debian:stable-slim). One divergence: curl names
    a whole cluster with a bad letter (`option -sW: is unknown`) where the
    parser reports the letter, so mirage says `option -W`.

    Args:
        line (str): the message line, newline included.
    """
    hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"
    return (line + hint).encode(), usage_exit_code("curl")


def unknown_option_error(cmd_name: str, token: str) -> tuple[bytes, int]:
    """GNU-shaped error for an option the spec does not declare.

    Shapes pinned against real GNU: long options report the full token
    (`cat: unrecognized option '--bogus=x'`), short options report the
    offending character (`cat: invalid option -- 'Y'`), and find uses its
    predicate wording with backquote quoting. GNU's per-tool usage dumps
    are deliberately omitted; the `--help` hint line is kept because every
    registered command serves `--help`.

    Args:
        cmd_name (str): command name for the message and exit code.
        token (str): offending token ('--bogus') or cluster char ('Y').
    """
    if cmd_name == "curl":
        dashed = token if token.startswith("-") else f"-{token}"
        return curl_option_error(f"curl: option {dashed}: is unknown\n")
    if cmd_name == CommandName.FIND:
        dashed = token if token.startswith("-") else f"-{token}"
        line = f"find: unknown predicate `{dashed}'\n"
        return line.encode(), usage_exit_code(cmd_name)
    if cmd_name in PYTHON_NAMES:
        # CPython's own two shapes, which do not match each other: the
        # short form capitalizes and takes a colon, the long form does
        # neither. Both pinned on 3.12.13.
        if token.startswith("--"):
            return python_option_error(cmd_name, f"unknown option {token}\n")
        dashed = token if token.startswith("-") else f"-{token}"
        return python_option_error(cmd_name, f"Unknown option: {dashed}\n")
    if token.startswith("--"):
        line = f"{cmd_name}: unrecognized option '{token}'\n"
    else:
        line = f"{cmd_name}: invalid option -- '{token}'\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def ambiguous_option_error(cmd_name: str, token: str,
                           candidates: tuple[str, ...]) -> tuple[bytes, int]:
    """getopt_long refusal for an abbreviated long matching several options.

    Shape pinned against real GNU (``grep --c``): the typed spelling,
    then every possibility quoted in declaration order on one line. The
    per-tool usage dump GNU appends is deliberately omitted, like
    unknown_option_error.

    Args:
        cmd_name (str): command name for the message and exit code.
        token (str): the typed abbreviated spelling ('--c').
        candidates (tuple[str, ...]): matching declared spellings in
            declaration order.
    """
    listed = " ".join(f"'{c}'" for c in candidates)
    line = (f"{cmd_name}: option '{token}' is ambiguous; "
            f"possibilities: {listed}\n")
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def invalid_int_error(cmd_name: str, option: str,
                      value: str) -> tuple[bytes, int]:
    """Refusal for a non-integer value on an int-typed option.

    No GNU tool declares types through getopt (each words its own
    refusal, e.g. ``head: invalid number of lines``), so this mirrors
    argparse's ``invalid int value: 'abc'`` with the option attributed
    the way invalid_argument_error does.

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): canonical dashed spelling ('--port').
        value (str): the rejected value.
    """
    line = f"{cmd_name}: invalid int value: '{value}' for '{option}'\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def invalid_float_error(cmd_name: str, option: str,
                        value: str) -> tuple[bytes, int]:
    """Refusal for a non-number value on a float-typed option.

    Mirrors argparse's ``invalid float value: '5x'`` the same way
    invalid_int_error mirrors the int wording.

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): canonical dashed spelling ('--timeout').
        value (str): the rejected value.
    """
    if cmd_name == "curl":
        return curl_option_error(
            f"curl: option {option}: expected a proper numerical parameter\n")
    line = f"{cmd_name}: invalid float value: '{value}' for '{option}'\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def missing_value_error(cmd_name: str, token: str) -> tuple[bytes, int]:
    """GNU-shaped error for a declared value flag with no argument left.

    Args:
        cmd_name (str): command name for the message and exit code.
        token (str): long token ('--max-depth') or short char ('m').
    """
    if cmd_name in PYTHON_NAMES:
        dashed = token if token.startswith("-") else f"-{token}"
        return python_option_error(
            cmd_name, f"Argument expected for the {dashed} option\n")
    if cmd_name == "curl":
        dashed = token if token.startswith("-") else f"-{token}"
        return curl_option_error(
            f"curl: option {dashed}: requires parameter\n")
    if token.startswith("--"):
        line = f"{cmd_name}: option '{token}' requires an argument\n"
    else:
        line = f"{cmd_name}: option requires an argument -- '{token}'\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def old_option_error(cmd_name: str, letter: str) -> tuple[bytes, int]:
    """GNU tar refusal for an old-style cluster letter with no argument.

    First line and exit pinned against GNU tar 1.35 (``tar xzf`` with
    nothing after it, and ``tar cfC a.tar``, which names C). tar's own
    wording, capital and full stop included, because it counts the
    cluster's argument needs before argp sees the line at all.

    The hint line is deliberately mirage's, not GNU's: GNU offers
    ``Try 'tar --help' or 'tar --usage' for more information.`` because
    argp gives every argp program a ``--usage``, and mirage's tar serves
    only ``--help``. Naming a flag that does not exist would be worse
    than the shorter hint, and every other refusal here words it this
    way, so tar's two refusals stay consistent with each other.

    Args:
        cmd_name (str): command name for the message.
        letter (str): the cluster letter whose argument ran out.
    """
    line = f"{cmd_name}: Old option '{letter}' requires an argument.\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), OLD_OPTION_EXIT


def invalid_argument_error(cmd_name: str, option: str, value: str,
                           choices: tuple[str, ...]) -> tuple[bytes, int]:
    """GNU ARGMATCH refusal for a value outside a declared choices set.

    Shape pinned against real GNU (``tee --output-error=bogus``): the
    offending value, the option's canonical long spelling, then every
    valid argument in declaration order, one per line.

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): canonical dashed spelling ('--output-error').
        value (str): the rejected value.
        choices (tuple[str, ...]): allowed values in declaration order.
    """
    valid = "\n".join(f"  - '{c}'" for c in choices)
    line = (f"{cmd_name}: invalid argument '{value}' for '{option}'\n"
            f"Valid arguments are:\n{valid}\n")
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def missing_required_error(cmd_name: str, option: str) -> tuple[bytes, int]:
    """Refusal for a declared required option absent from the line.

    No GNU tool declares required options through getopt, so there is no
    GNU shape to pin; this follows the unrecognized-option pattern
    (click reports the same condition as "Missing option").

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): canonical dashed spelling ('--output').
    """
    line = f"{cmd_name}: option '{option}' is required\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def usage_hint(cmd_name: str) -> str:
    """The ``Try '<cmd> --help'`` line as that command prints it.

    coreutils writes the hint bare; diffutils routes it through
    ``error()``, so ``cmp`` and ``diff`` carry the command prefix on the
    hint line too.

    Args:
        cmd_name (str): the command whose hint line is wanted.
    """
    prefix = f"{cmd_name}: " if cmd_name in USAGE_HINT_PREFIX else ""
    return f"{prefix}Try '{cmd_name} --help' for more information."


def extra_operand_error(cmd_name: str, operand: str) -> UsageError:
    """GNU-shaped usage error for an operand past a command's arity.

    Shapes pinned against real GNU: ``<cmd>: extra operand '<arg>'`` with
    the ``Try '--help'`` hint (diff and cmp prefix the hint line with the
    command name; mktemp says ``too many templates`` with no operand).
    The operand must be the as-typed spelling (``raw_path``), never the
    resolved path.

    Args:
        cmd_name (str): command name for the message and exit code.
        operand (str): the first extra operand as typed.
    """
    if cmd_name == CommandName.MKTEMP:
        line = "mktemp: too many templates"
    else:
        line = f"{cmd_name}: extra operand '{operand}'"
    return UsageError(f"{line}\n{usage_hint(cmd_name)}",
                      usage_exit_code(cmd_name))
