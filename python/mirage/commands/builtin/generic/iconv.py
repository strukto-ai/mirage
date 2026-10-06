import codecs
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import read_stdin_async, stdin_bytes
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

_HINT = "Try `iconv --help' or `iconv --usage' for more information."
_INCOMPLETE = "incomplete character or shift sequence at end of buffer"

# glibc's names for the charsets both hosts convert by hand, upper-cased:
# glibc matches a name without regard to case but not to punctuation, so
# LATIN-1 and UTF_8 are refused while ISO88591 and UCS2 are not.
CHARSETS: dict[str, str] = {
    "UTF-8": "utf-8",
    "UTF8": "utf-8",
    "UTF-16": "utf-16",
    "UTF16": "utf-16",
    "UTF-16LE": "utf-16le",
    "UTF16LE": "utf-16le",
    "UTF-16BE": "utf-16be",
    "UTF16BE": "utf-16be",
    "UCS-2": "ucs-2le",
    "UCS2": "ucs-2le",
    "UCS-2LE": "ucs-2le",
    "UCS-2BE": "ucs-2be",
    "ISO-8859-1": "latin1",
    "ISO8859-1": "latin1",
    "ISO88591": "latin1",
    "ISO_8859-1": "latin1",
    "ISO_8859-1:1987": "latin1",
    "ISO-IR-100": "latin1",
    "LATIN1": "latin1",
    "L1": "latin1",
    "CP819": "latin1",
    "IBM819": "latin1",
    "CSISOLATIN1": "latin1",
    "ASCII": "ascii",
    "US-ASCII": "ascii",
    "ANSI_X3.4-1968": "ascii",
    "ANSI_X3.4-1986": "ascii",
    "ISO646-US": "ascii",
    "ISO_646.IRV:1991": "ascii",
    "US": "ascii",
    "CP367": "ascii",
    "IBM367": "ascii",
    "CSASCII": "ascii",
}

# The python codec that converts a hand-written charset in bulk, when
# nothing in the input needs the byte-by-byte account.
_BULK = {
    "utf-8": "utf-8",
    "utf-16": "utf-16",
    "utf-16le": "utf-16-le",
    "utf-16be": "utf-16-be",
    "ucs-2le": "utf-16-le",
    "ucs-2be": "utf-16-be",
    "latin1": "latin-1",
    "ascii": "ascii",
}

# Python's codec registry reads names loosely (latin-1, utf_8, u8, 646);
# a loose name for a hand-written charset is one glibc refuses.
_HAND_CODECS = frozenset(
    {"utf-8", "utf-16", "utf-16-le", "utf-16-be", "iso8859-1", "ascii"}
)
_ILLEGAL = -1
_CUT = -2

# One decoded character as (code point, bytes used); the code point is
# _ILLEGAL or _CUT when there is none.
_Decoded = tuple[int, int]


@dataclass(frozen=True, slots=True)
class _Charset:
    name: str
    by_hand: bool


@dataclass(frozen=True, slots=True)
class _Converted:
    data: bytes
    dropped: bool
    error: str | None


def _charset_of(name: str) -> _Charset | None:
    """The charset an iconv name selects, None when there is none.

    glibc's ``//TRANSLIT`` and ``//IGNORE`` suffixes are not supported.

    Args:
        name (str): the charset as typed.
    """
    own = CHARSETS.get(name.upper())
    if own is not None:
        return _Charset(own, True)
    try:
        codec = codecs.lookup(name).name
    except LookupError:
        return None
    return None if codec in _HAND_CODECS else _Charset(codec, False)


def _unsupported(from_enc: str, to_enc: str, from_ok: bool) -> bytes:
    if not from_ok and _charset_of(to_enc) is None:
        line = (
            f"iconv: conversions from `{from_enc}' and to `{to_enc}' "
            "are not supported"
        )
    elif not from_ok:
        line = f"iconv: conversion from `{from_enc}' is not supported"
    else:
        line = f"iconv: conversion to `{to_enc}' is not supported"
    return f"{line}\n{_HINT}\n".encode()


