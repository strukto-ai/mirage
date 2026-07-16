from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _alpha_suffix(index: int, length: int) -> str:
    chars: list[str] = []
    for _ in range(length):
        chars.append(chr(ord("a") + index % 26))
        index //= 26
    return "".join(reversed(chars))


def _numeric_suffix(index: int, length: int) -> str:
    return str(index).zfill(length)


async def split(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    lines_per_file: int = 0,
    byte_limit: int = 0,
    n_chunks: int = 0,
    suffix_len: int = 2,
    numeric_suffix: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.SPLIT, paths[2].raw_path
                                  or paths[2].virtual)
    prefix_name = paths[1].mount_path if len(paths) >= 2 else "x"
    if lines_per_file == 0 and byte_limit == 0 and n_chunks == 0:
        lines_per_file = 1000
    suffix_fn = _numeric_suffix if numeric_suffix else _alpha_suffix

    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
    else:
        source = _resolve_source(stdin)

    writes: dict[str, ByteSource] = {}
    file_idx = 0

    if n_chunks > 0:
        all_data = bytearray()
        async for chunk in source:
            all_data.extend(chunk)
        total = len(all_data)
        chunk_size = max(1, (total + n_chunks - 1) // n_chunks)
        offset = 0
        for i in range(n_chunks):
            part = bytes(all_data[offset:offset + chunk_size])
            if not part:
                break
            out_path = prefix_name + suffix_fn(i, suffix_len)
            await write_bytes(accessor, PathSpec.from_str_path(out_path), part)
            writes[out_path] = part
            offset += chunk_size
    elif byte_limit > 0:
        buf = bytearray()
        async for chunk in source:
            buf.extend(chunk)
            while len(buf) >= byte_limit:
                out_path = prefix_name + suffix_fn(file_idx, suffix_len)
                data = bytes(buf[:byte_limit])
                await write_bytes(accessor, PathSpec.from_str_path(out_path),
                                  data)
                writes[out_path] = data
                buf = buf[byte_limit:]
                file_idx += 1
        if buf:
            out_path = prefix_name + suffix_fn(file_idx, suffix_len)
            data = bytes(buf)
            await write_bytes(accessor, PathSpec.from_str_path(out_path), data)
            writes[out_path] = data
    else:
        line_buf: list[bytes] = []
        async for line in AsyncLineIterator(source):
            line_buf.append(line)
            if len(line_buf) >= lines_per_file:
                out_path = prefix_name + suffix_fn(file_idx, suffix_len)
                data = b"\n".join(line_buf) + b"\n"
                await write_bytes(accessor, PathSpec.from_str_path(out_path),
                                  data)
                writes[out_path] = data
                line_buf = []
                file_idx += 1
        if line_buf:
            out_path = prefix_name + suffix_fn(file_idx, suffix_len)
            data = b"\n".join(line_buf) + b"\n"
            await write_bytes(accessor, PathSpec.from_str_path(out_path), data)
            writes[out_path] = data

    return None, IOResult(writes=writes)


__all__ = ["split"]
