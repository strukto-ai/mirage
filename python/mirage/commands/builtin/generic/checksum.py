from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Protocol

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


class Digest(Protocol):

    def update(self, data: bytes) -> None:
        ...

    def hexdigest(self) -> str:
        ...


DigestFactory = Callable[[], Digest]


async def _hash_stream(source: AsyncIterator[bytes], label: str,
                       factory: DigestFactory) -> AsyncIterator[bytes]:
    h = factory()
    async for chunk in source:
        h.update(chunk)
    yield (h.hexdigest() + "  " + label + "\n").encode()


async def _hash_multi(
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    factory: DigestFactory,
) -> AsyncIterator[bytes]:
    for p in paths:
        h = factory()
        async for chunk in read_stream(p):
            h.update(chunk)
        yield (h.hexdigest() + "  " + p.raw_path + "\n").encode()


def _resolve_check_target(filename: str, mount_prefix: str) -> str | PathSpec:
    if mount_prefix and filename.startswith(mount_prefix + "/"):
        return PathSpec(virtual=filename,
                        directory=filename,
                        resource_path=mount_key(filename, mount_prefix))
    return filename


async def _hash_check(
    path: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    factory: DigestFactory,
) -> tuple[bytes, int]:
    data = (await read_bytes(path)).decode(errors="replace")
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
        h = factory()
        async for chunk in read_stream(target):
            h.update(chunk)
        if h.hexdigest() == expected_hash:
            lines.append(f"{filename}: OK")
        else:
            lines.append(f"{filename}: FAILED")
            failed = True
    return ("\n".join(lines) + "\n").encode(), 1 if failed else 0


async def hashsum(
    paths: list[PathSpec],
    *,
    factory: DigestFactory,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    check: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if check and paths:
        out, exit_code = await _hash_check(paths[0], read_bytes, read_stream,
                                           factory)
        return out, IOResult(exit_code=exit_code)
    if paths:
        return _hash_multi(
            paths, read_stream,
            factory), IOResult(cache=[p.mount_path for p in paths])
    source = _resolve_source(stdin)
    return _hash_stream(source, "-", factory), IOResult()


__all__ = ["Digest", "DigestFactory", "hashsum"]
