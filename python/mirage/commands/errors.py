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


class UsageError(ValueError):
    """Command-line usage error (GNU semantics: stderr message + exit code).

    Args:
        message (str): the full stderr text (may span lines for the
            ``Try '--help'`` hint).
        exit_code (int): GNU usage-error exit code; most tools use 2 for
            option errors but 1 for operand errors, and the caller knows
            which (``usage_exit_code`` for the per-command table).
    """

    def __init__(self, message: str, exit_code: int = 2) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class FindParseError(ValueError):
    """Invalid numeric argument to a find predicate (GNU find: exit 1)."""


class PartialOutputError(Exception):
    """A command's failure after it had already printed output, which a
    program that writes as it goes leaves on stdout ahead of the
    diagnostic.

    Args:
        message (str): the diagnostic.
        stdout (bytes): what the command printed before it failed.
    """

    def __init__(self, message: str, stdout: bytes) -> None:
        super().__init__(message)
        self.stdout = stdout


class LimitExceededError(Exception):
    """A hard cap refused output the producer had already made.

    The cap is applied to a result that exists: at a dispatcher the
    backend has already moved those bytes, and the dispatcher reports that
    through the caller's ``OpReport`` before the cap runs, so this
    error carries no accounting of its own.
    """
