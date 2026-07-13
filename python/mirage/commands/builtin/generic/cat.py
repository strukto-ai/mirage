from collections.abc import AsyncIterator

from mirage.utils.stream import ensure_stream


def _visible(line: bytes, show_tabs: bool, show_nonprinting: bool) -> bytes:
    """Render a line GNU cat -T / -v style.

    Tabs become ^I under -T; under -v control bytes become ^X, DEL
    becomes ^?, and high bytes get the M- prefix with the same rules
    applied to the low seven bits. Newlines never appear here (the
    caller splits on them).

    Args:
        line (bytes): one line without its trailing newline.
        show_tabs (bool): -T, render tab as ^I.
        show_nonprinting (bool): -v, render control and high bytes.
    """
    out = bytearray()
    for byte in line:
        if byte == 9:
            out += b"^I" if show_tabs else b"\t"
        elif not show_nonprinting:
            out.append(byte)
        elif byte < 32:
            out += bytes((94, byte + 64))
        elif byte == 127:
            out += b"^?"
        elif byte >= 128:
            out += b"M-"
            low = byte - 128
            if low < 32:
                out += bytes((94, low + 64))
            elif low == 127:
                out += b"^?"
            else:
                out.append(low)
        else:
            out.append(byte)
    return bytes(out)


async def cat(
    src: bytes | AsyncIterator[bytes],
    *,
    number_lines: bool = False,
    show_ends: bool = False,
    squeeze_blank: bool = False,
    show_tabs: bool = False,
    show_nonprinting: bool = False,
) -> AsyncIterator[bytes]:
    needs_line_processing = (number_lines or show_ends or squeeze_blank
                             or show_tabs or show_nonprinting)

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
            if show_tabs or show_nonprinting:
                line = _visible(line, show_tabs, show_nonprinting)
            yield prefix + line + suffix
            prev_blank = not line
    if buf:
        line_no += 1
        prefix = f"{line_no:6d}\t".encode() if number_lines else b""
        if show_tabs or show_nonprinting:
            buf = _visible(buf, show_tabs, show_nonprinting)
        yield prefix + buf
