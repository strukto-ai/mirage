import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.utils.constants import (
    STDIN_HEADER_NAME,
    STDIN_OPERAND,
)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.operands import (
    materialized_read,
    merge_split_errors,
    normalized_read,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_exit_code, usage_hint
from mirage.context.session_context import current_caller
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs import run_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn
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


# The options GNU refuses outside --check, in the order it checks them.
_CHECK_ONLY = (
    ("ignore_missing", "--ignore-missing"),
    ("status", "--status"),
    ("warn", "--warn"),
    ("quiet", "--quiet"),
    ("strict", "--strict"),
)


def _read_mode(fl: FlagView) -> str | None:
    """The last of -b, -t and --tag (which reads in binary mode), as
    GNU's option loop leaves its one mode.

    Args:
        fl (FlagView): The command's flags.
    """
    order = fl.typed_order("binary", "text", "tag")
    return order[-1] if order else None


def _refuse_conflicts(fl: FlagView, name: str) -> None:
    """Refuse the combinations GNU refuses after its option loop, in its
    order (coreutils 9.7).

    Args:
        fl (FlagView): The command's flags.
        name (str): The invoked command.

    Raises:
        UsageError: a combination GNU refuses.
    """

    def refuse(message: str) -> UsageError:
        return UsageError(
            f"{name}: {message}\n{usage_hint(name)}", usage_exit_code(name)
        )

    mode = _read_mode(fl)
    check = fl.as_bool("check")
    tag = fl.as_bool("tag")
    if tag and mode == "text":
        raise refuse("--tag does not support --text mode")
    if check and fl.as_bool("zero"):
        raise refuse(
            "the --zero option is not supported when verifying checksums"
        )
    if check and tag:
        raise refuse(
            "the --tag option is meaningless when verifying checksums"
        )
    if check and mode is not None:
        raise refuse(
            "the --binary and --text options are meaningless when "
            "verifying checksums"
        )
    for flag, word in _CHECK_ONLY:
        if not check and fl.as_bool(flag):
            raise refuse(
                f"the {word} option is meaningful only when verifying "
                "checksums"
            )


def parse_flags(flags: Mapping[str, FlagValue], name: str) -> ChecksumFlags:
    """Parse the shared ``*sum`` flag set against one command's spec.

    Args:
        flags (Mapping[str, FlagValue]): The raw flag bag.
        name (str): The invoked command (md5sum, sha256sum, ...), whose
            spec validates the names; all five declare the same set.

    Raises:
        UsageError: a combination GNU refuses.
    """
    fl = FlagView(flags, spec=SPECS[name])
    _refuse_conflicts(fl, name)
    return ChecksumFlags(
        check=fl.as_bool("check"),
        binary=_read_mode(fl) in ("binary", "tag"),
        tag=fl.as_bool("tag"),
        zero=fl.as_bool("zero"),
        strict=fl.as_bool("strict"),
        ignore_missing=fl.as_bool("ignore_missing"),
        status=fl.as_bool("status"),
        quiet=fl.as_bool("quiet"),
        warn=fl.as_bool("warn"),
    )


# The mount's stored digest of a file for an algorithm, or None to read it.
StoredDigest = Callable[[PathSpec, str], Awaitable[str | None]]


async def hash_source(source: ByteSource, algorithm: str) -> str:
    """Hash bounded chunks without collecting the source.

    Args:
        source (ByteSource): bytes or a producer consumed through EOF.
        algorithm (str): the digest name, e.g. ``"sha256"``.
    """
    config: dict[str, JsonValue] = {"algorithm": algorithm}
    async with aclosing(run_stream("digest", config, source)) as parts:
        hexdigest = b"".join([part async for part in parts])
    return hexdigest.decode()


async def _report(
    io: IOResult, prog: str, path: PathSpec, exc: OSError
) -> None:
    io.stderr = await materialize(io.stderr) + encode_text(
        fs_error_line(prog, path, exc)
    )
    io.exit_code = 1


async def hash_operands(
    paths: list[PathSpec],
    read: Callable[[PathSpec], ByteSource],
    algorithm: str,
    prog: str,
    render: Callable[[str, str], bytes],
    stored: StoredDigest | None = None,
) -> tuple[AsyncIterator[bytes], IOResult]:
    """One line per operand, its digest asked of ``stored`` before the
    file is read; one that fails is reported and the rest still print.

    Args:
        paths (list[PathSpec]): the operands, stdin as ``-``.
        read (Callable[[PathSpec], ByteSource]): an operand's bytes,
            opened now, inside the command's cache scope.
        algorithm (str): the digest name.
        prog (str): the command named on stderr.
        render (Callable[[str, str], bytes]): the line for a digest and
            the operand as spelled.
        stored (StoredDigest | None): the mount's stored digest.
    """
    io = IOResult()
    pending: list[tuple[PathSpec, str | None, ByteSource]] = []
    for p in paths:
        try:
            digest = (
                await stored(p, algorithm)
                if stored is not None and not is_stdin(p)
                else None
            )
        except FS_ERRORS as exc:
            await _report(io, prog, p, exc)
            continue
        pending.append((p, digest, b"" if digest is not None else read(p)))

    async def output() -> AsyncIterator[bytes]:
        for p, digest, source in pending:
            try:
                yield render(
                    digest
                    if digest is not None
                    else await hash_source(source, algorithm),
                    p.raw_path,
                )
            except FS_ERRORS as exc:
                await _report(io, prog, p, exc)

    return output(), io


def _hash_line(
    digest: str,
    label: str,
    algorithm: str,
    binary: bool,
    tag: bool,
    zero: bool,
) -> bytes:
    ending = "\0" if zero else "\n"
    if tag:
        return f"{algorithm.upper()} ({label}) = {digest}{ending}".encode()
    marker = "*" if binary else " "
    return f"{digest} {marker}{label}{ending}".encode()


_PLAIN_LINE = re.compile(r"^([0-9a-fA-F]+) [ *](.*)$")

# GNU reads a check line as properly formatted only when its digest has
# the algorithm's full length in hex.
HEX_DIGITS = {"md5": 32, "sha1": 40, "sha256": 64, "sha384": 96, "sha512": 128}


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
        r"([0-9a-fA-F]+)$",
        line,
    )
    if tagged is not None:
        digest, name = tagged.group(2), tagged.group(1)
    else:
        plain = _PLAIN_LINE.match(line)
        if plain is None:
            return None
        digest, name = plain.group(1), plain.group(2)
    if len(digest) != HEX_DIGITS.get(algorithm, len(digest)):
        return None
    return digest.lower(), name


