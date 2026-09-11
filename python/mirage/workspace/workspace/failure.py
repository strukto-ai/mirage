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

from mirage.commands.errors import (CommandTimeoutError, FindParseError,
                                    UsageError)
from mirage.io import IOResult
from mirage.policy import Deny, refusal_of, render_deny
from mirage.runtime.routing import RouteDeny
from mirage.utils.errors import format_fs_error
from mirage.workspace.workspace.utils import command_name


def failure_result(exc: BaseException, command: str) -> IOResult:
    """The line's result when execution raised.

    A failed line reports like a failed command in bash: a diagnostic
    on stderr naming the command, and an exit code. Nothing here
    escapes as an exception; the caller re-raises the few kinds that
    are the caller's problem (abort, drift, policy misconfiguration)
    before reaching this.

    Args:
        exc (BaseException): the exception the line raised.
        command (str): the raw command line, for the diagnostic name.
    """
    if isinstance(exc, CommandTimeoutError):
        return IOResult(exit_code=124, stderr=(str(exc) + "\n").encode())
    if isinstance(exc, RouteDeny):
        # A deny is a policy outcome, not a mistake: it folds into the
        # line's result the way a timeout does, never a raise. The
        # denied party is the command, so the message carries its name
        # like every per-command error.
        name = command_name(command) or command
        deny = Deny(exc.reason)
        err, code = render_deny(name, deny)
        return IOResult(exit_code=code, stderr=err, refusal=refusal_of(deny))
    if isinstance(exc, FindParseError):
        return IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    if isinstance(exc, UsageError):
        return IOResult(exit_code=exc.exit_code, stderr=f"{exc}\n".encode())
    if isinstance(exc, OSError):
        name = command_name(command) or command
        return IOResult(exit_code=1, stderr=format_fs_error(name, exc))
    return IOResult(exit_code=1, stderr=f"{exc}\n".encode())
