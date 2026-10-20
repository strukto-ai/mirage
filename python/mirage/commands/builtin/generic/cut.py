from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    reported_stream,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.word_choice import WordMatch, match_word
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, open_stream, stream_output
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

WHITESPACE_ARGS = ("trimmed",)


@dataclass(frozen=True, slots=True)
class CutFlags:
    ranges: str
    mode: str
    delimiter: str = "\t"
    complement: bool = False
    only_delimited: bool = False
    whitespace: str | None = None
    no_partial: bool = False
    output_delimiter: str | None = None
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CutFlags:
    fl = FlagView(flags, spec=SPECS["cut"])
    bytes_range = fl.as_str("bytes")
    chars_range = fl.as_str("characters")
    whitespace_fields = fl.as_str("F")
    fields_range = (
        whitespace_fields
        if whitespace_fields is not None
        else fl.as_str("fields")
    )
    modes = [
        ("bytes", bytes_range),
        ("characters", chars_range),
        ("fields", fields_range),
    ]
    selected = [(mode, value) for mode, value in modes if value is not None]
    if not selected:
        raise ValueError(
            "cut: you must specify a list of bytes, characters, or fields"
        )
    if len(selected) > 1:
        raise ValueError("cut: only one type of list may be specified")
    mode, ranges = selected[0]
    raw_whitespace = fl.raw("whitespace_delimited")
    whitespace: str | None = None
    if fl.as_bool("w") or fl.as_str("F") is not None or raw_whitespace is True:
        whitespace = "default"
    elif isinstance(raw_whitespace, str):
        if not isinstance(
            match_word(raw_whitespace, WHITESPACE_ARGS), WordMatch
        ):
            raise ValueError(
                f"cut: invalid argument "
                f"'{quote_text(raw_whitespace)}' for "
                "'--whitespace-delimited'"
            )
        whitespace = "trimmed"
    if whitespace is not None and mode != "fields":
        raise ValueError("cut: '-w' is only meaningful with fields")
    output_delimiter = fl.as_str("args_O")
    if output_delimiter is None:
        output_delimiter = fl.as_str("output_delimiter")
    if fl.as_str("F") is not None and output_delimiter is None:
        output_delimiter = " "
    # GNU reads an empty -d or --output-delimiter as its terminating NUL:
    # `cut -d ''` splits on NUL bytes and writes one between fields.
    if output_delimiter == "":
        output_delimiter = "\0"
    explicit_delimiter = fl.as_str("delimiter")
    if explicit_delimiter == "":
        explicit_delimiter = "\0"
    if explicit_delimiter is not None and len(explicit_delimiter) != 1:
        raise ValueError("cut: the delimiter must be a single character")
    return CutFlags(
        ranges=ranges,
        mode=mode,
        delimiter=explicit_delimiter or "\t",
        complement=fl.as_bool("complement"),
        only_delimited=fl.as_bool("only_delimited"),
        whitespace=whitespace,
        no_partial=fl.as_bool("no_partial"),
        output_delimiter=output_delimiter,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def open_cut(
    flags: Mapping[str, FlagValue],
) -> tuple[dict[str, JsonValue], OpenStream, UnicodeEncodeError | None]:
    parsed = parse_flags(flags)
    output_delimiter: JsonValue = None
    encoding_error: UnicodeEncodeError | None = None
    if parsed.output_delimiter is not None:
        try:
            encoded = parsed.output_delimiter.encode()
        except UnicodeEncodeError as exc:
            encoding_error = exc
            output_delimiter = {"kind": "deferred_utf8_encoding_error"}
        else:
            output_delimiter = {"kind": "bytes", "value": byte_view(encoded)}
    config: dict[str, JsonValue] = {
        "list": byte_view(parsed.ranges),
        "mode": parsed.mode,
        "delimiter": [ord(parsed.delimiter)],
        "complement": parsed.complement,
        "only_delimited": parsed.only_delimited,
        "whitespace": parsed.whitespace,
        "no_partial": parsed.no_partial,
        "output_delimiter": output_delimiter,
        "zero_terminated": parsed.zero_terminated,
    }
    return config, open_stream("cut", config), encoding_error


def cut_output(
    engine: OpenStream,
    source: ByteSource,
    encoding_error: UnicodeEncodeError | None,
) -> OutputStream:
    output = stream_output(engine, source)

    async def chunks() -> AsyncIterator[bytes]:
        try:
            async with aclosing(output):
                async for chunk in output:
                    yield chunk
        except StreamRefusal:
            if encoding_error is None:
                raise
            raise encoding_error from None

    return OutputStream(chunks(), output.aclose)


def cut_sources(
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None,
    config: Mapping[str, JsonValue],
    engine: OpenStream,
    encoding_error: UnicodeEncodeError | None,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    read_stream = stdin_stream(read_stream, stdin)
    if not paths:
        return cut_output(engine, resolve_source(stdin), encoding_error), io

    async def outputs() -> AsyncIterator[bytes]:
        for index, path in enumerate(paths):
            current = engine if index == 0 else open_stream("cut", config)
            output = reported_stream(
                cut_output(current, read_stream(path), encoding_error),
                io,
                path,
                "cut",
            )
            try:
                async for chunk in output:
                    yield chunk
            finally:
                await close_quietly(output)

    return outputs(), io


async def cut(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    try:
        config, engine, encoding_error = open_cut(flags or {})
    except (TypeError, ValueError, StreamRefusal) as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    return cut_sources(
        paths, read_stream, stdin, config, engine, encoding_error
    )


async def cut_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run cut over resolved operands; mirrors cutGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by cut.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as ``stream(path)``.
    """
    try:
        config, engine, encoding_error = open_cut(ctx.flags)
    except (TypeError, ValueError, StreamRefusal) as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    readable, err = await split_readable(paths, stdin_stat(stat), "cut")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        cut_sources(
            readable,
            normalized_read(stream),
            ctx.stdin,
            config,
            engine,
            encoding_error,
        ),
        err,
    )


__all__ = ["cut", "cut_generic"]