def _check_target(filename: str, cwd: str, mount_prefix: str) -> PathSpec:
    """PathSpec for a recorded name, resolved like GNU against the cwd.

    Args:
        filename (str): the name exactly as the checksum file records it.
        cwd (str): the invoking command's working directory.
        mount_prefix (str): the checksum file's mount prefix.
    """
    virtual = resolve_path(filename, cwd)
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=mount_key(virtual, mount_prefix),
        raw_path=filename,
    )


def dispatched_reader(
    dispatch: DispatchFn,
    stream: Callable[[PathSpec], AsyncIterator[bytes]],
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """Read a path through the workspace's dispatcher, on whatever mount holds
    it: a checksum list names files anywhere, not on the list's mount.

    A stdin name (``-``, ``/dev/stdin``) reads the command's input
    through ``stream``, on the cursor the list itself reads from.

    Args:
        dispatch (DispatchFn): the workspace's op dispatcher.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): the
            command's stdin-aware reader.
    """
    caller = current_caller()

    def read(path: PathSpec) -> AsyncIterator[bytes]:
        if is_stdin(path):
            return stream(path)
        return caller_stream(dispatch, caller, path)

    return read


def _count_noun(count: int, singular: str, plural: str) -> str:
    return singular if count == 1 else f"{count} {plural}"


def _check_list_error(
    algorithm: str, path: PathSpec, exc: BaseException
) -> bytes:
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
    detail = (
        "read error"
        if isinstance(exc, IsADirectoryError)
        else (fs_strerror(exc) or str(exc))
    )
    return f"{algorithm}sum: {label}: {detail}\n".encode()


async def _hash_check(
    path: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    algorithm: str,
    cwd: str,
    cwd_prefix: str,
    strict: bool,
    ignore_missing: bool,
    status: bool,
    quiet: bool,
    warn: bool,
) -> tuple[bytes, bytes | None, int]:
    prog = f"{algorithm}sum"
    data = (await read_bytes(path)).decode(errors="replace")
    # A list read from stdin names files on the mount the command runs on.
    mount_prefix = (
        cwd_prefix
        if is_stdin(path)
        else mount_prefix_of(path.virtual, path.vfs_path)
    )
    # GNU quotes its stdin name, which holds a space.
    check_label = (
        f"'{STDIN_HEADER_NAME}'"
        if path.raw_path == "-"
        else path.raw_path or path.virtual
    )
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
                    f"{algorithm.upper()} checksum line"
                )
            continue
        parsed_lines += 1
        expected_hash, filename = parsed
        target = _check_target(filename, cwd, mount_prefix)
        try:
            digest = await hash_source(read_stream(target), algorithm)
        except WALK_ERRORS as exc:
            # GNU --ignore-missing skips only absence; a permission or
            # transport-shaped failure still reports and fails the check.
            if ignore_missing and isinstance(
                exc, (FileNotFoundError, ValueError)
            ):
                continue
            strerror = fs_strerror(exc) or str(exc)
            stderr_lines.append(f"{prog}: {filename}: {strerror}")
            lines.append(f"{filename}: FAILED open or read")
            read_failures += 1
            continue
        if digest == expected_hash:
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
            "found"
        )
        return b"", ("\n".join(stderr_lines) + "\n").encode(), 1
    nothing_verified = ignore_missing and not verified
    if not status:
        if malformed:
            noun = _count_noun(malformed, "1 line is", "lines are")
            stderr_lines.append(
                f"{prog}: WARNING: {noun} improperly formatted"
            )
        if read_failures:
            noun = _count_noun(read_failures, "1 listed file", "listed files")
            stderr_lines.append(f"{prog}: WARNING: {noun} could not be read")
        if mismatched:
            noun = _count_noun(
                mismatched, "1 computed checksum", "computed checksums"
            )
            stderr_lines.append(f"{prog}: WARNING: {noun} did NOT match")
        if nothing_verified:
            stderr_lines.append(f"{prog}: {check_label}: no file was verified")
    stderr = (
        ("\n".join(stderr_lines) + "\n").encode() if stderr_lines else None
    )
    exit_code = (
        1
        if (
            mismatched
            or read_failures
            or nothing_verified
            or (strict and malformed)
        )
        else 0
    )
    output = (
        b""
        if status
        else (("\n".join(lines) + "\n").encode() if lines else b"")
    )
    return output, stderr, exit_code


