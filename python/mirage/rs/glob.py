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
import threading
from collections.abc import Iterator
from functools import lru_cache
from typing import Literal, TypeAlias, TypedDict, cast

from mirage._rs import Stream
from mirage.io.yield_budget import YieldBudget


class _Plain(TypedDict):
    kind: Literal["matches", "shape", "parts"]


class _End(TypedDict):
    kind: Literal["end"]
    start: int
    longest: bool


class _Suffix(TypedDict):
    kind: Literal["suffix"]
    longest: bool


class _Replace(TypedDict):
    kind: Literal["replace"]
    all: bool
    anchor: str | None


_Operation: TypeAlias = _Plain | _End | _Suffix | _Replace
_Reply: TypeAlias = bool | int | None | list[int] | list[list[int]]
_Dialect: TypeAlias = Literal["shell", "python"]

_CHUNK = 4096
_CACHE_SIZE = 256


def _encoded(text: str) -> bytes:
    return text.encode("utf-32-le", "surrogatepass")


def _pieces(text: str) -> Iterator[bytes]:
    for start in range(0, len(text), _CHUNK):
        yield _encoded(text[start : start + _CHUNK])


def _config(
    pattern: str, extglob: bool, period: bool, dialect: _Dialect
) -> bytes:
    return json.dumps(
        {
            "pattern": [ord(ch) for ch in pattern],
            "dialect": dialect,
            "extglob": extglob,
            "period": period,
            "operation": {"kind": "matches"},
        }
    ).encode()


def _position(result: _Reply) -> int | None:
    assert result is None or (
        isinstance(result, int) and not isinstance(result, bool)
    )
    return result


def _reply(stream: Stream) -> _Reply:
    out = bytearray(stream.finish())
    while stream.busy():
        out.extend(stream.drain())
    return cast(_Reply, json.loads(out))


def _text(result: _Reply) -> str:
    assert isinstance(result, list)
    assert all(
        isinstance(unit, int) and not isinstance(unit, bool) for unit in result
    )
    return "".join(chr(unit) for unit in result if isinstance(unit, int))


class Glob:
    """One compiled pattern over character values, including lone surrogates.

    Every returned offset counts supplied characters, never encoded bytes.

    Args:
        pattern (str): pattern with quoting sentinels intact.
        extglob (bool): recognize extended pattern groups.
        period (bool): require an explicit leading pathname dot.
        dialect (str): shell or Python fnmatchcase grammar.
    """

    def __init__(
        self,
        pattern: str,
        extglob: bool = False,
        period: bool = False,
        dialect: _Dialect = "shell",
    ) -> None:
        self._stream: Stream | None = Stream(
            "glob", _config(pattern, extglob, period, dialect)
        )
        self._subject: str | None = None
        self._budget = YieldBudget()

    def close(self) -> None:
        self._stream = None
        self._subject = None

    def _prepare(self, name: str, operation: _Operation) -> Stream:
        stream = self._stream
        assert stream is not None
        reuse = self._subject == name
        stream.begin(
            json.dumps({**operation, "reuse_subject": reuse}).encode()
        )
        self._subject = name
        return stream

    def _run(self, name: str, operation: _Operation) -> _Reply:
        reuse = self._subject == name
        stream = self._prepare(name, operation)
        if not reuse:
            stream.feed(_encoded(name))
        return _reply(stream)

    async def _run_async(self, name: str, operation: _Operation) -> _Reply:
        reuse = self._subject == name
        stream = self._prepare(name, operation)
        try:
            budget = self._budget
            if not reuse:
                for part in _pieces(name):
                    await budget.run()
                    stream.feed(part)
            out = bytearray(stream.finish())
            while stream.busy():
                await budget.run()
                out.extend(stream.drain())
            return cast(_Reply, json.loads(out))
        finally:
            del stream

    async def matches_async(self, name: str) -> bool:
        result = await self._run_async(name, {"kind": "matches"})
        assert isinstance(result, bool)
        return result

    def end(self, name: str, start: int, longest: bool = True) -> int | None:
        return _position(
            self._run(
                name, {"kind": "end", "start": start, "longest": longest}
            )
        )

    def suffix(self, name: str, longest: bool = True) -> int | None:
        return _position(
            self._run(name, {"kind": "suffix", "longest": longest})
        )

    async def extent(
        self, name: str, prefix: bool, longest: bool
    ) -> int | None:
        operation: _Operation
        if prefix:
            operation = {"kind": "end", "start": 0, "longest": longest}
        else:
            operation = {"kind": "suffix", "longest": longest}
        return _position(await self._run_async(name, operation))

    async def spans(
        self, name: str, all_: bool, anchor: str | None
    ) -> list[tuple[int, int]]:
        result = await self._run_async(
            name, {"kind": "replace", "all": all_, "anchor": anchor}
        )
        assert isinstance(result, list)
        out: list[tuple[int, int]] = []
        for span in result:
            assert isinstance(span, list) and len(span) == 2
            start, end = span
            assert isinstance(start, int) and isinstance(end, int)
            out.append((start, end))
        return out

    def shape(self) -> str:
        return _text(self._run("", {"kind": "shape"}))

    def parts(self) -> list[str]:
        result = self._run("", {"kind": "parts"})
        assert isinstance(result, list)
        return [_text(part) for part in result]


class GlobMatcher:
    """One compiled pattern asked whether whole names match, one native
    call per name, or none where the grammar reads the pattern as plain
    text and the name is compared with it here: what a filter walking
    many names needs.

    Args:
        pattern (str): pattern with quoting sentinels intact.
        extglob (bool): recognize extended pattern groups.
        period (bool): require an explicit leading pathname dot.
        dialect (str): shell or Python fnmatchcase grammar.
    """

    def __init__(
        self,
        pattern: str,
        extglob: bool = False,
        period: bool = False,
        dialect: _Dialect = "shell",
    ) -> None:
        # A cached matcher answers every thread, and its test runs with the
        # GIL released: one test goes through the stream at a time.
        self._lock = threading.Lock()
        self._stream = Stream(
            "glob", _config(pattern, extglob, period, dialect)
        )
        self._stream.begin(b'{"kind":"literal"}')
        literal = _reply(self._stream)
        self._literal = None if literal is None else _text(literal)

    def matches(self, name: str) -> bool:
        if self._literal is not None:
            return name == self._literal
        data = _encoded(name)
        with self._lock:
            return self._stream.test(data)


@lru_cache(maxsize=_CACHE_SIZE)
def glob_matcher(
    pattern: str,
    extglob: bool = False,
    period: bool = False,
    dialect: _Dialect = "shell",
) -> GlobMatcher:
    """A compiled ``GlobMatcher``, shared by every caller asking the same.

    Args:
        pattern (str): pattern with quoting sentinels intact.
        extglob (bool): recognize extended pattern groups.
        period (bool): require an explicit leading pathname dot.
        dialect (str): shell or Python fnmatchcase grammar.
    """
    return GlobMatcher(pattern, extglob, period, dialect)
