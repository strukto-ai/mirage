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

from dataclasses import dataclass
from typing import NamedTuple


@dataclass(frozen=True)
class SyntaxDiagnostic:
    """What a line's syntax check refuses, in bash's words.

    Args:
        offending (str): the text bash names, empty at the end of input.
        message (str): the diagnostic lines, each ending in a newline.
        status (int): the status the line is refused with.
    """

    offending: str
    message: str
    status: int = 2


class ReaderToken(NamedTuple):
    """One token the line reader read.

    Args:
        kind (str): what it is (``word``, ``op``, ``newline``, ...).
        text (str): its text as written.
        start (int): where it starts in the line.
        end (int): where it ends.
        plain (bool): a word read literally, with no quote, escape,
            substitution, subscript or array in it.
        assign (bool): a word spelling an assignment, a name then ``=``.
    """

    kind: str
    text: str
    start: int
    end: int
    plain: bool = False
    assign: bool = False


class ReaderHeredoc(NamedTuple):
    """A heredoc the reader owes a body for.

    Args:
        at (int): where its ``<<`` stands.
        delimiter (str): the word that ends the body, quotes removed.
        strip (bool): ``<<-``, which strips leading tabs.
        quoted (bool): the delimiter was quoted, so the body is literal.
    """

    at: int
    delimiter: str
    strip: bool
    quoted: bool


# Where the line reader stands, to return to after a lookahead: its offset,
# the token it peeked (where, in which mode), the heredocs it owes, how many
# of those came out of a substitution, and whether the command before was
# compound, so the next token reads as one where a command starts.
ReaderState = tuple[
    int,
    tuple[int, int, ReaderToken] | None,
    tuple[ReaderHeredoc, ...],
    int,
    bool,
]
