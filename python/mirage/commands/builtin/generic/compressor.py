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

from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.generic.decompress import (
    SetAttrsFn,
    beside_link,
    input_info,
    keep_attributes,
    output_taken,
    remove_input,
    replace_output,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.spool import ByteSpool
from mirage.io.stream import OutputStream, close_quietly, drain
from mirage.io.types import ByteSource, IOResult
from mirage.types import LineFacts, PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.compress import (
    GzipDataError,
    decode_stream,
    encode_stream,
)

# The keys a program's table answers, one for each way an input is refused.
OPEN = "open"
DIRECTORY = "directory"
LINK = "link"
HAS_SUFFIX = "has_suffix"
UNKNOWN_SUFFIX = "unknown_suffix"
OUTPUT_EXISTS = "output_exists"
CREATE = "create"
BAD_FORMAT = "bad_format"


@dataclass(frozen=True, slots=True)
class Refused:
    """What a decoder's failure comes to.

    Args:
        lines (str): what the program prints.
        code (int): the exit status it asks for.
        fatal (bool): whether the run ends here.
    """

    lines: str
    code: int
    fatal: bool = False


@dataclass(frozen=True, slots=True)
class Tool:
    """One compressor's words and names.

    Args:
        program (str): the name it was run under, which starts every line.
        codec (str): the stream format.
        words (Mapping[str, tuple[str, int]]): each refusal's line and
            exit status, with ``{p}`` for the program, ``{name}`` for the
            input, ``{out}`` for its output, ``{suffix}`` and ``{why}``.
        suffixes (Sequence[tuple[str, str]]): each ending decompression
            takes off and what it leaves in its place.
        first_error_sticks (bool): an error stays the exit status whatever
            a warning later says, where the other family keeps the highest.
        decode_failed (Callable): what a decoder's failure comes to, for
            the program, the input, its output (None for standard output)
            and whether the run only tests.
        silenced_at (Mapping[int, int]): how many ``-q`` hide a line, by
            its exit status; a status not here is never hidden.
        guessed_ending (str | None): what an input with no known ending
            gets instead of being passed over.
        magic (bytes | None): how the format starts, which an input with
            no known ending has to start with before its name is judged.
        summary (Callable | None): the ``-v`` line for a compressed input.
        decoded_note (Callable | None): the ``-v`` line for a tested or
            decompressed input.
    """

    program: str
    codec: str
    words: Mapping[str, tuple[str, int]]
    suffixes: Sequence[tuple[str, str]]
    first_error_sticks: bool
    decode_failed: Callable[
        [GzipDataError, str, str, str | None, bool], Refused
    ]
    silenced_at: Mapping[int, int]
    guessed_ending: str | None = None
    magic: bytes | None = None
    summary: Callable[[str, int, int, int], str] | None = None
    decoded_note: Callable[[str, int, bool], str] | None = None


@dataclass(frozen=True, slots=True)
class CompressorFiles:
    """The mount's operations a compressor needs.

    Args:
        read (PolymorphicReadFn): reads an input.
        write (Callable | None): writes an output.
        unlink (Callable | None): removes an input.
        stat (StatFn | None): stats a name.
        set_attrs (SetAttrsFn | None): sets an output's attributes.
    """

    read: PolymorphicReadFn
    write: Callable[..., Awaitable[None]] | None = None
    unlink: Callable[..., Awaitable[None]] | None = None
    stat: StatFn | None = None
    set_attrs: SetAttrsFn | None = None


@dataclass(frozen=True, slots=True)
class CompressorFlags:
    decompress: bool = False
    test: bool = False
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    quiet: int = 0
    verbose: int = 0
    level: int = -1
    suffix: str | None = None


def compressor_facts(
    fl: FlagView, operands: Sequence[str | PathSpec]
) -> LineFacts:
    """A compressor line replaces its operands unless ``-c`` or ``-t``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(
        writes=len(operands) > 0
        and not any(fl.as_bool(n) for n in ("stdout", "test"))
    )


def last_typed(fl: FlagView, *names: str) -> str | None:
    """Of a family where the last one typed wins, that one's key.

    Args:
        fl (FlagView): the line's flags.
        names (str): the family's flags.
    """
    typed = [name for name in fl.typed_order(*names) if fl.as_bool(name)]
    return typed[-1] if typed else None


def _ending_of(raw: str, tool: Tool, suffix: str | None) -> tuple[str, str]:
    """The ending decompression takes off a name and what it leaves, the
    ending empty when no known one fits.

    Args:
        raw (str): the input as typed.
        tool (Tool): the program.
        suffix (str | None): the ``-S`` suffix.
    """
    custom = () if suffix is None else ((suffix, ""),)
    for ending, swap in (*custom, *tool.suffixes):
        if raw.endswith(ending) and len(raw) > len(ending):
            return ending, swap
    return "", ""


def _exit_after(tool: Tool, current: int, code: int) -> int:
    if tool.first_error_sticks and 1 in (current, code):
        return 1
    return max(current, code)


def _renamed(path: str, ending: str, addition: str) -> str:
    return path[: len(path) - len(ending)] + addition


async def _counted(
    source: AsyncIterator[bytes], count: list[int]
) -> AsyncIterator[bytes]:
    try:
        async for chunk in source:
            count[0] += len(chunk)
            yield chunk
    finally:
        await close_quietly(source)


async def _resumed(
    first: bytes | None, rest: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    try:
        if first is not None:
            yield first
            async for chunk in rest:
                yield chunk
    finally:
        await close_quietly(rest)


async def compress_files(
    paths: list[PathSpec],
    tool: Tool,
    flags: CompressorFlags,
    files: CompressorFiles,
    stdin: ByteSource | None,
    resolver: LinkResolver | None,
) -> tuple[ByteSource | None, IOResult]:
    """Compress, decompress or test each operand, standard input for none
    or for ``-``, an in-place output replacing its input.

    Args:
        paths (list[PathSpec]): the operands.
        tool (Tool): the program.
        flags (CompressorFlags): its options.
        files (CompressorFiles): the mount's operations.
        stdin (ByteSource | None): the line's standard input.
        resolver (LinkResolver | None): the namespace's links.
    """
    operands = paths or [STDIN_OPERAND]
    source = normalized_read(files.read)
    piped = stdin_stream(source, stdin)
    decoding = flags.decompress or flags.test
    default_suffix = flags.suffix or tool.suffixes[0][0]
    longest = max(7, *(len(p.raw_path) for p in operands))
    io = IOResult()
    lines: list[str] = []

    def note(line: str) -> None:
        lines.append(line.removesuffix("\n"))
        io.stderr = format_records(lines)

    def report(line: str, code: int) -> None:
        io.exit_code = _exit_after(tool, io.exit_code, code)
        if flags.quiet < tool.silenced_at.get(code, flags.quiet + 1):
            note(line)

    def say(key: str, **fields: str) -> None:
        template, code = tool.words[key]
        report(template.format(p=tool.program, **fields), code)

    def told(name: str, read_in: int, written: int) -> None:
        if flags.verbose and decoding and tool.decoded_note is not None:
            note(tool.decoded_note(name, longest, flags.test))
        elif flags.verbose and not decoding and tool.summary is not None:
            note(tool.summary(name, read_in, written, longest))

    def naming(raw: str, head: bytes | None) -> tuple[str, str] | None:
        """What an in-place input's name loses and gains for its output,
        None when the input is passed over.

        Args:
            raw (str): the input as typed.
            head (bytes | None): the input's first chunk.
        """
        if not decoding:
            known = [e for e, _ in tool.suffixes if raw.endswith(e)]
            if flags.suffix is not None and raw.endswith(flags.suffix):
                known.insert(0, flags.suffix)
            if known:
                say(HAS_SUFFIX, name=raw, suffix=known[0])
                return None
            return "", default_suffix
        ending, swap = _ending_of(raw, tool, flags.suffix)
        if ending:
            return ending, swap
        if tool.magic is not None and not (head or b"").startswith(tool.magic):
            say(BAD_FORMAT, name=raw)
            return None
        say(UNKNOWN_SUFFIX, name=raw)
        guess = tool.guessed_ending
        return None if guess is None else ("", guess)

    async def run() -> AsyncIterator[bytes]:
        for p in operands:
            on_stdin = p.raw_path == "-"
            name = "(stdin)" if on_stdin else p.raw_path
            in_place = not (flags.to_stdout or flags.test or on_stdin)
            link = (
                resolver.link_at(p)
                if resolver is not None and not on_stdin
                else None
            )
            if link is not None and in_place and not flags.force:
                say(LINK, name=name)
                continue
            reading = (piped if on_stdin else source)(p)
            try:
                first = await anext(reading, None)
            except IsADirectoryError:
                say(DIRECTORY, name=name)
                continue
            except FS_ERRORS as exc:
                say(OPEN, name=name, why=fs_strerror(exc) or str(exc))
                continue
            opened = _resumed(first, reading)
            try:
                renaming = naming(p.raw_path, first) if in_place else None
                if in_place and renaming is None:
                    continue
                wanted = None
                out = None
                if renaming is not None:
                    wanted = _renamed(p.raw_path, *renaming)
                    out = (
                        beside_link(link, wanted)
                        if link is not None
                        else PathSpec.from_str_path(
                            "/" + _renamed(p.virtual, *renaming).strip("/")
                        )
                    )
                    existed = await output_taken(out, files.stat, resolver)
                    if existed and not flags.force:
                        say(OUTPUT_EXISTS, out=wanted, name=name)
                        continue
                info = (
                    None
                    if out is None
                    else await input_info(files.stat, p, link, resolver)
                )
                read_in = [0]
                written = [0]
                coded = _counted(
                    decode_stream(
                        _counted(opened, read_in), tool.codec, flags.test
                    )
                    if decoding
                    else encode_stream(
                        _counted(opened, read_in), tool.codec, flags.level
                    ),
                    written,
                )
                if out is None or wanted is None:
                    try:
                        async for chunk in coded:
                            if not flags.test:
                                yield chunk
                    except GzipDataError as exc:
                        refused = tool.decode_failed(
                            exc, tool.program, name, None, flags.test
                        )
                        report(refused.lines, refused.code)
                        if refused.fatal:
                            return
                        continue
                    told(name, read_in[0], written[0])
                    continue
                write, unlink = files.write, files.unlink
                if write is None or unlink is None:
                    raise ValueError(
                        "in-place compression requires write and unlink"
                    )
                async with ByteSpool() as spool:
                    try:
                        await spool.fill(coded)
                    except GzipDataError as exc:
                        refused = tool.decode_failed(
                            exc, tool.program, name, wanted, False
                        )
                        report(refused.lines, refused.code)
                        if refused.fatal:
                            return
                        continue
                    try:
                        await replace_output(
                            out,
                            spool.stream(),
                            write,
                            resolver,
                            link is not None,
                        )
                    except FS_ERRORS as exc:
                        say(
                            CREATE,
                            out=wanted,
                            why=fs_strerror(exc) or str(exc),
                        )
                        continue
                await keep_attributes(files.set_attrs, out, info)
                told(name, read_in[0], written[0])
                if not flags.keep:
                    await remove_input(p, link, unlink, resolver)
            finally:
                await close_quietly(opened)

    body = OutputStream(run(), partial(close_quietly, stdin))
    if not flags.to_stdout and all(p.raw_path != "-" for p in operands):
        await drain(body)
        return None, io
    return body, io
