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

from collections.abc import Sequence

from mirage.commands.spec.types import ValueType
from mirage.workspace.executor.builtins.condition.constants import (
    BINARY_OPS,
    FILE_PAIR_BINARY,
    FILE_UNARY,
)

# The names test's words are read under: ``test``, ``[`` (a command
# word, as in ``command [ -e x ]``, or the shell's own ``[ ]``) and the
# leaves of ``[[ ]]``.
TEST_NAMES = frozenset({"test", "[", "[["})
# The words that begin a test of their own inside a test's argv: test's
# connectives, and ``[[``'s, which a line's reader keeps as words.
_OPENERS = frozenset({"!", "(", "-a", "-o", "&&", "||"})
# The words that end one.
_CLOSERS = frozenset({")", "-a", "-o", "&&", "||"})


def file_operands(words: Sequence[str]) -> list[ValueType | None]:
    """Which of a test's words name a file, as the kinds a classifier
    reads: the operand of a file operator (``-e x``) and both sides of
    ``-nt``, ``-ot`` and ``-ef`` are paths, however they are spelled, so
    a relative name a rule covers is judged as ``stat`` judges it; every
    other word is left to the shape rules. A file operator that is the
    left operand of a binary one (``[ -e = x ]``) compares as a string,
    as test reads it.

    Args:
        words (Sequence[str]): the test's words after its name, ``]``
            included for ``[``.
    """
    kinds: list[ValueType | None] = [None] * len(words)
    for i, word in enumerate(words):
        if word in FILE_PAIR_BINARY and 0 < i < len(words) - 1:
            kinds[i - 1] = kinds[i + 1] = "path"
        elif (
            word in FILE_UNARY
            and i + 1 < len(words)
            and (i == 0 or words[i - 1] in _OPENERS)
            and not _left_operand(words, i)
        ):
            kinds[i + 1] = "path"
    return kinds


def _left_operand(words: Sequence[str], i: int) -> bool:
    """Whether the word at ``i`` is the left operand of a binary test.

    Args:
        words (Sequence[str]): the test's words.
        i (int): the word's index.
    """
    if i + 2 >= len(words) or words[i + 1] not in BINARY_OPS:
        return False
    return i + 3 == len(words) or words[i + 3] in _CLOSERS | {"]"}
