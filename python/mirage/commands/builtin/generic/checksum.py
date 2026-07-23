import re
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
    ending = "\0" if zero else "\n"
    if tag:
        return f"{algorithm.upper()} ({label}) = {digest}{ending}".encode()
    marker = "*" if binary else " "
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


_PLAIN_LINE = re.compile(r"^([0-9a-fA-F]+) [ *](.*)$")


def _parse_check_line(line: str, algorithm: str) -> tuple[str, str] | None:
    """Split a checksum-file line into ``(expected_hash, filename)``.

    Accepts both the GNU default format (``<hex>  NAME`` / ``<hex> *NAME``)
    and the BSD/``--tag`` format (``ALGO (NAME) = <hex>``), matching what
    GNU ``*sum --check`` auto-detects.

    Args:
        line (str): One non-blank line from the checksum file.
        algorithm (str): Digest name, e.g. ``"md5"`` or ``"sha256"``.
    """
    tagged = re.match(
        rf"^{re.escape(algorithm.upper())} \((.*)\) = "
        r"([0-9a-fA-F]+)$", line)
    if tagged is not None:
        return tagged.group(2).lower(), tagged.group(1)
    plain = _PLAIN_LINE.match(line)
    if plain is None:
        return None
    return plain.group(1).lower(), plain.group(2)


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
    algorithm: str,
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
        parsed = _parse_check_line(line, algorithm)
        if parsed is None:
            malformed += 1
            continue
        expected_hash, filename = parsed
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
                                                   algorithm, strict,
                                                   ignore_missing, status,
                                                   quiet, warn)
        return out, IOResult(exit_code=exit_code, stderr=stderr)
    if paths:
        return _hash_multi(paths, read_stream, factory, algorithm, binary, tag,
                           zero), IOResult(cache=[p.mount_path for p in paths])
    source = _resolve_source(stdin)
    return _hash_stream(source, "-", factory, algorithm, binary, tag,
                        zero), IOResult()


__all__ = ["Digest", "DigestFactory", "hashsum"]
