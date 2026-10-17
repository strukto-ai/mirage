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

from . import constants


class BcParseError(Exception):
    """Text bc cannot parse; reported, then evaluation continues.

    GNU charges an *unexpected token* to its own line and an *incomplete
    construct* to the line after its last token, because a legal prefix
    only fails once the next line arrives.

    Args:
        text (str): the diagnostic body, e.g. `syntax error`.
        incomplete (bool): whether the parser ran out of input rather
            than meeting a token it could not use.
        pos (int): the offset in the statement the diagnostic belongs to,
            or -1 for the statement's first character. A block comment
            spanning lines puts later characters of one statement on a
            later input line, so the offset is what names the line.
    """

    def __init__(
        self, text: str, incomplete: bool = False, pos: int = -1
    ) -> None:
        super().__init__(text)
        self.text = text
        self.incomplete = incomplete
        self.pos = pos


class BcRuntimeError(Exception):
    """A non-fatal runtime error: reported, then evaluation continues."""


class BcHalt(Exception):
    """`halt` was reached: stop the run, keeping what already printed.

    It is a statement, so it acts when the statement runs, which is what
    tells it apart from `quit`: everything earlier on its line has
    already printed by then.
    """


def runtime_line(kind: str, reason: str) -> str:
    """GNU's stderr line for a non-fatal runtime error or warning.

    Args:
        kind (str): `error` or `warning`.
        reason (str): the reason text, e.g. `Divide by zero`.

    Returns:
        str: the full line, without its newline.
    """
    return f"Runtime {kind} (func=(main), adr={constants.RUNTIME_ERROR_ADDR}): {reason}"


def runtime_error_line(reason: str) -> str:
    """GNU's stderr line for a non-fatal runtime error.

    Args:
        reason (str): the reason text, e.g. `Divide by zero`.

    Returns:
        str: the full line, without its newline.
    """
    return runtime_line("error", reason)


def runtime_warning_line(reason: str) -> str:
    """GNU's stderr line for a clamped register value.

    Args:
        reason (str): the reason text, e.g. `obase too small, set to 2`.

    Returns:
        str: the full line, without its newline.
    """
    return runtime_line("warning", reason)


def parse_error_line(line: int, text: str) -> str:
    """GNU's stderr line for a parse diagnostic.

    Args:
        line (int): the input line, counted from 1 per invocation.
        text (str): the diagnostic body.

    Returns:
        str: the full line, without its newline.
    """
    return f"{constants.INPUT_NAME} {line}: {text}"
