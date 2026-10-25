import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

from pydantic import TypeAdapter

from mirage.commands.builtin.rg_search import (
    RgBinary,
    RgFlags,
    Tally,
    Totals,
    folds_case,
    transcoded,
)
from mirage.commands.errors import UsageError
from mirage.io.stream import close_quietly, discard_streams
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, open_stream
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class SearchHints:
    texts: list[str]
    whole_word: bool
    ignore_case: bool


@dataclass(frozen=True, slots=True)
class Compiled:
    terms: SearchHints | None


COMPILED = TypeAdapter(Compiled)
TALLY = TypeAdapter(Tally)
BLOCK_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class RgProgram:
    stream: OpenStream


def latin1(text: str) -> str:
    return encode_text(text).decode("latin-1")


def stream_config(
    pattern: str,
    never_match: bool,
    f: RgFlags,
    regex_size_limit: int | None = None,
    dfa_size_limit: int | None = None,
) -> dict[str, JsonValue]:
    # PCRE2 folds as -S reads the pattern here, which the default engine
    # works out itself; --engine auto hands it the same answer.
    pcre = f.engine != "default"
    config: dict[str, JsonValue] = {
        "engine": f.engine,
        "ignore_case": (
            folds_case(pattern, f.fixed_string, f) if pcre else f.ignore_case
        ),
        "smart_case": f.smart_case and not pcre,
        "whole_word": f.whole_word,
        "line_regexp": f.line_regexp,
        "fixed_string": f.fixed_string,
        "unicode": f.unicode,
        "multiline": f.multiline,
        "multiline_dotall": f.multiline_dotall,
        "crlf": f.crlf,
        "null_data": f.null_data,
        "invert": f.invert,
        "line_numbers": f.line_numbers,
        "column": f.column,
        "vimgrep": f.vimgrep,
        "byte_offsets": f.byte_offsets,
        "only_matching": f.only_matching,
        "trim": f.trim,
        "max_columns_preview": f.max_columns_preview,
        "null": f.null,
        "quiet": f.quiet,
        "count_only": f.count_only,
        "count_matches": f.count_matches,
        "include_zero": f.include_zero,
        "files_only": f.files_only,
        "files_without_match": f.files_without_match,
        "heading": f.heading,
        "passthru": f.passthru,
        "stop_on_nonmatch": f.stop_on_nonmatch,
        "stats": f.stats,
        "json": f.json,
        "max_columns": f.max_columns,
        "max_count": f.max_count,
        "context_after": f.context_after,
        "context_before": f.context_before,
    }
    config.update(
        pattern=pattern,
        never_match=never_match,
        ban_nul=not (f.text or f.null_data),
        regex_size_limit=regex_size_limit,
        dfa_size_limit=dfa_size_limit,
        replace=None if f.replace is None else latin1(f.replace),
        context_separator=(
            None
            if f.context_separator is None
            else latin1(f.context_separator)
        ),
        field_match_separator=latin1(f.field_match_separator),
        field_context_separator=latin1(f.field_context_separator),
    )
    return config


def open_rg(
    pattern: str,
    never_match: bool,
    f: RgFlags,
    regex_size_limit: int | None = None,
    dfa_size_limit: int | None = None,
) -> RgProgram:
    try:
        pattern.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise UsageError("rg: pattern given is not valid UTF-8") from exc
    try:
        return RgProgram(
            open_stream(
                "rg",
                stream_config(
                    pattern, never_match, f, regex_size_limit, dfa_size_limit
                ),
            )
        )
    except StreamRefusal as exc:
        raise UsageError(f"rg: {exc.message}") from exc


def settle(stream: OpenStream, tally: Tally) -> None:
    progress = TALLY.validate_json(stream.metadata())
    tally.selected = progress.selected
    tally.binary = progress.binary
    tally.skipped = progress.skipped
    tally.matches = progress.matches
    tally.matched_lines = progress.matched_lines
    tally.searched = progress.searched
    tally.nul = progress.nul
    tally.error = progress.error


async def drained(
    stream: OpenStream, output: bytes, tally: Tally, budget: YieldBudget
) -> AsyncIterator[bytes]:
    while True:
        if output:
            settle(stream, tally)
            yield output
        if not stream.busy():
            return
        await budget.run()
        output = stream.drain()


def binary_metadata(binary: RgBinary) -> dict[str, JsonValue]:
    return {
        "binary_offset": binary.offset,
        "binary_converted": binary.converted,
        "binary_skipped": binary.skipped,
    }


async def stream_haystack(
    source: AsyncIterator[bytes],
    program: RgProgram,
    f: RgFlags,
    name: str,
    label: str | None,
    tally: Tally,
    named: bool,
    pipe: bool,
) -> AsyncIterator[bytes]:
    stream = program.stream
    binary = RgBinary(
        "text"
        if f.text or f.null_data
        else "note"
        if f.json and (named or f.binary)
        else "convert"
        if named or f.binary
        else "quit"
    )
    stream.begin(
        {
            "name": latin1(name),
            "label": None if label is None else latin1(label),
            "binary_mode": binary.mode,
            **binary_metadata(binary),
        }
    )
    reader = binary.read(
        source if f.encoding == "none" else transcoded(source, f.encoding),
        pipe,
    )
    budget = YieldBudget()
    try:
        if not stream.done():
            async for chunk in reader:
                stream.feed_input(
                    1, json.dumps(binary_metadata(binary)).encode()
                )
                for offset in range(0, len(chunk), BLOCK_BYTES):
                    if stream.done():
                        break
                    await budget.run()
                    async for output in drained(
                        stream,
                        stream.feed(chunk[offset : offset + BLOCK_BYTES]),
                        tally,
                        budget,
                    ):
                        yield output
                if stream.done():
                    break
        stream.feed_input(1, json.dumps(binary_metadata(binary)).encode())
        async for output in drained(stream, stream.finish(), tally, budget):
            yield output
    except BaseException as exc:
        if not isinstance(exc, GeneratorExit):
            await discard_streams(source)
        raise
    finally:
        settle(stream, tally)
        await close_quietly(reader)
        await close_quietly(source)


def format_output(program: RgProgram, message: dict[str, JsonValue]) -> bytes:
    return program.stream.feed_input(2, json.dumps(message).encode())


def totals_config(totals: Totals) -> dict[str, JsonValue]:
    return {
        "matches": totals.matches,
        "matched_lines": totals.matched_lines,
        "with_match": totals.with_match,
        "searched": totals.searched,
        "printed": totals.printed,
        "bytes_searched": totals.bytes_searched,
        "elapsed": totals.elapsed,
    }


def format_totals(
    totals: Totals, kind: Literal["summary", "stats"], total: float
) -> bytes:
    stream = open_stream("rg_format", {})
    return stream.feed(
        json.dumps(
            {"kind": kind, "totals": totals_config(totals), "total": total}
        ).encode()
    )


def required_terms(program: RgProgram) -> SearchHints | None:
    return COMPILED.validate_json(program.stream.metadata()).terms
