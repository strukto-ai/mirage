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

from mirage.commands.spec.constants import USAGE_EXIT


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
    if cmd_name == "find":
        dashed = token if token.startswith("-") else f"-{token}"
        line = f"find: unknown predicate `{dashed}'\n"
        return line.encode(), usage_exit_code(cmd_name)
    if token.startswith("--"):
        line = f"{cmd_name}: unrecognized option '{token}'\n"
    else:
        line = f"{cmd_name}: invalid option -- '{token}'\n"
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
