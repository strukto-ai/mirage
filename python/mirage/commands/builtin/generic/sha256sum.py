import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _sha256_stream(source: AsyncIterator[bytes],
                         label: str) -> AsyncIterator[bytes]:
    h = hashlib.sha256()
    async for chunk in source:
        h.update(chunk)
    yield (h.hexdigest() + "  " + label + "\n").encode()


async def _sha256_multi(
    accessor: object,
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
) -> AsyncIterator[bytes]:
    for p in paths:
        h = hashlib.sha256()
        async for chunk in read_stream(accessor, p):
            h.update(chunk)
        yield (h.hexdigest() + "  " + p.display + "\n").encode()


def _resolve_check_target(filename: str, mount_prefix: str) -> str | PathSpec:
    if mount_prefix and filename.startswith(mount_prefix + "/"):
        return PathSpec(virtual=filename,
                        directory=filename,
                        resource_path=mount_key(filename, mount_prefix))
    return filename


async def _sha256_check(
    accessor: object,
    path: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
) -> tuple[bytes, int]:
    data = (await read_bytes(accessor, path)).decode(errors="replace")
    mount_prefix = mount_prefix_of(
        path.virtual, path.resource_path) if isinstance(path, PathSpec) else ""
    lines: list[str] = []
    failed = False
    for line in split_lines(data):
        if not line.strip():
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2:
            continue
        expected_hash, filename = parts
        target = _resolve_check_target(filename, mount_prefix)
        h = hashlib.sha256()
        async for chunk in read_stream(accessor, target):
            h.update(chunk)
        if h.hexdigest() == expected_hash:
            lines.append(f"{filename}: OK")
        else:
            lines.append(f"{filename}: FAILED")
            failed = True
    return ("\n".join(lines) + "\n").encode(), 1 if failed else 0


async def sha256sum(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    check: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if check and paths:
        out, exit_code = await _sha256_check(accessor, paths[0], read_bytes,
                                             read_stream)
        return out, IOResult(exit_code=exit_code)
    if paths:
        return _sha256_multi(
            accessor, paths,
            read_stream), IOResult(cache=[p.mount_path for p in paths])
    source = _resolve_source(stdin)
    return _sha256_stream(source, "-"), IOResult()


__all__ = ["sha256sum"]
