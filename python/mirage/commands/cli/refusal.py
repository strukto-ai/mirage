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

from mirage.commands.cli.constants import USAGE_EXIT
from mirage.commands.cli.types import UsageStyle
from mirage.workspace.executor.command.types import ParsedCommand

ARGPARSE_EXIT = 2
LONG_PREFIX = "--"


def git_unknown_option(token: str) -> bytes:
    """git's refusal for an option it does not know.

    Two nouns and no program name, pinned against git 2.50.1: a long
    option is an "option" and a short one is a "switch", both named
    without their dashes and quoted with a backquote-apostrophe pair.
    git follows this with the verb's usage block, which is omitted the
    same way GNU's is elsewhere in the spec machinery.

    Args:
        token (str): the offending token ('--nosuch') or cluster
            character ('Z'), as the flat parser reports it.
    """
    noun = "option" if token.startswith(LONG_PREFIX) else "switch"
    return f"error: unknown {noun} `{token.lstrip('-')}'\n".encode()


def leaf_refusal(style: UsageStyle, argparse_message: bytes,
                 parsed: ParsedCommand) -> tuple[bytes, int]:
    """The message and exit code a leaf answers a bad option with.

    A leaf usage error exits 2 under argparse's style regardless of the
    GNU USAGE_EXIT table, because an installed CLI name is never a GNU
    tool with its own pinned exit. git exits 129 for the same mistake,
    which is neither that nor its own 128 for a fatal.

    Args:
        style (UsageStyle): the dialect the CLI's root declares.
        argparse_message (bytes): the message the spec machinery built,
            used as-is for argparse and for anything git words the same.
        parsed (ParsedCommand): parse result, read for the offending
            token when the style rewrites the message.
    """
    if style is not UsageStyle.GIT:
        return argparse_message, ARGPARSE_EXIT
    if parsed.invalid_options:
        return git_unknown_option(parsed.invalid_options[0]), USAGE_EXIT
    return argparse_message, USAGE_EXIT
