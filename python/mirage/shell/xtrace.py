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

import re
from collections.abc import Iterable

from mirage.shell.bytes import encode_text

_UNSAFE = re.compile(r"[^\w@%+=:,./-]")


def _quoted(word: str) -> str:
    return "'" + word.replace("'", "'\\''") + "'"


def _trace_quote(word: str) -> str:
    """One word as bash's trace writes it: bare when every character is
    safe, else single-quoted with each ``'`` spelled ``'\\''``.

    Args:
        word (str): the expanded word.
    """
    if not word:
        return "''"
    return _quoted(word) if _UNSAFE.search(word) else word


def trace_command(words: Iterable[str]) -> bytes:
    """Render one `set -x` trace line for an expanded simple command.

    Args:
        words (Iterable[str]): expanded command words, name first.
    """
    return encode_text("+ " + " ".join(map(_trace_quote, words)) + "\n")


def trace_assignment(key: str, val: str, append: bool) -> bytes:
    """Render one `set -x` trace line for a scalar assignment.

    Args:
        key (str): variable name.
        val (str): expanded value.
        append (bool): `+=` form instead of `=`.
    """
    op = "+=" if append else "="
    return encode_text(f"+ {key}{op}{_trace_quote(val) if val else ''}\n")


def trace_array(key: str, items: Iterable[str], append: bool) -> bytes:
    """Render the trace line a declaration writes for an array operand:
    every element single-quoted, a keyed one as ``['k']='v'``.

    Args:
        key (str): variable name.
        items (Iterable[str]): the expanded element words.
        append (bool): `+=` form instead of `=`.
    """
    shown = []
    for item in items:
        sub, eq, val = item[1:].partition("]=")
        keyed = item.startswith("[") and eq
        shown.append(
            f"[{_quoted(sub)}]={_quoted(val)}" if keyed else _quoted(item)
        )
    op = "+=" if append else "="
    return encode_text(f"+ {key}{op}({' '.join(shown)})\n")
