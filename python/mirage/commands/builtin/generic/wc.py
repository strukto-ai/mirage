import codecs
from collections.abc import AsyncIterator
from dataclasses import dataclass

from mirage.utils.stream import ensure_stream


@dataclass
class WCCounts:
    lines: int = 0
    words: int = 0
    bytes_: int = 0
    chars: int = 0
    max_line_length: int = 0

    def merge(self, other: "WCCounts") -> None:
        self.lines += other.lines
        self.words += other.words
        self.bytes_ += other.bytes_
        self.chars += other.chars
        if other.max_line_length > self.max_line_length:
            self.max_line_length = other.max_line_length


def _scan_text(
    text: str,
    in_word: bool,
    line_len: int,
    max_len: int,
) -> tuple[int, int, int, bool]:
    words_added = 0
    for ch in text:
        if ch.isspace():
            if in_word:
                words_added += 1
                in_word = False
            if ch == "\n":
                if line_len > max_len:
                    max_len = line_len
                line_len = 0
            else:
                line_len += 1
        else:
            in_word = True
            line_len += 1
    return words_added, line_len, max_len, in_word


async def wc(src: bytes | AsyncIterator[bytes]) -> WCCounts:
    bytes_count = 0
    lines = 0
    words = 0
    chars = 0
    max_len = 0
    in_word = False
    line_len = 0
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    async for chunk in ensure_stream(src):
        bytes_count += len(chunk)
        lines += chunk.count(b"\n")
        text = decoder.decode(chunk)
        chars += len(text)
        added, line_len, max_len, in_word = _scan_text(text, in_word, line_len,
                                                       max_len)
        words += added

    final_text = decoder.decode(b"", final=True)
    chars += len(final_text)
    added, line_len, max_len, in_word = _scan_text(final_text, in_word,
                                                   line_len, max_len)
    words += added

    if in_word:
        words += 1
    if line_len > max_len:
        max_len = line_len

    return WCCounts(
        lines=lines,
        words=words,
        bytes_=bytes_count,
        chars=chars,
        max_line_length=max_len,
    )


async def wc_lines(src: bytes | AsyncIterator[bytes]) -> int:
    count = 0
    async for chunk in ensure_stream(src):
        count += chunk.count(b"\n")
    return count


def format_wc(
    counts: WCCounts,
    *,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    label: str | None = None,
) -> str:
    if L:
        body = str(counts.max_line_length)
    elif args_l:
        body = str(counts.lines)
    elif w:
        body = str(counts.words)
    elif c:
        body = str(counts.bytes_)
    elif m:
        body = str(counts.chars)
    else:
        body = f"{counts.lines}\t{counts.words}\t{counts.bytes_}"
    if label is None:
        return body
    return f"{body}\t{label}"
