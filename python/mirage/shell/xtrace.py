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

import shlex
from collections.abc import Iterable

from mirage.shell.bytes import encode_text


def trace_command(words: Iterable[str]) -> bytes:
    """Render one `set -x` trace line for an expanded simple command.

    Words are shown post-expansion with bash's `+ ` prefix; words that
    need it are single-quoted like bash's trace output.

    Args:
        words (Iterable[str]): expanded command words, name first.
    """
    return encode_text("+ " + shlex.join(words) + "\n")


def trace_assignment(key: str, val: str, append: bool) -> bytes:
    """Render one `set -x` trace line for a scalar assignment.

    Args:
        key (str): variable name.
        val (str): expanded value.
        append (bool): `+=` form instead of `=`.
    """
    op = "+=" if append else "="
    return encode_text(f"+ {key}{op}{shlex.quote(val) if val else ''}\n")
