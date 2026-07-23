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


DigestFactory = Callable[..., Digest]


def _hash_line(digest: str, label: str, algorithm: str, binary: bool,
               tag: bool, zero: bool) -> bytes:
    if tag:
        return f"{algorithm.upper()} ({label}) = {digest}\n".encode()
    marker = "*" if binary else " "
    ending = "\0" if zero else "\n"
    return f"{digest} {marker}{label}{ending}".encode()


async def _hash_stream(source: AsyncIterator[bytes], label: str,
                       factory: DigestFactory, algorithm: str, binary: bool,
                       tag: bool, zero: bool) -> AsyncIterator[bytes]:
    h = factory()
    async for chunk in source:
        h.update(chunk)
    yield _hash_line(h.hexdigest(), label, algorithm, binary, tag, zero)


async def _hash_multi(
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    factory: DigestFactory,
    algorithm: str,
    binary: bool,
    tag: bool,
    zero: bool,
) -> AsyncIterator[bytes]:
    for p in paths:
        h = factory()
        async for chunk in read_stream(p):
            h.update(chunk)
        yield _hash_line(h.hexdigest(), p.raw_path, algorithm, binary, tag,
                         zero)


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
    strict: bool,
    ignore_missing: bool,
    status: bool,
    quiet: bool,
    warn: bool,
) -> tuple[bytes, bytes | None, int]:
    data = (await read_bytes(path)).decode(errors="replace")
    mount_prefix = mount_prefix_of(
        path.virtual, path.resource_path) if isinstance(path, PathSpec) else ""
    lines: list[str] = []
    failed = False
    malformed = 0
    for line in split_lines(data):
        if not line.strip():
            continue
        match = line.split(" ", 1)
        if len(match) != 2 or not match[1] or match[1][0] not in {" ", "*"}:
            malformed += 1
            continue
        expected_hash, filename = match[0], match[1][1:]
        target = _resolve_check_target(filename, mount_prefix)
        h = factory()
        try:
            async for chunk in read_stream(target):
                h.update(chunk)
        except FileNotFoundError:
            if ignore_missing:
                continue
            lines.append(f"{filename}: FAILED open or read")
            failed = True
            continue
        if h.hexdigest() == expected_hash:
            if not quiet:
                lines.append(f"{filename}: OK")
        else:
            lines.append(f"{filename}: FAILED")
            failed = True
    stderr = None
    if warn and malformed:
        count = f"{malformed} lines are" if malformed != 1 else "1 line is"
        stderr = f"WARNING: {count} improperly formatted\n".encode()
    exit_code = 1 if failed or (strict and malformed) else 0
    output = b"" if status else (("\n".join(lines) +
                                  "\n").encode() if lines else b"")
    return output, stderr, exit_code


async def hashsum(
    paths: list[PathSpec],
    *,
    factory: DigestFactory,
    algorithm: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    check: bool = False,
    binary: bool = False,
    tag: bool = False,
    zero: bool = False,
    strict: bool = False,
    ignore_missing: bool = False,
    status: bool = False,
    quiet: bool = False,
    warn: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if check and paths:
        out, stderr, exit_code = await _hash_check(paths[0], read_bytes,
                                                   read_stream, factory,
                                                   strict, ignore_missing,
                                                   status, quiet, warn)
        return out, IOResult(exit_code=exit_code, stderr=stderr)
    if paths:
        return _hash_multi(paths, read_stream, factory, algorithm, binary, tag,
                           zero), IOResult(cache=[p.mount_path for p in paths])
    source = _resolve_source(stdin)
    return _hash_stream(source, "-", factory, algorithm, binary, tag,
                        zero), IOResult()


__all__ = ["Digest", "DigestFactory", "hashsum"]
