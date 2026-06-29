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

from mirage.commands.builtin.utils.types import _ReadBytes

_NUMBER_RE = re.compile(r"^[+-]?\d+$")


def number_flag_error(cmd: str, n_raw: str | None,
                      c_raw: str | None) -> str | None:
    if n_raw is not None and not _NUMBER_RE.match(n_raw):
        return f"{cmd}: invalid number of lines: '{n_raw}'\n"
    if c_raw is not None and not _NUMBER_RE.match(c_raw):
        return f"{cmd}: invalid number of bytes: '{c_raw}'\n"
    return None


def _parse_n(n: str | None) -> tuple[int, bool]:
    if n is None:
        return 10, False
    if n.startswith("+"):
        return int(n[1:]), True
    return int(n), False


def tail_bytes(data: bytes,
               lines: int = 10,
               bytes_mode: int | None = None,
               plus_mode: bool = False) -> bytes:
    if bytes_mode is not None:
        return data[-bytes_mode:] if bytes_mode else b""
    all_lines = data.split(b"\n")
    if all_lines and all_lines[-1] == b"":
        all_lines = all_lines[:-1]
    if plus_mode:
        selected = all_lines[lines - 1:]
    else:
        selected = all_lines[-lines:]
    result = b"\n".join(selected)
    if data.endswith(b"\n") and selected:
        result += b"\n"
    return result


def tail(
    read_bytes: _ReadBytes,
    path: str,
    lines: int = 10,
    bytes_mode: int | None = None,
    plus_mode: bool = False,
) -> bytes:
    data = read_bytes(path)
    return tail_bytes(data, lines, bytes_mode, plus_mode=plus_mode)
