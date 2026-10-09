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

from mirage.shell.parse.types import ReaderToken


class ReaderRefusal(Exception):
    """An error bash reports while reading a line, in its own words.

    Args:
        lines (list[str]): the diagnostic lines, without a prefix.
        status (int): the status bash refuses the line with.
        offending (str): the text bash names, empty at the end of input.
        end (int): where that text ends in the line.
        eof (bool): the input ended inside a construct.
    """

    def __init__(
        self,
        lines: list[str],
        status: int,
        offending: str,
        end: int,
        eof: bool,
    ) -> None:
        super().__init__(lines)
        self.lines = lines
        self.status = status
        self.offending = offending
        self.end = end
        self.eof = eof


class TestFailure(Exception):
    """A ``[[ ]]`` expression bash refuses, before the line naming where.

    Args:
        lines (list[str]): the conditional's own diagnostic lines.
        token (ReaderToken): the token it stopped at.
        eof (bool): the input ended inside the expression.
    """

    def __init__(
        self, lines: list[str], token: ReaderToken, eof: bool = False
    ) -> None:
        super().__init__(lines)
        self.lines = lines
        self.token = token
        self.eof = eof
