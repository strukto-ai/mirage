import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Protocol

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import resolve_path


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


def _resolve_check_target(filename: str, cwd: str,
                          mount_prefix: str) -> PathSpec:
    """PathSpec for a recorded name, resolved like GNU against the cwd.

    Args:
        filename (str): the name exactly as the checksum file records it.
        cwd (str): the invoking command's working directory.
        mount_prefix (str): the checksum file's mount prefix.
    """
    virtual = resolve_path(filename, cwd)
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=mount_key(virtual, mount_prefix))


def _count_noun(count: int, singular: str, plural: str) -> str:
    return singular if count == 1 else f"{count} {plural}"


async def _hash_check(
    path: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    factory: DigestFactory,
    algorithm: str,
    cwd: str,
    strict: bool,
    ignore_missing: bool,
    status: bool,
    quiet: bool,
    warn: bool,
) -> tuple[bytes, bytes | None, int]:
    prog = f"{algorithm}sum"
    data = (await read_bytes(path)).decode(errors="replace")
    mount_prefix = mount_prefix_of(path.virtual, path.resource_path)
    check_label = path.raw_path or path.virtual
    lines: list[str] = []
    stderr_lines: list[str] = []
    parsed_lines = 0
    verified = 0
    mismatched = 0
    read_failures = 0
    malformed = 0
    for lineno, line in enumerate(split_lines(data), start=1):
        if not line.strip():
            continue
        parsed = _parse_check_line(line, algorithm)
        if parsed is None:
            malformed += 1
            if warn:
                stderr_lines.append(
                    f"{prog}: {check_label}: {lineno}: improperly formatted "
                    f"{algorithm.upper()} checksum line")
            continue
        parsed_lines += 1
        expected_hash, filename = parsed
        target = _resolve_check_target(filename, cwd, mount_prefix)
        h = factory()
        try:
            async for chunk in read_stream(target):
                h.update(chunk)
        except WALK_ERRORS as exc:
            # GNU --ignore-missing skips only absence; a permission or
            # transport-shaped failure still reports and fails the check.
            if ignore_missing and isinstance(exc,
                                             (FileNotFoundError, ValueError)):
                continue
            strerror = fs_strerror(exc) or str(exc)
            stderr_lines.append(f"{prog}: {filename}: {strerror}")
            lines.append(f"{filename}: FAILED open or read")
            read_failures += 1
            continue
        if h.hexdigest() == expected_hash:
            verified += 1
            if not quiet:
                lines.append(f"{filename}: OK")
        else:
            lines.append(f"{filename}: FAILED")
            mismatched += 1
    # GNU's terminal diagnostics and WARNING block, in its order (pinned
    # against coreutils 9.7): a file with no properly formatted line is
    # fatal on its own, even under --status. "No file was verified" means
    # --ignore-missing left zero OK lines — mismatches included — and
    # follows the summaries; --status silences it (and the summaries, but
    # not the per-file strerror lines) while its exit 1 stands.
    if not parsed_lines:
        stderr_lines.append(
            f"{prog}: {check_label}: no properly formatted checksum lines "
            "found")
        return b"", ("\n".join(stderr_lines) + "\n").encode(), 1
    nothing_verified = ignore_missing and not verified
    if not status:
        if malformed:
            noun = _count_noun(malformed, "1 line is", "lines are")
            stderr_lines.append(
                f"{prog}: WARNING: {noun} improperly formatted")
        if read_failures:
            noun = _count_noun(read_failures, "1 listed file", "listed files")
            stderr_lines.append(f"{prog}: WARNING: {noun} could not be read")
        if mismatched:
            noun = _count_noun(mismatched, "1 computed checksum",
                               "computed checksums")
            stderr_lines.append(f"{prog}: WARNING: {noun} did NOT match")
        if nothing_verified:
            stderr_lines.append(f"{prog}: {check_label}: no file was verified")
    stderr = ("\n".join(stderr_lines) +
              "\n").encode() if stderr_lines else None
    exit_code = 1 if (mismatched or read_failures or nothing_verified or
                      (strict and malformed)) else 0
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
    cwd: PathSpec | str = "/",
) -> tuple[ByteSource | None, IOResult]:
    if check and paths:
        cwd_dir = cwd.virtual if isinstance(cwd, PathSpec) else (cwd or "/")
        out, stderr, exit_code = await _hash_check(paths[0], read_bytes,
                                                   read_stream, factory,
                                                   algorithm, cwd_dir, strict,
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
