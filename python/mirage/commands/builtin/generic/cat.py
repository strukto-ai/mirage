from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.utils.stream import ensure_stream


@dataclass(frozen=True, slots=True)
class CatFlags:
    number_lines: bool = False
    number_nonblank: bool = False
    show_ends: bool = False
    squeeze_blank: bool = False
    show_tabs: bool = False
    show_nonprinting: bool = False


def parse_flags(flags: Mapping[str, object]) -> CatFlags:
    fl = FlagView(flags, spec=SPECS["cat"])
    show_all = fl.as_bool("A") or fl.as_bool("show_all")
    return CatFlags(
        number_lines=fl.as_bool("n") or fl.as_bool("number"),
        number_nonblank=(fl.as_bool("b") or fl.as_bool("number_nonblank")),
        show_ends=(fl.as_bool("E") or fl.as_bool("show_ends")
                   or fl.as_bool("e") or show_all),
        squeeze_blank=fl.as_bool("s") or fl.as_bool("squeeze_blank"),
        show_tabs=(fl.as_bool("T") or fl.as_bool("show_tabs")
                   or fl.as_bool("t") or show_all),
        show_nonprinting=(fl.as_bool("v") or fl.as_bool("show_nonprinting")
                          or fl.as_bool("e") or fl.as_bool("t") or show_all),
    )


def needs_display(flags: Mapping[str, object]) -> bool:
    parsed = parse_flags(flags)
    return any(
        (parsed.number_lines, parsed.number_nonblank, parsed.show_ends,
         parsed.squeeze_blank, parsed.show_tabs, parsed.show_nonprinting))


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
    flags: Mapping[str, object] | None = None,
    number_lines: bool = False,
    number_nonblank: bool = False,
    show_ends: bool = False,
    squeeze_blank: bool = False,
    show_tabs: bool = False,
    show_nonprinting: bool = False,
) -> AsyncIterator[bytes]:
    if flags is not None:
        parsed = parse_flags(flags)
        number_lines = parsed.number_lines
        number_nonblank = parsed.number_nonblank
        show_ends = parsed.show_ends
        squeeze_blank = parsed.squeeze_blank
        show_tabs = parsed.show_tabs
        show_nonprinting = parsed.show_nonprinting
    if number_nonblank:
        number_lines = False
    needs_line_processing = (number_lines or show_ends or squeeze_blank
                             or show_tabs or show_nonprinting
                             or number_nonblank)

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
            should_number = number_lines or (number_nonblank and bool(line))
            if should_number:
                line_no += 1
            prefix = f"{line_no:6d}\t".encode() if should_number else b""
            suffix = b"$\n" if show_ends else b"\n"
            if show_tabs or show_nonprinting:
                line = _visible(line, show_tabs, show_nonprinting)
            yield prefix + line + suffix
            prev_blank = not line
    if buf:
        should_number = number_lines or number_nonblank
        if should_number:
            line_no += 1
        prefix = f"{line_no:6d}\t".encode() if should_number else b""
        if show_tabs or show_nonprinting:
            buf = _visible(buf, show_tabs, show_nonprinting)
        yield prefix + buf
