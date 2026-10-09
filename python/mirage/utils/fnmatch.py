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
import re
from collections.abc import Generator, Iterable, Iterator

from mirage.utils.posix import POSIX_CLASSES

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


def _unseen(links: list[int], position: int) -> int:
    """Next unscheduled offset for a state, with successor-chain compression.

    Args:
        links (list[int]): next candidates, initially self-linked.
        position (int): first candidate.
    """
    root = position
    while links[root] != root:
        root = links[root]
    while links[position] != position:
        following = links[position]
        links[position] = root
        position = following
    return root


class _Matcher:
    """Match extended groups by reachable character positions.

    Positive groups compile to epsilon transitions. The active states
    advance together over the subject, so nested repetitions share work
    at each offset instead of retaining a suffix result per repetition.
    Negative groups request memoized branch endpoints on an explicit stack.

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
        self.transitions: dict[int, tuple[int, ...]] = {}
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

        for opened, (end, branches) in self.groups.items():
            operator = pattern[opened]
            if operator == "!":
                continue
            self.transitions[opened] = tuple(a for a, _ in branches) + (
                (end,) if operator in "*?" else ()
            )
            for _, stop in branches:
                self.transitions[stop] = (end,) + (
                    (opened,) if operator in "*+" else ()
                )

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
        stack = [(key, self.evaluate(lo, hi, start), False)]
        answer = _Positions()
        while stack:
            current, frame, started = stack[-1]
            try:
                if started:
                    dependency = frame.send(answer)
                else:
                    stack[-1] = (current, frame, True)
                    dependency = next(frame)
            except StopIteration as done:
                answer = done.value
                self.memo[current] = answer
                stack.pop()
                continue
            cached = self.memo.get(dependency)
            if cached is not None:
                answer = cached
            else:
                child = self.evaluate(*dependency)
                stack.append((dependency, child, False))
                answer = _Positions()
        return answer

    def evaluate(
        self, lo: int, hi: int, start: int
    ) -> Generator[tuple[int, int, int], _Positions, _Positions]:
        """Yield dependencies so nested groups never consume the host stack.

        Args:
            lo (int): start of the pattern slice.
            hi (int): end of the pattern slice.
            start (int): first character to match.
        """
        if self.pattern[lo:hi] == "*":
            return (
                _Positions()
                if self.period and start == 0
                else _Positions(((start, len(self.name) + 1),))
            )
        pending: dict[int, set[int]] = {start: {lo}}
        scheduled: dict[int, list[int]] = {}
        accepted: list[tuple[int, int]] = []
        for position in range(start, len(self.name) + 1):
            if not pending:
                break
            seen = pending.pop(position, set())
            active = list(seen)
            while active:
                i = active.pop()
                if i == hi:
                    accepted.append((position, position + 1))
                    continue
                transitions = self.transitions.get(i)
                if transitions is not None:
                    for target in transitions:
                        if target not in seen:
                            seen.add(target)
                            active.append(target)
                    continue
                c = self.pattern[i]
                group = self.groups.get(i)
                if group is not None and group[0] <= hi:
                    if self.period and position == 0:
                        continue
                    end, branches = group
                    matched: list[tuple[int, int]] = []
                    for a, b in branches:
                        once = yield (a, b, position)
                        matched.extend(once.spans)
                    reached = _Positions(
                        ((position, len(self.name) + 1),)
                    ).subtract(_Positions(matched))
                    if reached.contains(position) and end not in seen:
                        seen.add(end)
                        active.append(end)
                    for lower, upper in reached.spans:
                        if upper <= position + 1:
                            continue
                        links = scheduled.get(end)
                        if links is None:
                            links = list(range(len(self.name) + 2))
                            scheduled[end] = links
                        target = _unseen(links, max(lower, position + 1))
                        while target < upper:
                            pending.setdefault(target, set()).add(end)
                            links[target] = target + 1
                            target = _unseen(links, target)
                    continue
                end = self.classes.get(i, i + 1)
                wildcard = c in "*?" or end > i + 1
                if self.period and position == 0 and wildcard:
                    continue
                if c == "*":
                    if end not in seen:
                        seen.add(end)
                        active.append(end)
                    if position < len(self.name):
                        pending.setdefault(position + 1, set()).add(i)
                elif position < len(self.name) and (
                    _extended_class_matches(
                        self.name[position], self.pattern[i:end]
                    )
                    if end > i + 1
                    else c == "?"
                    or QUOTED_CHARS.get(c, c) == self.name[position]
                ):
                    pending.setdefault(position + 1, set()).add(end)
        return _Positions(accepted)


def _extended_class_matches(char: str, pattern: str) -> bool:
    end = len(pattern) - 1
    negate = pattern[1:2] in ("!", "^")
    i = 2 if negate else 1
    found = False
    while i < end:
        if pattern.startswith("[:", i):
            close = pattern.find(":]", i + 2)
            if close >= 0:
                name = pattern[i + 2 : close]
                members = POSIX_CLASSES.get(name)
                if members is None:
                    return False
                found |= re.fullmatch("[" + members + "]", char) is not None
                i = close + 2
                continue
        low = QUOTED_CHARS.get(pattern[i], pattern[i])
        if (
            i + 2 < end
            and pattern[i + 1] == "-"
            and not pattern.startswith("[:", i + 2)
        ):
            high = QUOTED_CHARS.get(pattern[i + 2], pattern[i + 2])
            found |= low <= char <= high
            i += 3
        else:
            found |= low == char
            i += 1
    return not found if negate else found


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


def pattern_parts(pattern: str) -> list[str]:
    """Split a pathname without splitting slashes inside extended groups.

    Args:
        pattern (str): pathname with quote marks still intact.
    """
    if not any(c + "(" in pattern for c in "@?*+!"):
        return pattern.split("/")
    groups = _Matcher("", pattern).groups
    out: list[str] = []
    start = i = 0
    while i < len(pattern):
        group = groups.get(i)
        if group is not None:
            i = group[0]
            continue
        if pattern[i] == "/":
            out.append(pattern[start:i])
            start = i + 1
        i += 1
    out.append(pattern[start:])
    return out


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
