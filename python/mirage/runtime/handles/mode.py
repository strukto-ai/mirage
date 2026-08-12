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

from mirage.runtime.handles.constants import MODE_BASES, MODE_CHARS


@dataclass(frozen=True, slots=True)
class OpenMode:
    """What an fopen-style mode string says about a handle.

    One vocabulary for every dialect that opens by mode: quickjs's
    ``std.open`` and monty's ``path_open`` pass these strings verbatim,
    ``MirageFile`` takes one from embedding code, and preview1's
    oflags/rights/fdflags translate onto the same facts in
    ``WasiFs.path_open``.

    Args:
        readable (bool): the handle may read (r, +).
        writable (bool): the handle may mutate its buffer (w, a, x, +).
        truncate (bool): opening discards existing content (w).
        append (bool): the position starts at the end (a).
        create (bool): a missing file is created (w, a, x).
        exclusive (bool): an existing file refuses the open (x).
        binary (bool): the handle carries bytes, not text (b).
    """

    readable: bool
    writable: bool
    truncate: bool
    append: bool
    create: bool
    exclusive: bool
    binary: bool


def parse_mode(mode: str) -> OpenMode:
    """Read an fopen-style mode string into its facts, validating it.

    The rule is CPython's, the stricter of the two parsers this
    replaced — one base, at most one each of ``+``, ``b``, ``t``, and
    never ``b`` together with ``t`` — widened by one C-dialect
    spelling: ``wx``, fopen's exclusive create, which CPython spells
    as a bare ``x``. Both dialects open by mode through this one
    parser, so it accepts the union. A guest engine that tolerates
    looser spellings still (C fopen reads ``rr`` as ``r``) renders
    this refusal in its own dialect at its own boundary.

    Args:
        mode (str): the mode as the caller spelled it (``r``, ``w+b``,
            ``a``, ``wx``, ...).

    Raises:
        ValueError: the mode does not parse, in CPython's own wording.
    """
    if (not mode or any(char not in MODE_CHARS for char in mode)
            or any(mode.count(char) > 1
                   for char in MODE_CHARS) or ("b" in mode and "t" in mode)
            or set(mode) & set("rwax") not in MODE_BASES):
        raise ValueError(f"invalid mode: {mode!r}")
    plus = "+" in mode
    return OpenMode(
        readable="r" in mode or plus,
        writable="r" not in mode or plus,
        truncate="w" in mode,
        append="a" in mode,
        create=any(char in mode for char in "wax"),
        exclusive="x" in mode,
        binary="b" in mode,
    )
