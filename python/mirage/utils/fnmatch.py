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
import logging
import re
from collections.abc import Iterable, Iterator

from mirage.utils.posix import translate_bracket

logger = logging.getLogger(__name__)

QUOTED_CHARS = {chr(0xFDD0 + i): ch for i, ch in enumerate("*?[@+!()|")}
QUOTED_RE = re.compile("[\ufdd0-\ufdd8]")


class _Positions:
    """Immutable reachable positions as merged half-open intervals.

    A wildcard suffix occupies one interval instead of one integer per
    character. Memoized suffixes therefore share the same compact shape.

    Args:
        spans (Iterable[tuple[int, int]]): half-open position intervals.
    """

    def __init__(self, spans: Iterable[tuple[int, int]] = ()) -> None:
        merged: list[tuple[int, int]] = []
        for lo, hi in sorted(spans):
            if lo >= hi:
                continue
            if merged and lo <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(hi, merged[-1][1]))
            else:
                merged.append((lo, hi))
        self.spans = tuple(merged)

    def __bool__(self) -> bool:
        return bool(self.spans)

    def __iter__(self) -> Iterator[int]:
        for lo, hi in self.spans:
            yield from range(lo, hi)

    def contains(self, position: int) -> bool:
        return any(lo <= position < hi for lo, hi in self.spans)

    def union(self, other: "_Positions") -> "_Positions":
        return _Positions((*self.spans, *other.spans))

    def subtract(self, other: "_Positions") -> "_Positions":
        out: list[tuple[int, int]] = []
        j = 0
        for lo, hi in self.spans:
            while j < len(other.spans) and other.spans[j][1] <= lo:
                j += 1
            k, cursor = j, lo
            while k < len(other.spans) and other.spans[k][0] < hi:
                start, stop = other.spans[k]
                if cursor < start:
                    out.append((cursor, min(start, hi)))
                cursor = max(cursor, stop)
                k += 1
            if cursor < hi:
                out.append((cursor, hi))
        return _Positions(out)


class _Matcher:
    """Match extended groups by reachable character positions.

    Each group/position pair is evaluated once. Repetition visits each
    reachable position once, including alternatives that match nothing,
    so nested alternatives do not trigger regex backtracking.

    Deliberate GNU 5.2 divergence: empty subjects obey group composition.
    GNU's star fast path accepts ``*!(a)x`` but rejects
    ``*+([!a]|!([!a]))`` against empty text; this matcher requires the
    former's suffix and accepts the latter's nullable group.

    Args:
        name (str): text to match.
        pattern (str): glob with quoted characters encoded by glob_pattern.
        period (bool): require an explicit dot at a pathname's start.
        extglob (bool): recognize extended groups while reading the pattern.
    """

    def __init__(
        self,
        name: str,
        pattern: str,
        period: bool = False,
        extglob: bool = True,
    ) -> None:
        self.name = name
        self.pattern = pattern
        self.period = period and name.startswith(".")
        self.classes: dict[int, int] = {}
        self.groups: dict[int, tuple[int, tuple[tuple[int, int], ...]]] = {}
        self.memo: dict[tuple[int, int, int], _Positions] = {}
        stack: list[tuple[int, list[int]]] = []
        literal_depth: list[int] = []
        i = 0
        while i < len(pattern):
            c = pattern[i]
            if c == "[":
                j = i + 1
                if pattern[j : j + 1] in ("!", "^"):
                    j += 1
                if pattern[j : j + 1] == "]":
                    j += 1
                while j < len(pattern) and pattern[j] != "]":
                    close = (
                        pattern.find(":]", j + 2)
                        if pattern.startswith("[:", j)
                        else -1
                    )
                    j = close + 2 if close >= 0 else j + 1
                end = j if j < len(pattern) else -1
                if end >= 0:
                    self.classes[i] = end + 1
                    i = end + 1
                    continue
            if extglob and c in "@?*+!" and pattern[i + 1 : i + 2] == "(":
                stack.append((i, [i + 2]))
                literal_depth.append(0)
                i += 2
                continue
            if stack and c == "(":
                literal_depth[-1] += 1
            elif stack and c == ")" and literal_depth[-1]:
                literal_depth[-1] -= 1
            elif stack and c == "|" and not literal_depth[-1]:
                stack[-1][1].append(i + 1)
            elif stack and c == ")":
                opened, starts = stack.pop()
                literal_depth.pop()
                stops = [start - 1 for start in starts[1:]] + [i]
                self.groups[opened] = (i + 1, tuple(zip(starts, stops)))
            i += 1

    def matches(self) -> bool:
        if (
            not self.groups
            and "[:" not in self.pattern
            and not QUOTED_RE.search(self.pattern)
        ):
            return fnmatch(self.name, self.pattern, period=self.period)
        return self.ends(0, len(self.pattern), 0).contains(len(self.name))

    def ends(self, lo: int, hi: int, start: int) -> _Positions:
        """Every end position at which a pattern slice matches.

        Args:
            lo (int): start of the pattern slice.
            hi (int): end of the pattern slice.
            start (int): first character to match.
        """
        key = (lo, hi, start)
        if key in self.memo:
            return self.memo[key]
        positions = _Positions(((start, start + 1),))
        i = lo
        while i < hi and positions:
            c = self.pattern[i]
            group = self.groups.get(i)
            if group is not None and group[0] <= hi:
                end, branches = group
                reached = _Positions()
                for position in positions:
                    once = _Positions()
                    for a, b in branches:
                        once = once.union(self.ends(a, b, position))
                    if c == "!":
                        if self.period and position == 0:
                            continue
                        once = _Positions(
                            ((position, len(self.name) + 1),)
                        ).subtract(once)
                    reached = reached.union(once)
                if c in ("*", "?"):
                    reached = reached.union(positions)
                if c in ("*", "+"):
                    pending = list(reached)
                    while pending:
                        current = pending.pop()
                        for a, b in branches:
                            fresh = self.ends(a, b, current).subtract(reached)
                            if fresh:
                                reached = reached.union(fresh)
                                pending.extend(fresh)
                positions, i = reached, end
                continue
            if c == "*":
                if self.period:
                    positions = positions.subtract(_Positions(((0, 1),)))
                if not positions:
                    break
                positions = _Positions(
                    ((positions.spans[0][0], len(self.name) + 1),)
                )
                i += 1
                continue
            end = self.classes.get(i, i + 1)
            token = self.pattern[i:end]
            positions = _Positions(
                (position + 1, position + 2)
                for position in positions
                if position < len(self.name)
                and not (
                    self.period and position == 0 and (c == "?" or end > i + 1)
                )
                and (
                    _extended_class_matches(self.name[position], token)
                    if end > i + 1
                    else c == "?"
                    or QUOTED_CHARS.get(c, c) == self.name[position]
                )
            )
            i = end
        self.memo[key] = positions
        return positions


