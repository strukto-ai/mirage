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

from mirage.rs.stream import open_stream

# A step of a line diff: difflib's tag over a range of each side's lines.
Opcode = tuple[str, int, int, int, int]


def line_opcodes(old: Sequence[bytes], new: Sequence[bytes]) -> list[Opcode]:
    """The steps from one side's lines to the other's, as git diff takes
    them: Myers' algorithm, each changed run then placed by git's default
    indentation heuristic (the ``git_diff`` stream). Mirrors TS
    ``lineOpcodes``.

    Args:
        old (Sequence[bytes]): the old side's lines, newlines kept.
        new (Sequence[bytes]): the new side's lines, newlines kept.
    """
    before = b"".join(old)
    stream = open_stream("git_diff", {"before": len(before)})
    try:
        out = (
            stream.feed(before) + stream.feed(b"".join(new)) + stream.finish()
        )
    finally:
        stream.close()
    codes: list[Opcode] = []
    for line in out.decode().splitlines():
        tag, i1, i2, j1, j2 = line.split()
        codes.append((tag, int(i1), int(i2), int(j1), int(j2)))
    return codes


def group_opcodes(codes: Sequence[Opcode], n: int) -> list[list[Opcode]]:
    """The hunks a patch prints: the changes with ``n`` lines of context
    around each, a run of more than ``2n`` unchanged lines splitting two.
    Mirrors TS ``groupOpcodes``.

    Args:
        codes (Sequence[Opcode]): the diff's steps, in order.
        n (int): the lines of context.
    """
    if not codes:
        return []
    steps = list(codes)
    tag, i1, i2, j1, j2 = steps[0]
    if tag == "equal":
        steps[0] = (tag, max(i1, i2 - n), i2, max(j1, j2 - n), j2)
    tag, i1, i2, j1, j2 = steps[-1]
    if tag == "equal":
        steps[-1] = (tag, i1, min(i2, i1 + n), j1, min(j2, j1 + n))
    groups: list[list[Opcode]] = []
    current: list[Opcode] = []
    for tag, i1, i2, j1, j2 in steps:
        if tag == "equal" and i2 - i1 > 2 * n:
            current.append((tag, i1, min(i2, i1 + n), j1, min(j2, j1 + n)))
            groups.append(current)
            current = [(tag, max(i1, i2 - n), i2, max(j1, j2 - n), j2)]
            continue
        current.append((tag, i1, i2, j1, j2))
    if current and not (len(current) == 1 and current[0][0] == "equal"):
        groups.append(current)
    return groups
