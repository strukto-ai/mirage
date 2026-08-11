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

from typing import Literal

FlushKind = Literal["append", "write"]

# The lowest offset a handle has written at, before it writes anything.
# A sentinel rather than None because every write takes the minimum of
# it and the new offset, and "nothing yet" has to lose that comparison.
NO_WRITE = 2**63 - 1


def plan_flush(base_len: int, low_write: int,
               buf: bytes | bytearray) -> tuple[FlushKind, bytes]:
    """Decide what a closing whole-file buffer owes the mount.

    Every encoder buffers a whole file and has to answer the same
    question at close: did this handle only add to the end, or did it
    rewrite what was already there? Only the first can travel as a
    delta, and answering "write" always is what makes an append loop
    quadratic.

    Args:
        base_len (int): length the file had when the handle opened.
        low_write (int): lowest offset this handle wrote at, or the
            NO_WRITE sentinel when it never wrote.
        buf (bytes | bytearray): the handle's whole buffer.

    Returns:
        tuple[FlushKind, bytes]: ("append", tail) when the handle only
        extended the file, else ("write", whole buffer).
    """
    if base_len > 0 and low_write >= base_len and len(buf) >= base_len:
        return "append", bytes(buf[base_len:])
    return "write", bytes(buf)
