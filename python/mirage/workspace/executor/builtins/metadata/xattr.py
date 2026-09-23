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

import dataclasses

from mirage.commands.spec.parser import ParsedArgs
from mirage.commands.spec.usage import (ambiguous_option_error,
                                        missing_value_error,
                                        unexpected_value_error,
                                        unknown_option_error)
from mirage.errors import POSIX, FsCondition, classify
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.shared import result
from mirage.workspace.executor.builtins.types import Result

# attr 2.5.2's usage blocks, which follow getopt's one-line refusal and
# end every usage error (exit 2) with the older backquote hint.
GETFATTR_USAGE = (
    "Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...\n"
    "Try `getfattr --help' for more information.\n")
SETFATTR_USAGE = ("Usage: setfattr {-n name} [-v value] [-h] file...\n"
                  "       setfattr {-x name} [-h] file...\n"
                  "Try `setfattr --help' for more information.\n")


def attr_usage_refusal(cmd: str, parsed: ParsedArgs,
                       usage: str) -> Result | None:
    """The usage error attr prints for a line getopt refused, if any.

    getopt's own line (``invalid option -- 'Z'``, ``option requires an
    argument -- 'n'``) and then attr's usage block, exit 2.

    Args:
        cmd (str): ``getfattr`` or ``setfattr``.
        parsed (ParsedArgs): the spec parse of the line.
        usage (str): the command's usage block.
    """
    message: bytes | None = None
    if parsed.ambiguous_options and (not parsed.invalid_options
                                     or parsed.option_error_kinds[:1]
                                     == ["ambiguous"]):
        token, candidates = parsed.ambiguous_options[0]
        message, _ = ambiguous_option_error(cmd, token, candidates)
    elif parsed.invalid_options:
        if parsed.option_error_kinds[:1] == ["unexpected_value"]:
            message, _ = unexpected_value_error(cmd, parsed.invalid_options[0])
        else:
            message, _ = unknown_option_error(cmd, parsed.invalid_options[0])
    elif parsed.needs_value_options:
        message, _ = missing_value_error(cmd, parsed.needs_value_options[0])
    if message is None:
        return None
    line = message.decode().split("\n", 1)[0]
    return result(cmd, exit_code=2, stderr=f"{line}\n{usage}")


def attr_error(exc: OSError) -> str:
    """The phrase attr prints for a failed attribute call.

    attr says "No such attribute" for an attribute that is not set,
    whatever the platform calls ENODATA or ENOATTR, and the C library's
    wording for everything else.

    Args:
        exc (OSError): what the op door raised.
    """
    condition = classify(exc)
    if condition is FsCondition.NO_XATTR:
        return "No such attribute"
    if condition is not None:
        return POSIX[condition].phrase
    return exc.strerror or str(exc)


def attr_operands(parsed: ParsedArgs) -> list[PathSpec]:
    """The line's file operands, resolved against the session's cwd, each
    keeping the spelling it was typed with for the header and messages.

    Args:
        parsed (ParsedArgs): the spec parse of the line.
    """
    return [
        dataclasses.replace(PathSpec.from_str_path(path), raw_path=typed)
        for (path, _), (typed, _) in zip(parsed.args, parsed.raw_operands)
    ]
