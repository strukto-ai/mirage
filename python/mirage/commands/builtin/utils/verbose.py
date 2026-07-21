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

from mirage.types import PathSpec


def removal_lines(entries: list[tuple[PathSpec, bool]]) -> list[str]:
    """Render GNU ``rm -v`` lines for a removed tree, deepest entry first.

    GNU prints one line per removed entry in a depth-first, children-first
    walk: ``removed 'file'`` for files and ``removed directory 'dir'`` for
    directories. Backends list children in their own order, so entries are
    sorted by virtual path and emitted in reverse: a lexical path sort is a
    pre-order walk (``/`` sorts before any name char, so a directory always
    precedes its children), and its reverse is therefore a valid children-
    first order. This is deterministic across every backend; it matches GNU
    exactly on a single-child chain and reorders only sibling entries whose
    relative order GNU itself leaves to readdir.

    Args:
        entries (list[tuple[PathSpec, bool]]): ``(path, is_dir)`` pairs from
            ``walk``; order is ignored.

    Returns:
        list[str]: One verbose line per entry, children before parents.
    """
    ordered = sorted(entries, key=lambda e: e[0].virtual, reverse=True)
    lines: list[str] = []
    for path, is_dir in ordered:
        # Object stores hand back directory paths with a trailing slash; GNU
        # never prints one, so normalize (root "/" excepted).
        virtual = path.virtual.rstrip("/") or "/"
        if is_dir:
            lines.append(f"removed directory '{virtual}'")
        else:
            lines.append(f"removed '{virtual}'")
    return lines


__all__ = ["removal_lines"]
