import base64 as b64lib
from collections.abc import AsyncIterator, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _base64_encode_stream(source: AsyncIterator[bytes],
                                wrap: int | None) -> AsyncIterator[bytes]:
    buf = b""
    async for chunk in source:
        buf += chunk
    encoded = b64lib.b64encode(buf).decode()
    if not encoded:
        return
    if wrap is not None and wrap == 0:
        yield encoded.encode() + b"\n"
        return
    line_len = wrap if wrap is not None else 76
    lines: list[str] = []
    for i in range(0, len(encoded), line_len):
        lines.append(encoded[i:i + line_len])
    yield "\n".join(lines).encode() + b"\n"


async def _base64_decode_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    buf = b""
    async for chunk in source:
        buf += chunk
    text = buf.replace(b"\n", b"").replace(b"\r", b"").replace(b" ", b"")
    yield b64lib.b64decode(text)


async def base64_cmd(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    decode: bool = False,
    wrap: int | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(CommandName.BASE64, paths[1].raw_path
                                  or paths[1].virtual)
    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        cache = [paths[0].mount_path]
    else:
        source = _resolve_source(stdin)

    if decode:
        return _base64_decode_stream(source), IOResult(cache=cache)
    return _base64_encode_stream(source, wrap=wrap), IOResult(cache=cache)


__all__ = ["base64_cmd"]
