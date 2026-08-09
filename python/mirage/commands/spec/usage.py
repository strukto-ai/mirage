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
from mirage.commands.spec.constants import (OLD_OPTION_EXIT, USAGE_EXIT,
                                            USAGE_HINT_PREFIX)
from mirage.commands.spec.types import CommandName


def usage_exit_code(cmd_name: str) -> int:
    """GNU usage-error exit code for a command.

    Args:
        cmd_name (str): command name.
    """
    return USAGE_EXIT.get(cmd_name, 1)


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
    if cmd_name == CommandName.FIND:
        dashed = token if token.startswith("-") else f"-{token}"
        line = f"find: unknown predicate `{dashed}'\n"
        return line.encode(), usage_exit_code(cmd_name)
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
    line = f"{cmd_name}: invalid float value: '{value}' for '{option}'\n"
    hint = f"Try '{cmd_name} --help' for more information.\n"
    return (line + hint).encode(), usage_exit_code(cmd_name)


def missing_value_error(cmd_name: str, token: str) -> tuple[bytes, int]:
    """GNU-shaped error for a declared value flag with no argument left.

    Args:
        cmd_name (str): command name for the message and exit code.
        token (str): long token ('--max-depth') or short char ('m').
    """
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
    prefix = f"{cmd_name}: " if cmd_name in USAGE_HINT_PREFIX else ""
    hint = f"{prefix}Try '{cmd_name} --help' for more information."
    return UsageError(f"{line}\n{hint}", usage_exit_code(cmd_name))
