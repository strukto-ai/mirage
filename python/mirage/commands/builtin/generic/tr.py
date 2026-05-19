from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.escapes import interpret_escapes
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _expand_ranges(s: str) -> str:
    result: list[str] = []
    i = 0
    while i < len(s):
        if i + 2 < len(s) and s[i + 1] == "-":
            start, end = ord(s[i]), ord(s[i + 2])
            result.extend(chr(c) for c in range(start, end + 1))
            i += 3
        else:
            result.append(s[i])
            i += 1
    return "".join(result)


async def _tr_stream(
    source: AsyncIterator[bytes],
    set1: str,
    set2: str,
    delete: bool,
    squeeze: bool,
    table: dict[int, int] | None,
) -> AsyncIterator[bytes]:
    prev_char = ""
    squeeze_set = set(set2) if squeeze and set2 else set(
        set1) if squeeze else set()
    async for chunk in source:
        text = chunk.decode(errors="replace")
        if delete:
            result = "".join(c for c in text if c not in set1)
        elif table is not None:
            result = text.translate(table)
        else:
            result = text
        if squeeze_set:
            squeezed: list[str] = []
            for c in result:
                if c in squeeze_set and c == prev_char:
                    continue
                squeezed.append(c)
                prev_char = c
            result = "".join(squeezed)
        elif result:
            prev_char = result[-1]
        yield result.encode()


async def tr(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    delete: bool = False,
    squeeze: bool = False,
    complement: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("tr: usage: tr [-d] [-s] [-c] set1 [set2] [path]")
    set1 = _expand_ranges(interpret_escapes(texts[0]))
    if complement:
        all_chars = "".join(chr(i) for i in range(128))
        set1 = "".join(ch for ch in all_chars if ch not in set1)
    set2 = _expand_ranges(interpret_escapes(
        texts[1])) if len(texts) >= 2 else ""

    if set2 and len(set2) < len(set1):
        set2 = set2 + set2[-1] * (len(set1) - len(set2))

    table: dict[int, int] | None = None
    if not delete and set2:
        table = str.maketrans(set1, set2)
    elif not delete and not set2 and not squeeze:
        raise ValueError("tr: usage: tr set1 set2")

    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        cache = [paths[0].original]
    else:
        source = _resolve_source(stdin, "tr: missing input")

    return _tr_stream(source,
                      set1,
                      set2,
                      delete=delete,
                      squeeze=squeeze,
                      table=table), IOResult(cache=cache)


__all__ = ["tr"]
