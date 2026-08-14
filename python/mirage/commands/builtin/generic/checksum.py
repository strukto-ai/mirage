import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    normalized_read,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import resolve_path


@dataclass(frozen=True, slots=True)
class ChecksumFlags:
    check: bool = False
    binary: bool = False
    tag: bool = False
    zero: bool = False
    strict: bool = False
    ignore_missing: bool = False
    status: bool = False
    quiet: bool = False
    warn: bool = False


def parse_flags(flags: Mapping[str, FlagValue], name: str) -> ChecksumFlags:
    """Parse the shared ``*sum`` flag set against one command's spec.

    Args:
        flags (Mapping[str, FlagValue]): The raw flag bag.
        name (str): The invoked command (md5sum, sha256sum, ...), whose
            spec validates the names; all five declare the same set.
    """
    fl = FlagView(flags, spec=SPECS[name])
    return ChecksumFlags(
        check=fl.as_bool("check"),
        binary=fl.as_bool("binary"),
        tag=fl.as_bool("tag"),
        zero=fl.as_bool("zero"),
        strict=fl.as_bool("strict"),
        ignore_missing=fl.as_bool("ignore_missing"),
        status=fl.as_bool("status"),
        quiet=fl.as_bool("quiet"),
        warn=fl.as_bool("warn"),
    )


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


def _check_list_error(algorithm: str, path: PathSpec,
                      exc: BaseException) -> bytes:
    """GNU stderr line for a checksum-list operand that cannot be read.

    GNU verifies every ``--check`` operand in turn and keeps going when
    one cannot be read; a directory operand reports the literal ``read
    error`` (its ``fopen`` succeeds and the read fails), everything else
    reports the strerror (pinned on coreutils 9.7).

    Args:
        algorithm (str): digest name, e.g. ``"sha256"``.
        path (PathSpec): the list operand as resolved.
        exc (BaseException): the failure raised by the list read.
    """
    label = path.raw_path or path.virtual
    detail = ("read error" if isinstance(exc, IsADirectoryError) else
              (fs_strerror(exc) or str(exc)))
    return f"{algorithm}sum: {label}: {detail}\n".encode()


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
        outs: list[bytes] = []
        errs: list[bytes] = []
        exit_code = 0
        # Every operand is its own checksum list: GNU verifies each in
        # turn and keeps going when one cannot be read (coreutils 9.7).
        for p in paths:
            try:
                out, stderr, code = await _hash_check(p, read_bytes,
                                                      read_stream, factory,
                                                      algorithm, cwd_dir,
                                                      strict, ignore_missing,
                                                      status, quiet, warn)
            except WALK_ERRORS as exc:
                errs.append(_check_list_error(algorithm, p, exc))
                exit_code = 1
                continue
            outs.append(out)
            if stderr is not None:
                errs.append(stderr)
            if code:
                exit_code = 1
        return b"".join(outs), IOResult(exit_code=exit_code,
                                        stderr=b"".join(errs) or None)
    if paths:
        return _hash_multi(paths, read_stream, factory, algorithm, binary, tag,
                           zero), IOResult(cache=[p.mount_path for p in paths])
    source = _resolve_source(stdin)
    return _hash_stream(source, "-", factory, algorithm, binary, tag,
                        zero), IOResult()


async def hashsum_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    *,
    factory: DigestFactory,
    algorithm: str,
    name: str,
) -> tuple[ByteSource | None, IOResult]:
    """Run a GNU ``*sum`` over resolved operands; mirrors checksumGeneric.

    The wiring resolves globs and binds one backend reader; everything
    else lives here: flag parsing, the per-operand report-and-continue
    split, the ``--check`` verification pass (which resolves recorded
    names against ``opts.cwd``), and the stdin fallback.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by checksums.
        opts (CommandOpts): Flags, stdin and cwd from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        factory (DigestFactory): Digest constructor, e.g. hashlib.md5.
        algorithm (str): Digest name for rendered lines, e.g. ``"md5"``.
        name (str): The invoked command name, for its spec and stderr.
    """
    parsed = parse_flags(opts.flags, name)
    if parsed.check and paths:
        return await hashsum(paths,
                             factory=factory,
                             algorithm=algorithm,
                             read_bytes=materialized_read(stream),
                             read_stream=normalized_read(stream),
                             stdin=opts.stdin,
                             check=True,
                             strict=parsed.strict,
                             ignore_missing=parsed.ignore_missing,
                             status=parsed.status,
                             quiet=parsed.quiet,
                             warn=parsed.warn,
                             cwd=opts.cwd)
    readable, err = await split_readable(paths, stat, name)
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await hashsum(readable,
                      factory=factory,
                      algorithm=algorithm,
                      read_bytes=materialized_read(stream),
                      read_stream=normalized_read(stream),
                      stdin=opts.stdin,
                      binary=parsed.binary,
                      tag=parsed.tag,
                      zero=parsed.zero,
                      cwd=opts.cwd), err)


__all__ = ["Digest", "DigestFactory", "hashsum", "hashsum_generic"]
