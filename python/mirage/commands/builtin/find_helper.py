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

import time

from mirage.commands.errors import FindParseError


def _parse_depth(value: str, flag: str) -> int:
    try:
        return int(value)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{value}' to '{flag}'") from None


def _parse_size(spec: str) -> tuple[int | None, int | None]:
    # GNU rounds the file size up to whole units before comparing, and
    # +N / -N are strict: +N keeps ceil(size/unit) > N, -N keeps
    # ceil(size/unit) < N, N alone keeps ceil(size/unit) == N. Expressed
    # as inclusive byte bounds: +N -> [N*unit + 1, inf), -N ->
    # [0, (N-1)*unit], N -> [(N-1)*unit + 1, N*unit].
    suffixes = {"c": 1, "k": 1024, "M": 1024**2, "G": 1024**3}
    if spec.startswith(("+", "-")):
        raw = spec[1:]
    else:
        raw = spec
    digits = raw.rstrip("ckMG")
    if not digits:
        raise FindParseError(f"find: invalid argument '{spec}' to '-size'")
    mult = suffixes.get(raw[-1], 1)
    try:
        n = int(digits)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-size'") from None
    if spec.startswith("+"):
        return n * mult + 1, None
    if spec.startswith("-"):
        return None, (n - 1) * mult
    return (n - 1) * mult + 1, n * mult


def _parse_mtime(spec: str) -> tuple[float | None, float | None]:
    now = time.time()
    day = 86400
    try:
        n = int(spec.lstrip("+-"))
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-mtime'") from None
    if spec.startswith("+"):
        return None, now - n * day
    if spec.startswith("-"):
        return now - n * day, None
    return now - (n + 1) * day, now - n * day
