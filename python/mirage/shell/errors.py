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


class ArithError(ValueError):
    """A bash arithmetic syntax or evaluation error."""


class ExitSignal(Exception):
    """A fatal shell exit request unwinding the current execution.

    Raised by the ``exit`` builtin and by fatal expansion errors
    (``${var:?msg}``), which bash treats as an implicit ``exit 1`` in a
    non-interactive shell. Contained at subshell, pipeline-segment, and
    background-job boundaries; the top-level program loop stops the
    remaining statements and reports ``exit_code``.

    Args:
        exit_code (int): status the shell exits with.
        stderr (bytes): diagnostic already formatted for the user.
        stdout (bytes | None): output produced before the exit that
            boundary handlers accumulated while unwinding (e.g. the left
            side of ``echo a && exit 3``).
        contained_code (int | None): status a containing boundary
            reports instead of ``exit_code``. GNU bash exits 127 on a
            fatal expansion error but a subshell wrapping one returns 1;
            ``exit N`` uses N in both positions (the default).
    """

    def __init__(self,
                 exit_code: int = 0,
                 stderr: bytes = b"",
                 stdout: bytes | None = None,
                 contained_code: int | None = None) -> None:
        self.exit_code = exit_code
        self.stderr = stderr
        self.stdout = stdout
        self.contained_code = (contained_code
                               if contained_code is not None else exit_code)
