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

import json
import struct
import threading
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from functools import lru_cache
from itertools import accumulate
from typing import Literal, TypeAlias

from mirage.rs.errors import RegexError, SearchLimit, StreamRefusal
from mirage.rs.stream import OpenStream, open_stream
from mirage.shell.bytes import encode_text, from_byte_view
from mirage.types import JsonValue

Span: TypeAlias = tuple[int, int]
Groups: TypeAlias = list[Span | None]
PosixDialect: TypeAlias = Literal["sed", "posix"]
LineSyntax: TypeAlias = Literal["basic", "extended", "fixed", "perl"]

_UNSET = 0xFFFFFFFF
_SPECIAL = frozenset("\\.[]()*+?{}|^$")
_CACHE_SIZE = 256


def _latin1(data: bytes) -> str:
    return data.decode("latin-1")


def _byte_length(ch: str) -> int:
    return len(encode_text(ch))


def posix_escape(text: str) -> str:
    """``text`` as a POSIX extended expression that matches only itself.

    Args:
        text (str): the literal.
    """
    return "".join("\\" + ch if ch in _SPECIAL else ch for ch in text)


class _Subject:
    """A byte view as the bytes mirage-rs searches, and the way back from
    a byte offset to an index of the view.

    Args:
        text (str): one element per byte, or per character under ``utf8``.
        utf8 (bool): the view is text under a UTF-8 locale.
    """

    def __init__(self, text: str, utf8: bool) -> None:
        self.data = from_byte_view(text, utf8)
        self._ends: list[int] | None = (
            None
            if len(self.data) == len(text)
            else list(accumulate(_byte_length(ch) for ch in text))
        )

    def offset(self, index: int) -> int:
        if self._ends is None or index == 0:
            return index
        return self._ends[index - 1]

    def index(self, offset: int) -> int:
        if self._ends is None:
            return offset
        return bisect_right(self._ends, offset)


def _words(data: bytes) -> tuple[int, ...]:
    return struct.unpack(f"<{len(data) // 4}I", data)


def _spans(subject: _Subject, data: bytes) -> list[Span]:
    words = _words(data)
    return [
        (subject.index(words[at]), subject.index(words[at + 1]))
        for at in range(0, len(words), 2)
    ]


def _open(config: Mapping[str, JsonValue]) -> OpenStream:
    try:
        return open_stream("regex", config)
    except StreamRefusal as exc:
        raise RegexError(exc.message) from exc


class PosixRegex:
    """One POSIX expression, searched against whole subjects.

    A match is the leftmost one and the longest there; its groups lie
    where the first way of matching that text puts them, trying a
    repetition's longer counts and an alternation's earlier branches
    first. Offsets count elements of the byte view the subject arrives
    as.

    Args:
        pattern (str): the expression as a byte view.
        extended (bool): an extended expression rather than a basic one.
        dialect (PosixDialect): ``sed`` reads it as GNU sed does,
            ``posix`` as regcomp does for expr, nl, bash and git.
        ignore_case (bool): letters match in either case.
        utf8 (bool): the views are text under a UTF-8 locale.
        multiline (bool): sed's ``M``: ``^`` and ``$`` match at each
            line's edges, and neither ``.`` nor a negated bracket
            expression matches a newline.
        word (bool): git grep's -w: no word character on either side of
            the match.

    Raises:
        RegexError: the expression is refused, worded as regerror words
            it.
    """

    def __init__(
        self,
        pattern: str,
        extended: bool = False,
        dialect: PosixDialect = "posix",
        ignore_case: bool = False,
        utf8: bool = False,
        multiline: bool = False,
        word: bool = False,
    ) -> None:
        self.utf8 = utf8
        # One stream answers every caller of a cached expression, and
        # git's filters run in worker threads: a request's begin, feed and
        # finish go through it together.
        self._lock = threading.Lock()
        self._stream = _open(
            {
                "mode": "posix",
                "pattern": _latin1(from_byte_view(pattern, utf8)),
                "extended": extended,
                "dialect": dialect,
                "ignore_case": ignore_case,
                "utf8": utf8,
                "multiline": multiline,
                "word": word,
            }
        )
        self.groups: int = json.loads(self._stream.metadata())["groups"]

    def _ask(
        self, subject: _Subject, request: Mapping[str, JsonValue]
    ) -> bytes:
        with self._lock:
            self._stream.begin(request)
            self._stream.feed(subject.data)
            return self._stream.finish()

    def _groups(self, subject: _Subject, words: Sequence[int]) -> Groups:
        out: Groups = []
        for at in range(0, len(words), 2):
            start, end = words[at], words[at + 1]
            out.append(
                None
                if start == _UNSET
                else (subject.index(start), subject.index(end))
            )
        return out

    def search(self, text: str, at: int = 0) -> Groups | None:
        """The leftmost-longest match at or after ``at``, and its groups.

        Args:
            text (str): the subject as a byte view.
            at (int): where the search starts; anchors still see the
                whole subject.
        """
        subject = _Subject(text, self.utf8)
        words = _words(
            self._ask(subject, {"op": "search", "at": subject.offset(at)})
        )
        return self._groups(subject, words) if words else None

    def all(self, text: str) -> list[Groups]:
        """Every match a global substitution replaces, as sed walks them.

        Args:
            text (str): the subject as a byte view.
        """
        subject = _Subject(text, self.utf8)
        words = _words(self._ask(subject, {"op": "all"}))
        width = 2 * (self.groups + 1)
        return [
            self._groups(subject, words[at : at + width])
            for at in range(0, len(words), width)
        ]

    def contains(self, text: str) -> int:
        """How many times git's pickaxe counts the expression in ``text``:
        each match stays in its line, each search resumes where the last
        one ended (a character further after an empty one), and ``^``
        never holds where it resumes.

        Args:
            text (str): the subject as a byte view.
        """
        subject = _Subject(text, self.utf8)
        return _words(self._ask(subject, {"op": "contains"}))[0]

    def matches(self, text: str) -> bool:
        """Whether the expression matches anywhere in ``text``, as sed's
        addresses ask: with no groups to place, a ``$`` reads a newline
        the match goes on to consume even in a pattern with groups.

        Args:
            text (str): the subject as a byte view.
        """
        subject = _Subject(text, self.utf8)
        return _words(self._ask(subject, {"op": "test"}))[0] == 1


