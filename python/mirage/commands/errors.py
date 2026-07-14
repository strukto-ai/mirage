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
