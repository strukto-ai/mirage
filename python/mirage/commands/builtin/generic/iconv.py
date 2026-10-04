import codecs
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import read_stdin_async, stdin_bytes
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, READ_FAILURES, fs_strerror

_HINT = "Try `iconv --help' or `iconv --usage' for more information."
_INCOMPLETE = "incomplete character or shift sequence at end of buffer"


@dataclass(frozen=True, slots=True)
class _Converted:
    data: bytes
    dropped: bool
    error: str | None


def _charset_of(name: str) -> str | None:
    """The codec an iconv charset name selects, None when there is none.

    glibc's ``//TRANSLIT`` and ``//IGNORE`` suffixes are not supported.

    Args:
        name (str): the charset as typed.
    """
    try:
        return codecs.lookup(name).name
    except LookupError:
        return None


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


def _convert_slowly(
    raw: bytes,
    from_codec: str,
    encoder: codecs.IncrementalEncoder,
    omit: bool,
) -> _Converted:
    """Convert one input a byte at a time, as glibc reports it.

    An input sequence the source charset does not allow, or a character
    the target cannot hold, stops the conversion at that sequence's byte
    offset; ``-c`` drops it and goes on. A sequence cut off by the end of
    the input stops it either way.

    Args:
        raw (bytes): one input, whole.
        from_codec (str): the source codec.
        encoder (codecs.IncrementalEncoder): the target encoder, shared
            by every input so a BOM is written once.
        omit (bool): ``-c``.
    """
    decoder = codecs.getincrementaldecoder(from_codec)("strict")
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
            pos = start = start + 1
            continue
        pos += 1
        if not text:
            continue
        for char in text:
            try:
                out += encoder.encode(char)
            except UnicodeEncodeError:
                if not omit:
                    return _Converted(
                        bytes(out),
                        dropped,
                        f"illegal input sequence at position {start}",
                    )
                dropped = True
        start = pos
    try:
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return _Converted(bytes(out), dropped, _INCOMPLETE)
    return _Converted(bytes(out), dropped, None)


def _convert(
    raw: bytes,
    from_codec: str,
    encoder: codecs.IncrementalEncoder,
    omit: bool,
) -> _Converted:
    try:
        text = raw.decode(from_codec)
        return _Converted(encoder.encode(text) if text else b"", False, None)
    except (UnicodeDecodeError, UnicodeEncodeError):
        return _convert_slowly(raw, from_codec, encoder, omit)


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
    that opens and then refuses the read, a directory, ends the run.
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
    from_codec = _charset_of(from_enc)
    to_codec = _charset_of(to_enc)
    if from_codec is None or to_codec is None:
        return None, IOResult(
            exit_code=1,
            stderr=_unsupported(from_enc, to_enc, from_codec is not None),
        )
    encoder = codecs.getincrementalencoder(to_codec)("strict")
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
                    "iconv: error while reading the input: "
                    f"{fs_strerror(exc)}"
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
        converted = _convert(raw, from_codec, encoder, ignore_errors)
        out += converted.data
        failed = failed or converted.dropped
        if converted.error is not None:
            errors.append(f"iconv: {converted.error}")
            failed = True
            break
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
