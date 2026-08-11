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

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class OpenMode:
    """What an fopen-style mode string says about a handle.

    One vocabulary for every dialect that opens by mode: quickjs's
    ``std.open`` and monty's ``path_open`` pass these strings verbatim,
    and preview1's oflags/rights/fdflags translate onto the same five
    facts in ``WasiFs.path_open``.

    Args:
        writable (bool): the handle may mutate its buffer (w, a, x, +).
        truncate (bool): opening discards existing content (w).
        append (bool): the position starts at the end (a).
        create (bool): a missing file is created (w, a, x).
        exclusive (bool): an existing file refuses the open (x).
    """

    writable: bool
    truncate: bool
    append: bool
    create: bool
    exclusive: bool


def parse_mode(mode: str) -> OpenMode:
    """Read an fopen-style mode string into its five facts.

    Args:
        mode (str): the mode as the guest spelled it (``r``, ``w+b``,
            ``a``, ...); unknown letters are ignored, matching fopen.
    """
    return OpenMode(
        writable=any(c in mode for c in "wax+"),
        truncate="w" in mode,
        append="a" in mode,
        create=any(c in mode for c in "wax"),
        exclusive="x" in mode,
    )
