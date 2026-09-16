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
from mirage.commands.quote import quote_text
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


# The programs that do NOT parse with getopt_long, and so answer an
# option they will not take by naming the whole typed token as unknown
# rather than by naming the option. Each one is measured: `curl
# --silent=2` is `curl: option --silent=2: is unknown`, `python3
# --version=2` is `unknown option --version=2`, `jq --tab=2` is `jq:
# Unknown option --tab=2`, and find reads the word as a predicate. Every
# other command here is a GNU tool whose getopt_long words the refusal
# the other way, so the set is the exception list and not the rule.
_NOT_GETOPT_LONG = frozenset({"curl", "jq", CommandName.FIND, *PYTHON_NAMES})


def unexpected_value_error(cmd_name: str, token: str) -> tuple[bytes, int]:
    """getopt_long refusal for a BOOLEAN long option handed a value.

    `grep --byte-offset=2` is not an unrecognized option -- getopt_long
    recognized it perfectly well and refused the `=2`, so the message
    names the option and drops the value, where the unrecognized-option
    message quotes the whole token including it. It also names the
    CANONICAL spelling, not the one that was typed: `grep --byte=2`
    answers for `--byte-offset`. Shape pinned against GNU grep 3.11 and
    coreutils 9.4 (`grep --byte-offset=2`, `grep --line-buffered=2`, `nl
    --help=2`, `cut --complement=2`, `sed --debug=2`), all exit 2 for
    grep and sort and 1 for the coreutils.

    GNU's per-tool usage dump is deliberately omitted, exactly as
    unknown_option_error omits it; grep and sed print theirs between the
    message and the hint, coreutils print none at all.

    Args:
        cmd_name (str): command name for the message and exit code.
        token (str): the option's canonical long spelling and the value
            that was typed on it ('--byte-offset=2'). Carried whole
            because the programs in _NOT_GETOPT_LONG quote the value
            along with the option and getopt_long drops it.
    """
    if cmd_name in _NOT_GETOPT_LONG:
        return unknown_option_error(cmd_name, token)
    option = token.split("=", 1)[0]
    line = f"{cmd_name}: option '{option}' doesn't allow an argument\n"
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


# One ARGMATCH candidate: a bare name, or a group of spellings that
# gnulib's argmatch maps to the SAME value. The group is not cosmetic --
# `argmatch_valid` starts a new `  - ` line only when the value changes
# and joins the aliases of one value with `, `, which is why GNU answers
# `sort --check=x` with `  - 'quiet', 'silent'` on one line and
# `  - 'diagnose-first'` on the next.
ArgmatchChoices = tuple[str | tuple[str, ...], ...]


def argmatch_line(cmd_name: str, option: str, value: str) -> str:
    r"""The first line of a gnulib ARGMATCH refusal, without newline.

    Two wordings, and the empty word picks the second: gnulib's
    ``argmatch`` matches on a prefix, so ``""`` is a prefix of every
    candidate and comes back ambiguous rather than invalid. Measured on
    coreutils 9.4 at every argmatch slot in the repo (``tail --follow=``,
    ``sort --check=``, ``wc --total=``, ``uniq --all-repeated=``,
    ``uniq --group=``, ``ls --format=``, ``ls -l --time-style=``,
    ``cp --update=``, ``tee --output-error=``), all of which answer
    ``ambiguous argument ''``. ``du --max-depth=`` is NOT argmatch and
    says ``invalid maximum depth ''``, which is why that one is worded
    in du.

    The word is rendered through ``quote_text``, gnulib's own
    ``quote()``: ``tee --output-error=xé`` is
    ``invalid argument 'x\303\251'``. Callers must therefore pass the
    value as typed and never pre-escape it.

    Args:
        cmd_name (str): command name for the message.
        option (str): the slot GNU names -- a canonical dashed spelling
            ('--output-error') or a prose name ('backup type',
            'time style'), quoted either way.
        value (str): the rejected value, as typed.
    """
    kind = "ambiguous" if value == "" else "invalid"
    return (f"{cmd_name}: {kind} argument '{quote_text(value)}' "
            f"for '{option}'")


def argmatch_valid_block(choices: ArgmatchChoices) -> str:
    """gnulib's ``Valid arguments are:`` block, without a trailing newline.

    Args:
        choices (ArgmatchChoices): the candidates in declaration order,
            aliases of one value grouped into a tuple.
    """
    rows = []
    for choice in choices:
        group = (choice, ) if isinstance(choice, str) else choice
        rows.append("  - " + ", ".join(f"'{c}'" for c in group))
    return "Valid arguments are:\n" + "\n".join(rows)


def invalid_argument_error(cmd_name: str,
                           option: str,
                           value: str,
                           choices: ArgmatchChoices,
                           exit_code: int | None = None) -> tuple[bytes, int]:
    """GNU ARGMATCH refusal for a value outside a declared choices set.

    Shape pinned against real GNU (``tee --output-error=bogus``): the
    offending value, the option's canonical long spelling, then every
    valid argument in declaration order, aliases of one value on one
    line, then the ``Try '--help'`` hint.

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): canonical dashed spelling ('--output-error').
        value (str): the rejected value, as typed; the renderer
            escapes it.
        choices (ArgmatchChoices): allowed values in declaration order.
        exit_code (int | None): the code to answer with. None takes the
            command's own usage code, which is 1 for every command in
            the repo that reaches this renderer through the executor.
            ls and sort pass 1 explicitly: gnulib's ``argmatch_die``
            always calls ``usage (EXIT_FAILURE)``, so their argmatch
            refusals are 1 even though their other usage errors are 2.
    """
    line = (f"{argmatch_line(cmd_name, option, value)}\n"
            f"{argmatch_valid_block(choices)}\n")
    hint = f"Try '{cmd_name} --help' for more information.\n"
    code = usage_exit_code(cmd_name) if exit_code is None else exit_code
    return (line + hint).encode(), code


def argmatch_error(cmd_name: str,
                   option: str,
                   value: str,
                   choices: ArgmatchChoices,
                   exit_code: int | None = None) -> UsageError:
    """:func:`invalid_argument_error` as the exception a command raises.

    The commands that validate an ARGMATCH value themselves (``sort``,
    ``wc``, ``uniq``, ``ls``, ``cp``, ``tail``) hold the value long
    after the parser is done with it, so they render through the same
    function the executor does rather than wording a second copy.

    Args:
        cmd_name (str): command name for the message and exit code.
        option (str): the slot GNU names.
        value (str): the rejected value, as typed.
        choices (ArgmatchChoices): allowed values in declaration order.
        exit_code (int | None): as in :func:`invalid_argument_error`.
    """
    message, code = invalid_argument_error(cmd_name, option, value, choices,
                                           exit_code)
    return UsageError(message.decode().rstrip("\n"), code)


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
