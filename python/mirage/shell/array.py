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

ShellArray = list[str | None]


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
    return word[1:pos], word[pos + 2:]


async def build_indexed_literal(
        base: ShellArray | None, words: list[str], append: bool,
        index_of: Callable[[str], Awaitable[int]]) -> ShellArray:
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
            assignment lands through the session door.
    """
    arr: ShellArray = list(base) if append and base is not None else []
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


def build_assoc_literal(base: dict[str, str] | None, words: list[str],
                        append: bool) -> tuple[dict[str, str], list[str]]:
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
    return list(values)


def array_extent(arr: ShellArray) -> int:
    """Return one past the highest assigned index, which is what bash
    resolves a negative subscript against.

    Args:
        arr (ShellArray): the array.
    """
    return len(arr)


def array_values(arr: ShellArray) -> list[str]:
    """Return the assigned values in index order, skipping holes.

    Args:
        arr (ShellArray): the array.
    """
    return [v for v in arr if v is not None]


def array_indices(arr: ShellArray) -> list[int]:
    """Return the assigned indices in order, skipping holes.

    Args:
        arr (ShellArray): the array.
    """
    return [i for i, v in enumerate(arr) if v is not None]


def array_count(arr: ShellArray) -> int:
    """Return the number of assigned elements, which is ``${#arr[@]}``.

    Args:
        arr (ShellArray): the array.
    """
    return sum(1 for v in arr if v is not None)


def array_has(arr: ShellArray, idx: int) -> bool:
    """Report whether ``idx`` holds an assigned element.

    Args:
        arr (ShellArray): the array.
        idx (int): a non-negative index.
    """
    return 0 <= idx < len(arr) and arr[idx] is not None


def array_get(arr: ShellArray, idx: int) -> str:
    """Return the element at ``idx``, or the empty string for a hole or
    an out-of-range index.

    Args:
        arr (ShellArray): the array.
        idx (int): a non-negative index.
    """
    if not 0 <= idx < len(arr):
        return ""
    return arr[idx] or ""


def array_set(arr: ShellArray, idx: int, value: str) -> None:
    """Assign ``value`` at ``idx``, extending with holes as needed.

    Args:
        arr (ShellArray): the array, mutated in place.
        idx (int): a non-negative index.
        value (str): the element value.
    """
    while len(arr) <= idx:
        arr.append(None)
    arr[idx] = value


def array_with(arr: ShellArray, idx: int, value: str) -> ShellArray:
    """A copy of ``arr`` with ``value`` assigned at ``idx``.

    What a writer hands the session plane's door: the door speaks in
    whole variables, so an element write states itself as the array the
    write produces. Building it on a copy is what keeps a refusal from
    leaving the element applied.

    Args:
        arr (ShellArray): the array to copy.
        idx (int): a non-negative index.
        value (str): the element value.
    """
    updated = list(arr)
    array_set(updated, idx, value)
    return updated


def array_slice(arr: ShellArray, offset: int, length: int | None) -> list[str]:
    """Take the assigned elements from index ``offset`` on, in order.

    bash slices an indexed array by *subscript*, not by position among
    the assigned values: for ``a=([1]=b [3]=d [9]=j)``, ``${a[@]:2}`` is
    ``d j`` because it keeps every index >= 2. ``length`` then caps how
    many of those are taken. A negative offset counts back from the
    extent and yields nothing if it is still negative.

    Args:
        arr (ShellArray): the array.
        offset (int): the first subscript to keep, or a negative count
            back from the extent.
        length (int | None): how many elements to take; a negative value
            drops that many from the end.
    """
    if offset < 0:
        offset += array_extent(arr)
        if offset < 0:
            return []
    picked = [v for i, v in enumerate(arr) if v is not None and i >= offset]
    if length is None:
        return picked
    if length < 0:
        return picked[:max(0, len(picked) + length)]
    return picked[:length]


def array_unset(arr: ShellArray, idx: int) -> None:
    """Clear one element, keeping the indices of the elements after it.

    Trailing holes are dropped so the extent stays at one past the
    highest assigned index, matching how bash resolves ``arr[-1]``.

    Args:
        arr (ShellArray): the array, mutated in place.
        idx (int): a non-negative index.
    """
    if not 0 <= idx < len(arr):
        return
    arr[idx] = None
    while arr and arr[-1] is None:
        arr.pop()
