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
