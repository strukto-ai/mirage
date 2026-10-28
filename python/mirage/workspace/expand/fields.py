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

from collections.abc import Iterable, Sequence

from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import join_bytes
from mirage.shell.constants import IFS_DEFAULT
from mirage.utils.glob_walk import mark_globs, unmark_globs
from mirage.workspace.expand.types import Chunk, FieldBreak, Piece


def ifs_joiner(ifs: str | None) -> str:
    """What ``"$*"`` joins the parameters with.

    The first character of IFS, a space when IFS is unset and nothing
    when it is empty.

    Args:
        ifs (str | None): the IFS in scope, None when unset.
    """
    return " " if ifs is None else ifs[:1]


def value_piece(text: str, quoted: bool) -> Piece:
    """An expansion's value as a piece of the word it sits in.

    Inside double quotes the value is literal: its glob characters are
    marked and it never splits. Unquoted, it splits and globs.

    Args:
        text (str): the expanded value.
        quoted (bool): whether the expansion sits inside double quotes.
    """
    return Piece(mark_globs(text), False) if quoted else Piece(text, True)


async def splat_chunks(
    elements: Sequence[str], joiner: str, quoted: bool
) -> list[Chunk]:
    """The elements of a splat, a field boundary between each two. A
    long splat yields between its elements, so a cancel or the line's
    deadline lands mid-list.

    Args:
        elements (Sequence[str]): the element values, in order.
        joiner (str): what a boundary reads as where nothing splits.
        quoted (bool): whether the splat sits inside double quotes.
    """
    out: list[Chunk] = []
    budget = YieldBudget()
    for index, element in enumerate(elements):
        if index:
            out.append(FieldBreak(joiner))
        out.append(value_piece(element, quoted))
        await budget.run()
    return out


def join_chunks(chunks: Iterable[Chunk]) -> str:
    """The text of a word where no field splitting happens.

    An assignment, a ``case`` word, ``[[ ]]`` and a here-string read
    the pieces as one string, a splat boundary as its joiner.

    Args:
        chunks (Iterable[Chunk]): the word's pieces.
    """
    return join_bytes(
        "".join(c.text if isinstance(c, Piece) else c.joiner for c in chunks)
    )


def chunks_text(chunks: Iterable[Chunk]) -> str:
    """The literal text of a word's pieces, glob marks removed.

    Args:
        chunks (Iterable[Chunk]): the word's pieces.
    """
    return unmark_globs(join_chunks(chunks))


async def split_fields(chunks: Iterable[Chunk], ifs: str | None) -> list[str]:
    """Split a word's pieces into fields on IFS, as bash does.

    Only split pieces are split. An IFS whitespace run delimits a field
    and is dropped at either end; any other IFS character, with the
    whitespace around it, delimits exactly one field, so ``a,,b`` under
    ``IFS=,`` is three fields and ``a,`` is one. A splat boundary always
    ends a field. A field exists once literal or quoted text, or a
    non-empty split, opened it, so an unquoted expansion that comes
    back empty is no word at all while ``""`` is an empty one. A value
    that splits into many fields yields between them, so a cancel or
    the line's deadline lands mid-split.

    Args:
        chunks (Iterable[Chunk]): the word's pieces.
        ifs (str | None): the IFS in scope, None when unset.
    """
    separators = IFS_DEFAULT if ifs is None else ifs
    blanks = "".join(c for c in IFS_DEFAULT if c in separators)
    fields: list[str] = []
    current: list[str] = []
    started = False
    budget = YieldBudget()
    for chunk in chunks:
        if isinstance(chunk, FieldBreak):
            if started:
                fields.append("".join(current))
            current, started = [], False
            continue
        text = chunk.text
        if not chunk.split or not separators:
            current.append(text)
            started = started or not chunk.split or bool(text)
            continue
        index = 0
        while index < len(text):
            end = index
            while end < len(text) and text[end] not in separators:
                end += 1
            if end > index:
                current.append(text[index:end])
                started = True
                index = end
                continue
            while end < len(text) and text[end] in blanks:
                end += 1
            hard = end < len(text) and text[end] in separators
            if hard:
                end += 1
                while end < len(text) and text[end] in blanks:
                    end += 1
            if started or hard:
                fields.append("".join(current))
                await budget.run()
            current, started = [], False
            index = end
    if started:
        fields.append("".join(current))
    return [join_bytes(field) for field in fields]