async def checksum(
    paths: list[PathSpec],
    *,
    algorithm: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
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
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Hash each operand, or with ``check`` verify each checksum list.

    An operand's digest is asked of ``stored`` first, the one the
    mount keeps, and the file is read only when there is none; a list
    under ``check`` is always verified against the bytes.

    Args:
        paths (list[PathSpec]): the operands, none for stdin.
        algorithm (str): the digest name, e.g. ``"md5"``.
        read_bytes (Callable): bound whole reader.
        read_stream (Callable): bound streamed reader, stdin for ``-``.
        check (bool): -c.
        binary (bool): -b.
        tag (bool): --tag.
        zero (bool): -z.
        strict (bool): --strict.
        ignore_missing (bool): --ignore-missing.
        status (bool): --status.
        quiet (bool): --quiet.
        warn (bool): -w.
        cwd (PathSpec | str): where a list's names resolve.
        stored (StoredDigest | None): the mount's stored digest.
    """
    if check and paths:
        if isinstance(cwd, PathSpec):
            cwd_dir = cwd.virtual
            cwd_prefix = mount_prefix_of(cwd.virtual, cwd.vfs_path)
        else:
            cwd_dir, cwd_prefix = cwd or "/", ""
        outs: list[bytes] = []
        errs: list[bytes] = []
        exit_code = 0
        # Every operand is its own checksum list: GNU verifies each in
        # turn and keeps going when one cannot be read (coreutils 9.7).
        for p in paths:
            try:
                out, stderr, code = await _hash_check(
                    p,
                    read_bytes,
                    read_stream,
                    algorithm,
                    cwd_dir,
                    cwd_prefix,
                    strict,
                    ignore_missing,
                    status,
                    quiet,
                    warn,
                )
            except WALK_ERRORS as exc:
                errs.append(_check_list_error(algorithm, p, exc))
                exit_code = 1
                continue
            outs.append(out)
            if stderr is not None:
                errs.append(stderr)
            if code:
                exit_code = 1
        return b"".join(outs), IOResult(
            exit_code=exit_code, stderr=b"".join(errs) or None
        )
    return await hash_operands(
        paths or [STDIN_OPERAND],
        read_stream,
        algorithm,
        f"{algorithm}sum",
        partial(
            _hash_line, algorithm=algorithm, binary=binary, tag=tag, zero=zero
        ),
        stored,
    )


async def checksum_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    *,
    name: str,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run a GNU ``*sum`` over resolved operands; mirrors checksumGeneric.

    The wiring resolves globs and binds one backend reader; everything
    else lives here: flag parsing, the per-operand report-and-continue
    split, the ``--check`` verification pass (which resolves recorded
    names against ``ctx.cwd``), and the stdin fallback.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by checksums.
        ctx (Context): Flags, stdin and cwd from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        name (str): The invoked command name (``md5sum``, ...), for its
            spec and stderr; its digest is the name without ``sum``.
        stored (StoredDigest | None): the mount's ``checksum``, the
            digest it keeps, asked before an operand is read.
    """
    parsed = parse_flags(ctx.flags, name)
    algorithm = name.removesuffix("sum")
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, ctx.stdin)
    if parsed.check:
        # With no operand the checksum list is stdin.
        return await checksum(
            paths or [STDIN_OPERAND],
            algorithm=algorithm,
            read_bytes=materialized_read(stream),
            read_stream=(
                dispatched_reader(ctx.vfs.dispatch, normalized_read(stream))
                if ctx.vfs is not None
                else normalized_read(stream)
            ),
            check=True,
            strict=parsed.strict,
            ignore_missing=parsed.ignore_missing,
            status=parsed.status,
            quiet=parsed.quiet,
            warn=parsed.warn,
            cwd=ctx.cwd,
        )
    readable, err = await split_readable(paths, stat, name)
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await checksum(
            readable,
            algorithm=algorithm,
            read_bytes=materialized_read(stream),
            read_stream=normalized_read(stream),
            binary=parsed.binary,
            tag=parsed.tag,
            zero=parsed.zero,
            cwd=ctx.cwd,
            stored=stored,
        ),
        err,
    )


__all__ = [
    "StoredDigest",
    "checksum",
    "checksum_generic",
]
