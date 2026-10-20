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
    FILE_PAIR_BINARY,
    FILE_UNARY,
)
from mirage.workspace.executor.builtins.condition.shape import (
    flat_leaves,
    flat_shape,
)
from mirage.workspace.executor.builtins.condition.types import (
    FlatBinary,
    FlatUnary,
)

# The names test's words are read under: ``test``, ``[`` (a command
# word, as in ``command [ -e x ]``, or the shell's own ``[ ]``) and the
# leaves of ``[[ ]]``.
TEST_NAMES = frozenset({"test", "[", "[["})


def file_operands(name: str, words: Sequence[str]) -> list[ValueType | None]:
    """Which of a test's words name a file, as the kinds a classifier
    reads, by test's own reading of them (``flat_shape``): the operand
    of a file operator (``-e x``) and both sides of ``-nt``, ``-ot`` and
    ``-ef`` are paths, however they are spelled, so a relative name a
    rule covers is judged as ``stat`` judges it; every other word is
    left to the shape rules.

    Args:
        name (str): ``test``, ``[`` or ``[[``.
        words (Sequence[str]): the test's words after its name: ``]``
            included for ``[``, one leaf's for ``[[``.
    """
    closed = name == "[" and bool(words) and words[-1] == "]"
    kinds: list[ValueType | None] = [None] * len(words)
    for leaf in flat_leaves(flat_shape(name, words[:-1] if closed else words)):
        if isinstance(leaf, FlatUnary) and leaf.op in FILE_UNARY:
            kinds[leaf.at] = "path"
        elif isinstance(leaf, FlatBinary) and leaf.op in FILE_PAIR_BINARY:
            kinds[leaf.left] = kinds[leaf.right] = "path"
    return kinds
