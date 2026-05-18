from collections.abc import AsyncIterator

from mirage.utils.stream import ensure_stream


async def cat(
    src: bytes | AsyncIterator[bytes],
    *,
    number_lines: bool = False,
    show_ends: bool = False,
    squeeze_blank: bool = False,
) -> AsyncIterator[bytes]:
    needs_line_processing = number_lines or show_ends or squeeze_blank

    if not needs_line_processing:
        async for chunk in ensure_stream(src):
            yield chunk
        return

    line_no = 0
    buf = b""
    prev_blank = False
    async for chunk in ensure_stream(src):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if squeeze_blank and not line and prev_blank:
                prev_blank = True
                continue
            line_no += 1
            prefix = f"{line_no:6d}\t".encode() if number_lines else b""
            suffix = b"$\n" if show_ends else b"\n"
            yield prefix + line + suffix
            prev_blank = not line
    if buf:
        line_no += 1
        prefix = f"{line_no:6d}\t".encode() if number_lines else b""
        yield prefix + buf
