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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field


@dataclass(slots=True)
class ShellArray:
    """An indexed array, as bash keeps one: only its assigned elements,
    by index, in index order. ``a[1000000000]=x`` holds one element, and
    an index no write reached, or ``unset`` cleared, is no element at
    all: it does not count toward ``${#a[@]}`` or expand in ``${a[@]}``.
    Mirrors TypeScript's ``ShellArray``.

    Args:
        elements (dict[int, str]): index to value, in index order.
    """

    elements: dict[int, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.elements)

    def copy(self) -> "ShellArray":
        """A copy a write to which leaves this one as it is."""
        return ShellArray(dict(self.elements))


def keyed_word(word: str) -> tuple[str, str] | None:
    """Split one ``[key]=value`` literal element, None for a plain word.

    The split lands on the first ``]=``, which is where bash finds it
    after quote removal; a key that itself holds ``]=`` needed quoting
    in bash too and is the one spelling this cannot recover.

    Args:
        word (str): one expanded array-literal word.
    """
    if not word.startswith("["):
        return None
    pos = word.find("]=", 1)
    if pos <= 1:
        return None
    return word[1:pos], word[pos + 2 :]


async def build_indexed_literal(
    base: ShellArray | None,
    words: list[str],
    append: bool,
    index_of: Callable[[str], Awaitable[int]],
) -> ShellArray:
    """The indexed array a compound literal produces.

    A ``[i]=v`` element places at ``i`` and moves the cursor past it, a
    plain word continues from the cursor, and a repeated index keeps
    the last value, which is GNU's ``([3]=x y [1]=z)`` giving
    ``([1]="z" [3]="x" [4]="y")``. ``+=`` starts the cursor at the
    extent instead of replacing.

    Args:
        base (ShellArray | None): the existing array, for ``+=``.
        words (list[str]): the expanded element words.
        append (bool): extend rather than replace.
        index_of (Callable[[str], Awaitable[int]]): arithmetic subscript
            resolver; async because a subscript may assign, and the
            assignment lands through the session view.
    """
    arr = base.copy() if append and base is not None else ShellArray()
    cursor = array_extent(arr) if append else 0
    for word in words:
        keyed = keyed_word(word)
        if keyed is not None:
            idx = await index_of(keyed[0])
            if idx < 0:
                idx += array_extent(arr)
            if idx < 0:
                continue
            array_set(arr, idx, keyed[1])
            cursor = idx + 1
        else:
            array_set(arr, cursor, word)
            cursor += 1
    return arr


def build_assoc_literal(
    base: dict[str, str] | None, words: list[str], append: bool
) -> tuple[dict[str, str], list[str]]:
    """The associative array a compound literal produces.

    The first word picks the grammar, as GNU does: a ``[key]=value``
    first word makes every plain word an error (reported back for the
    caller to render in bash's must-use-subscript voice), while a plain
    first word reads the whole list as alternating keys and values,
    ``[a]=1`` spellings included, literally. An odd pair list stores
    the last key with an empty value. A repeated key keeps the last
    value; ``+=`` merges over the existing map instead of replacing.

    Args:
        base (dict[str, str] | None): the existing map, for ``+=``.
        words (list[str]): the expanded element words.
        append (bool): merge rather than replace.

    Returns:
        tuple[dict[str, str], list[str]]: the resulting map and the
        plain words a keyed-form literal refused.
    """
    out = dict(base) if append and base is not None else {}
    if not words:
        return out, []
    if keyed_word(words[0]) is None:
        for i in range(0, len(words), 2):
            out[words[i]] = words[i + 1] if i + 1 < len(words) else ""
        return out, []
    errors: list[str] = []
    for word in words:
        keyed = keyed_word(word)
        if keyed is None:
            errors.append(word)
            continue
        out[keyed[0]] = keyed[1]
    return out, errors


def make_array(values: list[str]) -> ShellArray:
    """Build a dense array from consecutive values.

    Args:
        values (list[str]): the element values, starting at index 0.
    """
    return ShellArray(dict(enumerate(values)))


def array_extent(arr: ShellArray) -> int:
    """Return one past the highest assigned index, which is what bash
    resolves a negative subscript against.

    Args:
        arr (ShellArray): the array.
    """
    return next(reversed(arr.elements)) + 1 if arr.elements else 0


def array_get(arr: ShellArray, idx: int) -> str:
    """Return the element at ``idx``, or the empty string for an index
    that holds none.

    Args:
        arr (ShellArray): the array.
        idx (int): a non-negative index.
    """
    return arr.elements.get(idx, "")


def array_set(arr: ShellArray, idx: int, value: str) -> None:
    """Assign ``value`` at ``idx``, keeping the elements in index order.

    Args:
        arr (ShellArray): the array, mutated in place.
        idx (int): a non-negative index.
        value (str): the element value.
    """
    elements = arr.elements
    ordered = idx in elements or not elements or idx > next(reversed(elements))
    elements[idx] = value
    if not ordered:
        arr.elements = dict(sorted(elements.items()))


def array_with(arr: ShellArray, idx: int, value: str) -> ShellArray:
    """A copy of ``arr`` with ``value`` assigned at ``idx``.

    What a writer hands the session view: the session view speaks in
    whole variables, so an element write states itself as the array the
    write produces. Building it on a copy is what keeps a refusal from
    leaving the element applied.

    Args:
        arr (ShellArray): the array to copy.
        idx (int): a non-negative index.
        value (str): the element value.
    """
    updated = arr.copy()
    array_set(updated, idx, value)
    return updated


def array_unset(arr: ShellArray, idx: int) -> None:
    """Clear one element, keeping the indices of the elements after it.

    The extent stays at one past the highest assigned index, matching
    how bash resolves ``arr[-1]``.

    Args:
        arr (ShellArray): the array, mutated in place.
        idx (int): a non-negative index.
    """
    arr.elements.pop(idx, None)
