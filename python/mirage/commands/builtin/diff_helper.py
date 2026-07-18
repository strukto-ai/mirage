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

import difflib

from mirage.commands.builtin.diff_types import DiffOpTag


def _ed_script(a_lines: list[str], b_lines: list[str]) -> list[str]:
    sm = difflib.SequenceMatcher(None, a_lines, b_lines)
    edits: list[str] = []
    for tag, i1, i2, j1, j2 in reversed(sm.get_opcodes()):
        if tag == DiffOpTag.EQUAL:
            continue
        if tag == DiffOpTag.DELETE:
            addr = f"{i1 + 1},{i2}" if i2 - i1 > 1 else f"{i1 + 1}"
            edits.append(f"{addr}d\n")
        elif tag == DiffOpTag.INSERT:
            edits.append(f"{i1}a\n")
            for line in b_lines[j1:j2]:
                edits.append(line if line.endswith("\n") else line + "\n")
            edits.append(".\n")
        elif tag == DiffOpTag.REPLACE:
            addr = f"{i1 + 1},{i2}" if i2 - i1 > 1 else f"{i1 + 1}"
            edits.append(f"{addr}c\n")
            for line in b_lines[j1:j2]:
                edits.append(line if line.endswith("\n") else line + "\n")
            edits.append(".\n")
    return edits


def _addr(i1: int, i2: int) -> str:
    return f"{i1 + 1},{i2}" if i2 - i1 > 1 else f"{i1 + 1}"


def _addr_b(j1: int, j2: int) -> str:
    if j2 - j1 > 1:
        return f"{j1 + 1},{j2}"
    if j2 - j1 == 1:
        return f"{j1 + 1}"
    return f"{j1}"


def _normal_diff(a_lines: list[str], b_lines: list[str]) -> list[str]:
    sm = difflib.SequenceMatcher(None, a_lines, b_lines)
    out: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == DiffOpTag.EQUAL:
            continue
        if tag == DiffOpTag.DELETE:
            out.append(f"{_addr(i1, i2)}d{j1}\n")
            for line in a_lines[i1:i2]:
                out.append("< " +
                           (line if line.endswith("\n") else line + "\n"))
        elif tag == DiffOpTag.INSERT:
            out.append(f"{i1}a{_addr_b(j1, j2)}\n")
            for line in b_lines[j1:j2]:
                out.append("> " +
                           (line if line.endswith("\n") else line + "\n"))
        elif tag == DiffOpTag.REPLACE:
            out.append(f"{_addr(i1, i2)}c{_addr_b(j1, j2)}\n")
            for line in a_lines[i1:i2]:
                out.append("< " +
                           (line if line.endswith("\n") else line + "\n"))
            out.append("---\n")
            for line in b_lines[j1:j2]:
                out.append("> " +
                           (line if line.endswith("\n") else line + "\n"))
    return out
