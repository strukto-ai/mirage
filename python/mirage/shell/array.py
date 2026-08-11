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

ShellArray = list[str | None]


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


def array_append(arr: ShellArray, values: list[str]) -> None:
    """Append values after the highest assigned index, as ``arr+=(...)``.

    Args:
        arr (ShellArray): the array, mutated in place.
        values (list[str]): the element values to add.
    """
    arr.extend(values)


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