def _extended_class_matches(char: str, pattern: str) -> bool:
    if "[:" not in pattern and not QUOTED_RE.search(pattern):
        return fnmatch(char, pattern)
    out: list[str] = []
    source = "[^" + pattern[2:] if pattern.startswith("[!") else pattern
    try:
        translate_bracket(source, 0, out)
        expression = "".join(out)
        for mark, literal in QUOTED_CHARS.items():
            expression = expression.replace(mark, rf"\x{ord(literal):02x}")
        return re.fullmatch(expression, char) is not None
    except re.error:
        logger.debug("invalid glob character class %r", pattern)
        return False


def pattern_shape(pattern: str) -> str:
    """Replace extended groups with a wildcard for word classification.

    Args:
        pattern (str): a word with quote marks still intact.
    """
    groups = _Matcher("", pattern).groups
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if i in groups:
            out.append("*")
            i = groups[i][0]
        else:
            out.append(pattern[i])
            i += 1
    return "".join(out)


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


def fnmatch(
    name: str, pattern: str, *, extglob: bool = False, period: bool = False
) -> bool:
    """Case-sensitive shell glob match with bash class negation.

    Mirrors the TypeScript ``utils/fnmatch.ts`` port: always
    case-sensitive, and ``[^...]`` negates like ``[!...]`` (bash/glibc
    semantics, unlike CPython's fnmatch).

    Args:
        name (str): string to test.
        pattern (str): shell glob pattern.
        extglob (bool): interpret Bash's extended pattern groups.
        period (bool): require an explicit leading dot in pathname matches.
    """
    if QUOTED_RE.search(pattern) or (
        extglob
        and ("[:" in pattern or any(c + "(" in pattern for c in "@?*+!"))
    ):
        return _Matcher(name, pattern, period, extglob).matches()
    if period and name.startswith(".") and not pattern.startswith("."):
        return False
    return _stdlib_fnmatch.fnmatchcase(name, _normalize_negation(pattern))


def fnmatchcase(name: str, pattern: str) -> bool:
    """CPython's ``fnmatch.fnmatchcase``: a leading ``^`` is a class member.

    What a Python tool matches with (huggingface_hub's
    ``filter_repo_objects``), so a CLI that mimics one reads ``[^a]`` as
    ``^`` or ``a`` rather than bash's negation. Mirrors the TypeScript
    ``fnmatchcase``.

    Args:
        name (str): string to test.
        pattern (str): fnmatch pattern.
    """
    return _stdlib_fnmatch.fnmatchcase(name, pattern)
