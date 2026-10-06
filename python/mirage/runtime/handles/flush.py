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

from mirage.runtime.handles.types import FlushStep


def plan_flush(
    *,
    base_len: int,
    runs: Sequence[tuple[int, bytes | bytearray]],
    cut: int | None,
    size: int,
    appending: bool,
) -> list[FlushStep]:
    """The ops that leave the mount holding what a closing handle holds.

    A handle keeps what it wrote as byte ranges, so it owes the mount
    those ranges and nothing it only read: another writer's bytes
    between them stay, a file the open created or emptied included. A
    cut goes first, then the ranges, then any growth past them; a lone
    range that starts where the file ended, or anything an append-mode
    handle wrote, goes as an append, which lands at the mount's own end.

    Args:
        base_len (int): the file's length when the handle opened it.
        runs (Sequence[tuple[int, bytes | bytearray]]): the written ranges as
            (offset, bytes), sorted and disjoint.
        cut (int | None): the shortest length a truncate left the
            stored bytes at, or None when nothing was truncated away.
        size (int): the file's length as the handle holds it.
        appending (bool): the handle was opened in append mode.
    """
    steps: list[FlushStep] = []
    end = base_len
    if cut is not None:
        steps.append(FlushStep("truncate", length=cut))
        end = cut
    if len(runs) == 1 and runs[0][0] == end and (end > 0 or appending):
        steps.append(FlushStep("append", data=bytes(runs[0][1])))
        end += len(runs[0][1])
    else:
        for offset, data in runs:
            steps.append(FlushStep("pwrite", data=bytes(data), offset=offset))
            end = max(end, offset + len(data))
    if size > end:
        steps.append(FlushStep("truncate", length=size))
    return steps