@lru_cache(maxsize=_CACHE_SIZE)
def posix_regex(
    pattern: str,
    extended: bool = False,
    dialect: PosixDialect = "posix",
    ignore_case: bool = False,
    utf8: bool = False,
    multiline: bool = False,
    word: bool = False,
) -> PosixRegex:
    """A compiled ``PosixRegex``, shared by every caller asking the same.

    Args:
        pattern (str): the expression as a byte view.
        extended (bool): an extended expression.
        dialect (PosixDialect): whose reading.
        ignore_case (bool): letters match in either case.
        utf8 (bool): the views are text under a UTF-8 locale.
        multiline (bool): sed's ``M``.
        word (bool): git grep's -w.
    """
    return PosixRegex(
        pattern, extended, dialect, ignore_case, utf8, multiline, word
    )


class LineRegex:
    """grep's pattern list, matched against one line at a time: a line
    matches when any pattern does, and ``extents`` reads matches as -o
    prints them, the leftmost and longest across the list.

    Args:
        patterns (Sequence[str]): the patterns as byte views.
        syntax (LineSyntax): ``basic``, ``extended``, ``fixed`` or
            ``perl`` (one PCRE2 pattern).
        ignore_case (bool): -i.
        utf8 (bool): the lines are text under a UTF-8 locale.
        word (bool): -w.
        line (bool): -x, which outranks -w.

    Raises:
        RegexError: a pattern GNU grep refuses, in its wording.
    """

    def __init__(
        self,
        patterns: Sequence[str],
        syntax: LineSyntax,
        ignore_case: bool = False,
        utf8: bool = False,
        word: bool = False,
        line: bool = False,
    ) -> None:
        self._utf8 = utf8
        self.ignore_case = ignore_case
        self.unicode_folds = ignore_case and utf8
        self._lock = threading.Lock()
        self._stream = _open(
            {
                "mode": "lines",
                "patterns": [
                    _latin1(from_byte_view(part, utf8)) for part in patterns
                ],
                "syntax": syntax,
                "ignore_case": ignore_case,
                "utf8": utf8,
                "word": word,
                "line": line,
            }
        )
        meta = json.loads(self._stream.metadata())
        self.warnings: tuple[str, ...] = tuple(meta["warnings"])
        needles = meta["needles"]
        self.needles: tuple[bytes, ...] | None = (
            None
            if needles is None
            else tuple(needle.encode("ascii") for needle in needles)
        )

    def _ask(self, subject: _Subject, op: str) -> bytes:
        with self._lock:
            self._stream.begin({"op": op})
            self._stream.feed(subject.data)
            return self._stream.finish()

    def matches(self, line: str) -> bool:
        """Whether the line, without its terminator, matches.

        Args:
            line (str): the line as a byte view.

        Raises:
            SearchLimit: a -P search gave up at PCRE2's match limit.
        """
        try:
            return self._ask(_Subject(line, self._utf8), "test") == b"\x01"
        except StreamRefusal as exc:
            raise SearchLimit(exc.message, []) from exc

    def extents(self, line: str) -> list[Span]:
        """Each match grep -o prints from the line.

        Args:
            line (str): the line as a byte view.

        Raises:
            SearchLimit: a -P search gave up at PCRE2's match limit, after
                the matches it carries.
        """
        subject = _Subject(line, self._utf8)
        try:
            return _spans(subject, self._ask(subject, "extents"))
        except StreamRefusal as exc:
            raise SearchLimit(
                exc.message, _spans(subject, exc.output)
            ) from exc