def _unit_of(charset: _Charset) -> int:
    """The bytes a refused sequence spans, so ``-c`` skips it whole.

    Args:
        charset (_Charset): the source charset.
    """
    name = charset.name.replace("-", "").replace("_", "")
    if name.startswith(("utf16", "ucs2")):
        return 2
    return 4 if name.startswith("utf32") else 1


def _utf8_second(lead: int) -> tuple[int, int]:
    if lead == 0xE0:
        return 0xA0, 0xBF
    if lead == 0xED:
        return 0x80, 0x9F
    if lead == 0xF0:
        return 0x90, 0xBF
    return (0x80, 0x8F) if lead == 0xF4 else (0x80, 0xBF)


def _decode_utf8(raw: bytes, at: int) -> _Decoded:
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if 0xC2 <= lead <= 0xDF:
        length, cp = 2, lead & 0x1F
    elif 0xE0 <= lead <= 0xEF:
        length, cp = 3, lead & 0x0F
    elif 0xF0 <= lead <= 0xF4:
        length, cp = 4, lead & 0x07
    else:
        return _ILLEGAL, 0
    for i in range(1, length):
        if at + i >= len(raw):
            return _CUT, 0
        low, high = _utf8_second(lead) if i == 1 else (0x80, 0xBF)
        if not low <= raw[at + i] <= high:
            return _ILLEGAL, 0
        cp = (cp << 6) | (raw[at + i] & 0x3F)
    return cp, length


def _decode_utf16(raw: bytes, at: int, little: bool, pairs: bool) -> _Decoded:
    def unit(offset: int) -> int:
        return int.from_bytes(
            raw[offset : offset + 2], "little" if little else "big"
        )

    if at + 2 > len(raw):
        return _CUT, 0
    first = unit(at)
    if 0xDC00 <= first <= 0xDFFF or (0xD800 <= first <= 0xDBFF and not pairs):
        return _ILLEGAL, 0
    if not 0xD800 <= first <= 0xDBFF:
        return first, 2
    if at + 4 > len(raw):
        return _CUT, 0
    second = unit(at + 2)
    if not 0xDC00 <= second <= 0xDFFF:
        return _ILLEGAL, 0
    return 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00), 4


def _decode_at(raw: bytes, at: int, charset: str, little: bool) -> _Decoded:
    """One character of a hand-written charset: (code point, bytes used).

    The code point is ``_ILLEGAL`` for a sequence the charset does not
    allow and ``_CUT`` for one the input ends inside of. Mirrors the
    TypeScript ``decodeAt``.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        charset (str): a hand-written charset.
        little (bool): the byte order of a UTF-16 or UCS-2 input.
    """
    byte = raw[at]
    if charset == "latin1":
        return byte, 1
    if charset == "ascii":
        return (byte, 1) if byte < 0x80 else (_ILLEGAL, 0)
    if charset == "utf-8":
        return _decode_utf8(raw, at)
    return _decode_utf16(raw, at, little, charset.startswith("utf-16"))


class _HandEncoder:
    """The target side of a hand-written charset, shared by every input.

    A UTF-16 output gets its BOM once, before its first character.
    Mirrors the TypeScript ``Encoder``.
    """

    def __init__(self, charset: str) -> None:
        self.charset = charset
        self.bom = charset == "utf-16"

    def encode_char(self, cp: int) -> bytes | None:
        if self.charset == "ascii":
            return bytes([cp]) if cp < 0x80 else None
        if self.charset == "latin1":
            return bytes([cp]) if cp < 0x100 else None
        if self.charset == "utf-8":
            return chr(cp).encode("utf-8")
        if self.charset.startswith("ucs-2") and cp > 0xFFFF:
            return None
        big = self.charset.endswith("be")
        data = chr(cp).encode("utf-16-be" if big else "utf-16-le")
        if self.bom:
            self.bom = False
            return b"\xff\xfe" + data
        return data

    def encode_text(self, text: str) -> bytes | None:
        if self.charset.startswith("ucs-2") and any(
            ord(c) > 0xFFFF for c in text
        ):
            return None
        try:
            data = text.encode(_BULK[self.charset])
        except UnicodeEncodeError:
            return None
        if self.charset == "utf-16":
            data = data[2:] if data[:2] == b"\xff\xfe" else data
            if self.bom and data:
                self.bom = False
                return b"\xff\xfe" + data
        return data

    def finish(self) -> bytes:
        return b""


