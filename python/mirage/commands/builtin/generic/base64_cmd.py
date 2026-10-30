from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import split_readable
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.rs import StreamRefusal, run_stream
from mirage.rs.scan import refused, scan
from mirage.types import JsonValue, PathSpec, ReadStreamFn, StatFn

# GNU base64's line length when -w names none.
WRAP_WIDTH = 76


async def _base64_encode_stream(
    source: AsyncIterator[bytes], wrap: int | None
) -> AsyncIterator[bytes]:
    config: dict[str, JsonValue] = {
        "mode": "encode",
        "wrap": WRAP_WIDTH if wrap is None else wrap,
    }
    async with aclosing(run_stream("base64", config, source)) as parts:
        async for part in parts:
            yield part


async def _base64_decode_stream(
    source: AsyncIterator[bytes], ignore_garbage: bool, io: IOResult
) -> AsyncIterator[bytes]:
    # A refusal carries what decoded before the invalid input: record the
    # failure first, then pass that prefix on, as GNU 9.7 writes it.
    config: dict[str, JsonValue] = {
        "mode": "decode",
        "ignore_garbage": ignore_garbage,
    }
    try:
        async with aclosing(run_stream("base64", config, source)) as parts:
            async for part in parts:
                yield part
    except StreamRefusal as refusal:
        io.exit_code, io.stderr = 1, f"{refusal.message}\n".encode()
        if refusal.output:
            yield refusal.output


async def base64_cmd(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    decode: bool = False,
    wrap: int | None = None,
    ignore_garbage: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(
            CommandName.BASE64, paths[1].raw_path or paths[1].virtual
        )
    if wrap is not None and wrap < 0:
        return None, IOResult(
            exit_code=1,
            stderr=f"base64: invalid wrap size: '{wrap}'\n".encode(),
        )
    if paths:
        source: AsyncIterator[bytes] = stdin_stream(read_stream, stdin)(
            paths[0]
        )
    else:
        source = resolve_source(stdin)

    if decode:
        io = IOResult()
        return _base64_decode_stream(source, ignore_garbage, io), io
    return _base64_encode_stream(source, wrap=wrap), IOResult()


__all__ = ["base64_cmd"]


@dataclass(frozen=True, slots=True)
class Base64Flags:
    decode: bool = False
    wrap: int | None = None
    ignore_garbage: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> Base64Flags | IOResult:
    """base64's options, -w read by mirage-rs before any operand is resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        Base64Flags | IOResult: the flags, or base64's refusal of a -w.
    """
    fl = FlagView(flags, spec=SPECS["base64"])
    try:
        wrap = scan("base64", fl.texts("wrap")).get("wrap")
    except StreamRefusal as refusal:
        return refused(refusal)
    return Base64Flags(
        decode=fl.as_bool("D") or fl.as_bool("decode"),
        wrap=wrap if isinstance(wrap, int) else None,
        ignore_garbage=fl.as_bool("ignore_garbage"),
    )


async def base64_generic(
    parsed: Base64Flags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: ReadStreamFn,
    stat: StatFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run base64 over its one operand, GNU semantics; mirrors base64Generic.

    The operand is stat'ed before the lazy encode starts, so a missing or
    unreadable one is reported in base64's own words (``base64: nope: No
    such file or directory``) instead of surfacing mid-drain.

    Args:
        parsed (Base64Flags): the options, read before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by base64.
        ctx (Context): Flags and stdin from the dispatcher.
        read_stream (ReadStreamFn): Bound reader called as
            ``read_stream(path)``.
        stat (StatFn): Bound stat called as ``stat(path)``.
    """
    if len(paths) == 1:
        _, err = await split_readable(paths, stdin_stat(stat), "base64")
        if err:
            return None, IOResult(exit_code=1, stderr=err)
    return await base64_cmd(
        paths,
        read_stream=read_stream,
        stdin=ctx.stdin,
        decode=parsed.decode,
        wrap=parsed.wrap,
        ignore_garbage=parsed.ignore_garbage,
    )
