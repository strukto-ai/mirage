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

import fnmatch as _stdlib_fnmatch


def _normalize_negation(pattern: str) -> str:
    """Rewrite ``[^...]`` class openers to stdlib's ``[!...]`` form.

    bash and glibc fnmatch negate a character class on both ``!`` and
    ``^``; CPython's fnmatch treats a leading ``^`` as a literal class
    member. Deliberate divergence from CPython: a ``[`` inside a class
    body followed by ``^`` (e.g. ``[a[^b]``) is also rewritten, which
    bash would keep literal — patterns that pathological are not worth
    a full parser.

    Args:
        pattern (str): shell glob pattern.
    """
    if "[^" not in pattern:
        return pattern
    out: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        out.append(ch)
        if ch == "[" and i + 1 < n and pattern[i + 1] == "^":
            out.append("!")
            i += 2
            continue
        i += 1
    return "".join(out)


def fnmatch(name: str, pattern: str) -> bool:
    """Case-sensitive shell glob match with bash class negation.

    Mirrors the TypeScript ``utils/fnmatch.ts`` port: always
    case-sensitive, and ``[^...]`` negates like ``[!...]`` (bash/glibc
    semantics, unlike CPython's fnmatch).

    Args:
        name (str): string to test.
        pattern (str): shell glob pattern.
    """
    return _stdlib_fnmatch.fnmatchcase(name, _normalize_negation(pattern))