class _CodecEncoder:
    """The target side of any other charset python's codecs convert.

    A stateful charset (ISO-2022-JP) keeps its shift state across inputs
    and closes it in ``finish``, as glibc writes the reset sequence.
    """

    def __init__(self, codec: str) -> None:
        self.encoder = codecs.getincrementalencoder(codec)("strict")

    def encode_char(self, cp: int) -> bytes | None:
        state = self.encoder.getstate()
        try:
            return self.encoder.encode(chr(cp))
        except UnicodeEncodeError:
            self.encoder.setstate(state)
            return None

    def encode_text(self, text: str) -> bytes | None:
        state = self.encoder.getstate()
        try:
            return self.encoder.encode(text)
        except UnicodeEncodeError:
            self.encoder.setstate(state)
            return None

    def finish(self) -> bytes:
        return self.encoder.encode("", final=True)


def _bulk_text(raw: bytes, charset: _Charset) -> str | None:
    """The whole input decoded at once, None when it needs the slow walk.

    Args:
        raw (bytes): one input.
        charset (_Charset): the source charset.
    """
    codec = _BULK[charset.name] if charset.by_hand else charset.name
    try:
        text = raw.decode(codec)
    except UnicodeDecodeError:
        return None
    if charset.name.startswith("ucs-2") and any(ord(c) > 0xFFFF for c in text):
        return None
    return text


def _walk_by_hand(
    raw: bytes, charset: str, encoder: "_Encoder", omit: bool
) -> _Converted:
    """Convert one input character by character, as glibc reports it.

    Mirrors the TypeScript ``convert``.

    Args:
        raw (bytes): one input, whole.
        charset (str): the hand-written source charset.
        encoder (_Encoder): the target, shared by every input.
        omit (bool): ``-c``.
    """
    out = bytearray()
    dropped = False
    at = 0
    little = not charset.endswith("be")
    if charset == "utf-16" and raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        little = raw[:2] == b"\xff\xfe"
        at = 2
    unit = _unit_of(_Charset(charset, True))
    while at < len(raw):
        cp, length = _decode_at(raw, at, charset, little)
        if cp == _CUT:
            return _Converted(bytes(out), dropped, _INCOMPLETE)
        if cp == _ILLEGAL:
            if not omit:
                return _Converted(
                    bytes(out),
                    dropped,
                    f"illegal input sequence at position {at}",
                )
            dropped = True
            at += unit
            continue
        data = encoder.encode_char(cp)
        if data is None:
            if not omit:
                return _Converted(
                    bytes(out),
                    dropped,
                    f"illegal input sequence at position {at}",
                )
            dropped = True
        else:
            out += data
        at += length
    return _Converted(bytes(out), dropped, None)


def _walk_codec(
    raw: bytes, charset: _Charset, encoder: "_Encoder", omit: bool
) -> _Converted:
    """Convert one input of a codec charset a byte at a time.

    Args:
        raw (bytes): one input, whole.
        charset (_Charset): the codec source charset.
        encoder (_Encoder): the target, shared by every input.
        omit (bool): ``-c``.
    """
    decoder = codecs.getincrementaldecoder(charset.name)("strict")
    unit = _unit_of(charset)
    out = bytearray()
    dropped = False
    start = 0
    pos = 0
    while pos < len(raw):
        try:
            text = decoder.decode(raw[pos : pos + 1])
        except UnicodeDecodeError:
            if not omit:
                return _Converted(
                    bytes(out),
                    dropped,
                    f"illegal input sequence at position {start}",
                )
            dropped = True
            decoder.reset()
            pos = start = start + unit
            continue
        pos += 1
        if not text:
            continue
        for char in text:
            data = encoder.encode_char(ord(char))
            if data is None:
                if not omit:
                    return _Converted(
                        bytes(out),
                        dropped,
                        f"illegal input sequence at position {start}",
                    )
                dropped = True
            else:
                out += data
        start = pos
    try:
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return _Converted(bytes(out), dropped, _INCOMPLETE)
    return _Converted(bytes(out), dropped, None)


