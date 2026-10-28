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

import logging

from mirage.commands.errors import FindParseError, UsageError
from mirage.errors.render import format_fs_error
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.policy import (
    Deny,
    Pending,
    refusal_of,
    render_deny,
)
from mirage.shell.bytes import encode_text
from mirage.shell.constants import TIMEOUT_STATUS
from mirage.workspace.workspace.utils import command_name

logger = logging.getLogger(__name__)


def placement_refused(action: Deny | Pending, command: str) -> IOResult:
    """The line's result when ``pre_execute`` held it back: a policy
    refused it, or it waits on the host.

    A deny is a policy outcome, not a mistake: it folds into the line's
    result through the outcome table admission renders with, never a
    raise. The denied party is the command, so the message carries its
    name like every per-command error.

    Args:
        action (Deny | Pending): the stage's refusal, or the ledger's
            open question.
        command (str): the raw command line, for the diagnostic name.
    """
    name = command_name(command) or command
    err, code = render_deny(name, action)
    return IOResult(exit_code=code, stderr=err, refusal=refusal_of(action))


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
        return IOResult(
            exit_code=TIMEOUT_STATUS, stderr=encode_text(str(exc) + "\n")
        )
    if isinstance(exc, FindParseError):
        return IOResult(exit_code=1, stderr=encode_text(f"{exc}\n"))
    if isinstance(exc, UsageError):
        return IOResult(
            exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")
        )
    if isinstance(exc, OSError):
        name = command_name(command) or command
        return IOResult(exit_code=1, stderr=format_fs_error(name, exc))
    logger.debug(
        "workspace execution failed",
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return IOResult(exit_code=1, stderr=encode_text(f"{exc}\n"))