_Encoder = _HandEncoder | _CodecEncoder


def _convert(
    raw: bytes, charset: _Charset, encoder: _Encoder, omit: bool
) -> _Converted:
    text = _bulk_text(raw, charset)
    if text is not None:
        data = encoder.encode_text(text) if text else b""
        if data is not None:
            return _Converted(data, False, None)
    if charset.by_hand:
        return _walk_by_hand(raw, charset.name, encoder, omit)
    return _walk_codec(raw, charset, encoder, omit)


async def iconv(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    from_enc: str = "utf-8",
    to_enc: str = "utf-8",
    ignore_errors: bool = False,
    output_path: PathSpec | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Convert each input from one charset to another, in order.

    Follows glibc's iconv: ``-c`` drops what cannot be converted and exits
    1; without it the output stops before the first such sequence, which
    is reported by its byte offset in that input, and no later input is
    read. An input that cannot be opened is reported and skipped; one
    that opens and then refuses the read, a directory, ends the run. A
    stateful target is closed with its reset sequence either way.
    Deliberate divergence: with no ``-f`` or ``-t`` the charset is UTF-8,
    where GNU takes the locale's (ASCII under ``LC_ALL=C``).

    Args:
        paths (list[PathSpec]): input operands, empty for stdin.
        read_bytes (Callable[..., Awaitable[bytes]]): reads one operand.
        write_bytes (Callable[..., Awaitable[None]]): writes ``-o``.
        stdin (ByteSource | None): standard input.
        from_enc (str): ``-f``.
        to_enc (str): ``-t``.
        ignore_errors (bool): ``-c``.
        output_path (PathSpec | None): ``-o``.
    """
    source = _charset_of(from_enc)
    target = _charset_of(to_enc)
    if source is None or target is None:
        return None, IOResult(
            exit_code=1,
            stderr=_unsupported(from_enc, to_enc, source is not None),
        )
    encoder: _Encoder = (
        _HandEncoder(target.name)
        if target.by_hand
        else _CodecEncoder(target.name)
    )
    read = stdin_bytes(read_bytes, stdin)
    out = bytearray()
    errors: list[str] = []
    failed = False
    operands: list[PathSpec | None] = [*paths] if paths else [None]
    for path in operands:
        if path is None:
            raw = await read_stdin_async(stdin) or b""
        else:
            try:
                raw = await read(path)
            except READ_FAILURES as exc:
                errors.append(
                    f"iconv: error while reading the input: {fs_strerror(exc)}"
                )
                failed = True
                break
            except FS_ERRORS as exc:
                errors.append(
                    f"iconv: cannot open input file `{path.raw_path}': "
                    f"{fs_strerror(exc)}"
                )
                failed = True
                continue
        converted = _convert(raw, source, encoder, ignore_errors)
        out += converted.data
        failed = failed or converted.dropped
        if converted.error is not None:
            errors.append(f"iconv: {converted.error}")
            failed = True
            break
    out += encoder.finish()
    stderr = "".join(f"{line}\n" for line in errors).encode() or None
    encoded = bytes(out)
    if output_path is not None:
        await write_bytes(output_path, encoded)
        return None, IOResult(
            exit_code=int(failed),
            stderr=stderr,
            writes={output_path.mount_path: encoded},
        )
    return encoded, IOResult(exit_code=int(failed), stderr=stderr)


__all__ = ["iconv"]


@dataclass(frozen=True, slots=True)
class IconvFlags:
    from_enc: str = "utf-8"
    to_enc: str = "utf-8"
    ignore_errors: bool = False
    output_path: PathSpec | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> IconvFlags:
    fl = FlagView(flags, spec=SPECS["iconv"])
    output = fl.raw("o")
    return IconvFlags(
        from_enc=fl.as_str("f") or "utf-8",
        to_enc=fl.as_str("t") or "utf-8",
        ignore_errors=fl.as_bool("c"),
        output_path=output if isinstance(output, PathSpec) else None,
    )


async def iconv_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await iconv(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        stdin=opts.stdin,
        from_enc=parsed.from_enc,
        to_enc=parsed.to_enc,
        ignore_errors=parsed.ignore_errors,
        output_path=parsed.output_path,
    )
