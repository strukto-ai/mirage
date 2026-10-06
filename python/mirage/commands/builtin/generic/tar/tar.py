import io
import logging
import re
import stat as stat_mode
import tarfile
from collections.abc import Awaitable, Callable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from mirage.commands.builtin.constants import C_SPACE, UINTMAX
from mirage.commands.builtin.generic.archive.extract import (
    ensure_dir,
    extract_dest,
)
from mirage.commands.builtin.generic.archive.walk import (
    DirProbe,
    StatFn,
    WalkFn,
)
from mirage.commands.builtin.generic.tar.constants import (
    CHILD_NAME,
    CHILD_STATUS,
    CREATE_ERROR_EXIT,
    EMPTY_PIPE,
    ERROR_TRAILER,
    FATAL_TRAILER,
    FOREIGN_INPUT,
    INVALID_ARCHIVE,
    MODE_CONFLICT,
    MULTIPLE_ARCHIVES,
    NO_MODE,
    READ_MODES,
    STRIP_COUNT,
    TAPE_START,
    UNEXPECTED_EOF,
    USAGE_HINT,
    WRITE_MODES,
)
from mirage.commands.builtin.generic.tar.create import (
    check_directories,
    plan_create,
)
from mirage.commands.builtin.generic.tar.types import (
    CompressionSuffix,
    CreateResult,
    Member,
    ReadMode,
    ReadResult,
    WriteMode,
)
from mirage.commands.builtin.utils.stream import stdin_bytes
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec
from mirage.utils.compress import GZIP_MAGIC, gunzip_partial
from mirage.utils.errors import FS_ERRORS, GzipDataError, eisdir, fs_strerror

logger = logging.getLogger(__name__)


def _compression_suffix(z: bool, j: bool, J: bool) -> CompressionSuffix:
    if z:
        return ":gz"
    if j:
        return ":bz2"
    if J:
        return ":xz"
    return ""


def _write_mode(suffix: CompressionSuffix) -> WriteMode:
    return WRITE_MODES[suffix]


def _read_mode(suffix: CompressionSuffix) -> ReadMode:
    return READ_MODES[suffix]


def _stderr_of(lines: list[str]) -> bytes:
    return ("\n".join(lines) + "\n").encode() if lines else b""


class ZeroTail(io.BytesIO):
    """An archive's whole blocks, then zeros for as far as tar reads.

    GNU tar drops a partial last block and meets the end of the archive
    where the data stops, so a member whose data ran out reads as zeros
    and the header after it as the end-of-archive marker.
    """

    def read(self, size: int | None = -1) -> bytes:
        got = super().read(size)
        if size is None or size < 0:
            return got
        return got + bytes(size - len(got))


@contextmanager
def _open_archive(
    data: bytes, suffix: CompressionSuffix
) -> Iterator[ReadResult]:
    """Open tar's input while preserving its gzip child's failure.

    GNU tar 1.35 reads whatever gzip decoded before it stopped, whole
    blocks only, and a tar parsing error must not mask the child's
    diagnostic and exit status. A member whose data blocks ran out is
    the ``cut``: GNU reaches it and stops there.

    Args:
        data (bytes): the archive file's bytes.
        suffix (CompressionSuffix): the compression the flags asked for.
    """
    failure = None
    mode = _read_mode(suffix)
    foreign = FOREIGN_INPUT.get(suffix)
    if (
        foreign is not None
        and not data.startswith(foreign[0])
        and (data or foreign[3])
    ):
        # The child refuses the input before tar reads a block.
        yield ReadResult(
            None,
            GzipDataError((foreign[1],), fatal=True, exit_code=foreign[2]),
        )
        return
    if suffix == ":gz" or (suffix == "" and data.startswith(GZIP_MAGIC)):
        data, failure = gunzip_partial(data)
        mode = "r:"
    if failure is not None and not data:
        yield ReadResult(None, failure)
        return
    notices: tuple[str, ...] = ()
    cut: int | None = None
    tail = b""
    with ExitStack() as stack:
        tf: tarfile.TarFile | None
        try:
            tf = stack.enter_context(
                tarfile.open(fileobj=io.BytesIO(data), mode=mode)
            )
            if isinstance(tf.fileobj, io.BytesIO):
                whole = len(data) // tarfile.BLOCKSIZE * tarfile.BLOCKSIZE
                tf = stack.enter_context(
                    tarfile.open(fileobj=ZeroTail(data[:whole]), mode="r:")
                )
                cut = next(
                    (
                        idx
                        for idx, member in enumerate(tf.getmembers())
                        if member.offset_data + member.size > whole
                    ),
                    None,
                )
                if cut is not None:
                    member = tf.getmembers()[cut]
                    tail = data[member.offset_data : whole]
            else:
                tf.getmembers()
        except tarfile.TarError as exc:
            logger.debug("tar: failed to parse archive: %s", exc)
            tf = None
            notices = (
                INVALID_ARCHIVE
                if len(data) >= tarfile.BLOCKSIZE
                else INVALID_ARCHIVE[:1]
                if failure is None
                else ()
            )
        yield ReadResult(tf, failure, notices, cut, tail)


def _cut_short(failure: GzipDataError | None, lines: list[str]) -> bytes:
    """tar's stderr when a member's data runs out: gzip's own lines
    first, if gzip stopped too, then tar's lines and its two fatal ones.
    tar exits before it waits for its child, so no child status is
    reported.

    Args:
        failure (GzipDataError | None): why gzip stopped, if it did.
        lines (list[str]): tar's own stderr lines from the run.
    """
    lead = failure.render("stdin").encode() if failure is not None else b""
    return lead + _stderr_of(lines + [UNEXPECTED_EOF, FATAL_TRAILER])


def _child_failure(failure: GzipDataError, lines: list[str]) -> bytes:
    """tar's stderr when its gzip child fails: gzip's own lines, what tar
    printed meanwhile, then tar's two fatal lines. The run exits 2, and
    the child's failure outranks every member that was not found.

    Args:
        failure (GzipDataError): why gzip stopped.
        lines (list[str]): tar's own stderr lines from the run.
    """
    return failure.render("stdin").encode() + _stderr_of(
        lines + [CHILD_STATUS.format(failure.exit_code), FATAL_TRAILER]
    )


DOTDOT_NOTICE = "tar: Removing leading `../' from member names"


def _matches_selector(name: str, selector: str) -> bool:
    """Whether one -t/-x member selector keeps an archive member.

    GNU matches the stored spelling exactly (``memory/x`` does not find
    ``./memory/x``), and a selector naming a directory takes its whole
    subtree, with or without the trailing slash.

    Args:
        name (str): the member name as stored in the archive.
        selector (str): the operand as typed.
    """
    base = selector.rstrip("/")
    trimmed = name.rstrip("/")
    return trimmed == base or trimmed.startswith(base + "/")


def _selected_members(
    names: list[str], selectors: list[str]
) -> tuple[set[int], list[str]]:
    """Member indices the selectors keep, and the misses they report.

    No selector keeps everything. A selector that matches nothing is
    GNU's per-operand diagnostic, reported in operand order; the caller
    appends the one failure trailer.

    Args:
        names (list[str]): member names in archive order.
        selectors (list[str]): the -t/-x operands as typed.
    """
    if not selectors:
        return set(range(len(names))), []
    keep: set[int] = set()
    misses: list[str] = []
    for sel in selectors:
        hit = False
        for idx, name in enumerate(names):
            if _matches_selector(name, sel):
                keep.add(idx)
                hit = True
        if not hit:
            misses.append(f"tar: {sel}: Not found in archive")
    return keep, misses


def _out_parts(name: str, strip_n: int, notices: list[str]) -> list[str]:
    """The destination-relative components one member extracts to.

    GNU strips ``--strip-components`` off the stored spelling first, in
    which a leading ``.`` counts as a component (``--strip-components=1``
    turns ``./a/b`` into ``a/b``). Only then is the remainder cleaned
    for the filesystem: ``.`` components vanish (a real OS resolves
    them; a virtual path must not keep a literal ``.`` directory) and a
    leading ``..`` is removed with GNU's one notice per run.

    Args:
        name (str): the member name as stored in the archive.
        strip_n (int): components to strip off the stored name.
        notices (list[str]): run-level notice sink, appended in place.
    """
    parts = name.rstrip("/").split("/")
    if strip_n > 0:
        parts = parts[strip_n:]
    parts = [p for p in parts if p not in ("", ".")]
    while parts and parts[0] == "..":
        if DOTDOT_NOTICE not in notices:
            notices.append(DOTDOT_NOTICE)
        parts.pop(0)
    return parts


def _info(member: Member, size: int) -> tarfile.TarInfo:
    """The header for one member, typed the way its kind demands.

    Args:
        member (Member): the planned entry.
        size (int): byte length of the content, 0 for a dir or a link.
    """
    info = tarfile.TarInfo(name=member.name)
    info.size = size
    if member.kind == "dir":
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
    elif member.kind == "link":
        info.type = tarfile.SYMTYPE
        info.linkname = member.target
        info.mode = 0o777
    return info


async def _write_archive(
    plan: CreateResult,
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    buf = io.BytesIO()
    names: list[str] = []
    # A file the session may not read (a rule refused it below the
    # operand) is GNU's "Cannot open": the member is left out, the run
    # fails, and the one trailer closes the notices. The plan's notices
    # come first, so a directory the scan could not open is reported
    # before a file the write could not read.
    notices = [n for n in plan.notices if n != ERROR_TRAILER]
    exit_code = plan.exit_code
    with tarfile.open(fileobj=buf, mode=_write_mode(mode_suffix)) as tf:
        for member in plan.members:
            data = b""
            if member.path is not None:
                try:
                    data = await read_bytes(member.path)
                except PermissionError as exc:
                    shown = member.spelled or member.name
                    notices.append(
                        f"tar: {shown}: Cannot open: {fs_strerror(exc)}"
                    )
                    exit_code = CREATE_ERROR_EXIT
                    continue
            tf.addfile(_info(member, len(data)), io.BytesIO(data))
            names.append(member.name)
    if exit_code:
        notices.append(ERROR_TRAILER)
    archive = buf.getvalue()
    if archive_path.raw_path == "-":
        return archive, IOResult(
            stderr=_stderr_of(notices + (names if verbose else [])),
            exit_code=exit_code,
        )
    try:
        await write_bytes(archive_path, archive)
    except FS_ERRORS as exc:
        # GNU opens the archive before it reads a member, so an archive
        # it cannot create is the whole run's one fatal line.
        return None, _open_failure(
            archive_path.raw_path, exc, mode_suffix, False
        )
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(
        writes={archive_path.mount_path: archive},
        stderr=_stderr_of(notices),
        exit_code=exit_code,
    )


def _voiced(line: str, who: str) -> str:
    """One of tar's own lines, spoken by ``who`` instead of ``tar``.

    Args:
        line (str): a line that starts with ``tar:``.
        who (str): the program name to put in its place.
    """
    return who + line[len("tar") :]


def _open_failure(
    shown: str, exc: OSError, suffix: CompressionSuffix, reading: bool
) -> IOResult:
    """The run's fatal lines for an archive tar cannot open or read.

    GNU opens the archive before it reads a member, so one it cannot open
    (missing, the empty name, a link loop) ends the run as ``Cannot
    open``; a directory opens and then fails the first read, which GNU
    words as ``Cannot read`` at the beginning of the tape. With a
    compressor the archive is opened by tar's child, which names itself
    on each of those lines, and tar then reports the child's status. A
    reading child has already spawned the compressor, which meets an
    empty pipe and says so, unless the name was missing. Exit 2 every
    way, named as typed (tar 1.35, gzip 1.13, xz 5.4).

    Args:
        shown (str): the archive as typed.
        exc (OSError): why it could not be opened or read.
        suffix (CompressionSuffix): the compressor, empty for none.
        reading (bool): whether the run lists or extracts.
    """
    who = CHILD_NAME if suffix else "tar"
    if reading and isinstance(exc, IsADirectoryError):
        lines = [
            f"{who}: {shown}: Cannot read: {fs_strerror(exc)}",
            _voiced(TAPE_START, who),
        ]
    else:
        lines = [f"{who}: {shown}: Cannot open: {fs_strerror(exc)}"]
    lines.append(_voiced(FATAL_TRAILER, who))
    if suffix:
        if reading and not isinstance(exc, FileNotFoundError):
            lines.extend(EMPTY_PIPE.get(suffix, ()))
        lines += [CHILD_STATUS.format(CREATE_ERROR_EXIT), FATAL_TRAILER]
    return IOResult(exit_code=CREATE_ERROR_EXIT, stderr=_stderr_of(lines))


async def _read_archive(
    archive_path: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    is_dir: DirProbe,
    suffix: CompressionSuffix,
) -> bytes | IOResult:
    """The archive's bytes, or the run's fatal lines when GNU would stop.

    Args:
        archive_path (PathSpec): the ``-f`` operand.
        read_bytes (Callable[..., Awaitable[bytes]]): the backend read.
        is_dir (DirProbe): whether a path is a directory, asked only once
            the read failed: a backend that keys files alone reports a
            directory as absent, where GNU opens it and fails the read.
        suffix (CompressionSuffix): the compressor, empty for none.
    """
    try:
        return await read_bytes(archive_path)
    except FS_ERRORS as exc:
        failure: OSError = exc
        if (
            isinstance(exc, FileNotFoundError)
            and archive_path.walk_error is None
            and await is_dir(archive_path)
        ):
            failure = eisdir(archive_path)
        return _open_failure(archive_path.raw_path, failure, suffix, True)


def _long_member(member: tarfile.TarInfo, name: str) -> str:
    """GNU's verbose row, using the metadata stored in the archive.

    Args:
        member (tarfile.TarInfo): parsed archive header.
        name (str): listed member name, including a directory's slash.
    """
    kind = (
        stat_mode.S_IFDIR
        if member.isdir()
        else (stat_mode.S_IFLNK if member.issym() else stat_mode.S_IFREG)
    )
    mode = stat_mode.filemode(kind | member.mode)
    owner = f"{member.uname or member.uid}/{member.gname or member.gid}"
    stamp = datetime.fromtimestamp(member.mtime, timezone.utc).strftime(
        "%Y-%m-%d %H:%M"
    )
    suffix = (
        f" -> {member.linkname}"
        if member.issym()
        else (f" link to {member.linkname}" if member.islnk() else "")
    )
    size = f"{member.size:>{max(1, 19 - len(owner))}}"
    return f"{mode} {owner}{size} {stamp} {name}{suffix}"


async def _list_archive(
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    selectors: list[str],
    verbose: bool,
    directories: list[PathSpec],
    stat: StatFn,
    read_bytes: Callable[..., Awaitable[bytes]],
    is_dir: DirProbe,
) -> tuple[ByteSource | None, IOResult]:
    names: list[str] = []
    rows: list[str] = []
    data = await _read_archive(archive_path, read_bytes, is_dir, mode_suffix)
    if isinstance(data, IOResult):
        return None, data
    with _open_archive(data, mode_suffix) as result:
        tf, failure = result.archive, result.failure
        if tf is not None:
            names = [
                member.name + "/" if member.isdir() else member.name
                for member in tf.getmembers()
            ]
            rows = [
                _long_member(member, name) if verbose else name
                for member, name in zip(tf.getmembers(), names)
            ]
    keep, misses = _selected_members(names, selectors)
    if keep:
        errors = await check_directories(directories, is_dir, stat)
        if errors:
            return None, IOResult(exit_code=2, stderr=_stderr_of(errors))
    shown = [
        row
        for idx, row in enumerate(rows)
        if idx in keep and (result.cut is None or idx <= result.cut)
    ]
    stdout = ("\n".join(shown) + "\n").encode() if shown else None
    if result.cut is not None:
        return stdout, IOResult(
            exit_code=2, stderr=_cut_short(failure, list(result.notices))
        )
    if failure is not None:
        return stdout, IOResult(
            exit_code=2, stderr=_child_failure(failure, list(result.notices))
        )
    if result.notices or misses:
        return stdout, IOResult(
            exit_code=2,
            stderr=_stderr_of(list(result.notices) + misses + [ERROR_TRAILER]),
        )
    return stdout, IOResult()


async def _extract_archive(
    archive_path: PathSpec,
    dest_path: str,
    directories: list[PathSpec],
    mode_suffix: CompressionSuffix,
    strip_n: int,
    verbose: bool,
    to_stdout: bool,
    selectors: list[str],
    relay: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    is_dir: DirProbe,
) -> tuple[ByteSource | None, IOResult]:
    writes: dict[str, ByteSource] = {}
    names: list[str] = []
    notices: list[str] = []
    made: set[str] = set()
    extracted_bytes: list[bytes] = []
    misses: list[str] = []
    # A member GNU cannot create (a read-only region, a missing op) is
    # reported by its own name and the run goes on to the next one,
    # closing with the one trailer and exit 2.
    failed = False
    data = await _read_archive(archive_path, read_bytes, is_dir, mode_suffix)
    if isinstance(data, IOResult):
        return None, data
    with _open_archive(data, mode_suffix) as result:
        tf, failure = result.archive, result.failure
        if tf is not None:
            members = tf.getmembers()
            listed = [
                member.name + "/" if member.isdir() else member.name
                for member in members
            ]
            keep, misses = _selected_members(listed, selectors)
            if keep:
                errors = await check_directories(directories, is_dir, stat)
                if errors:
                    return None, IOResult(
                        exit_code=2, stderr=_stderr_of(errors)
                    )
            for idx, member in enumerate(members):
                if result.cut is not None and idx > result.cut:
                    break
                if idx not in keep:
                    continue
                # A symlink member has no bytes to write and no namespace to
                # write into from here (links are workspace state, not the
                # backend's), so extraction skips it rather than dropping an
                # empty file where a link belongs.
                if not member.isfile() and not member.isdir():
                    continue
                if member.isdir():
                    if not to_stdout:
                        # A directory member is the only record an empty
                        # directory leaves, so it has to be recreated even
                        # though nothing is written inside it. Under -O
                        # nothing reaches the filesystem at all.
                        parts = _out_parts(member.name, strip_n, notices)
                        if parts:
                            out_dir = (
                                dest_path.rstrip("/") + "/" + "/".join(parts)
                            )
                            try:
                                await ensure_dir(out_dir, mkdir_fn, stat, made)
                            except FS_ERRORS as exc:
                                notices.append(
                                    f"tar: {'/'.join(parts)}: "
                                    f"Cannot mkdir: "
                                    f"{fs_strerror(exc)}"
                                )
                                failed = True
                                continue
                            names.append(member.name.rstrip("/") + "/")
                    continue
                if idx == result.cut:
                    # Only the whole blocks that arrived are written.
                    content = result.tail
                    notices.append(UNEXPECTED_EOF)
                else:
                    extracted = tf.extractfile(member)
                    if not extracted:
                        continue
                    content = extracted.read()
                if to_stdout:
                    extracted_bytes.append(content)
                    names.append(member.name)
                    continue
                parts = _out_parts(member.name, strip_n, notices)
                if not parts:
                    continue
                out_path = dest_path.rstrip("/") + "/" + "/".join(parts)
                parent = out_path.rsplit("/", 1)[0] or "/"
                if parent != "/":
                    try:
                        await ensure_dir(parent, mkdir_fn, stat, made)
                    except FS_ERRORS as exc:
                        notices.append(
                            f"tar: {'/'.join(parts[:-1])}: Cannot "
                            f"mkdir: {fs_strerror(exc)}"
                        )
                        # GNU tar 1.35 (debian:stable-slim) reports ENOENT
                        # for the member after its parent mkdir failed.
                        notices.append(
                            f"tar: {'/'.join(parts)}: Cannot "
                            "open: No such file or directory"
                        )
                        failed = True
                        continue
                try:
                    await write_bytes(
                        PathSpec.from_str_path(out_path), data=content
                    )
                except FS_ERRORS as exc:
                    notices.append(
                        f"tar: {'/'.join(parts)}: Cannot open: "
                        f"{fs_strerror(exc)}"
                    )
                    failed = True
                    continue
                if not relay:
                    # Relay writes land on whichever mount owns each path
                    # and invalidate through the dispatcher; keying them here
                    # would have the runner prefix them onto this mount.
                    writes[out_path] = content
                names.append(member.name)
    notices[:0] = result.notices
    failed = failed or bool(result.notices)
    if to_stdout:
        # GNU moves the verbose listing to stderr when stdout carries
        # the member bytes.
        stdout: ByteSource | None = b"".join(extracted_bytes) or None
        stderr_lines = notices + (names if verbose else [])
    else:
        listing = (
            ("\n".join(names) + "\n").encode() if verbose and names else None
        )
        stdout = listing
        stderr_lines = list(notices)
    if result.cut is not None:
        return stdout, IOResult(
            exit_code=2,
            stderr=_cut_short(failure, stderr_lines),
            writes=writes,
        )
    if failure is not None:
        return stdout, IOResult(
            exit_code=2,
            stderr=_child_failure(failure, stderr_lines),
            writes=writes,
        )
    if misses or failed:
        stderr_lines = stderr_lines + misses + [ERROR_TRAILER]
    return stdout, IOResult(
        exit_code=2 if misses or failed else 0,
        stderr=_stderr_of(stderr_lines),
        writes=writes,
    )


async def tar(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    selectors: list[str] | None = None,
    c: bool = False,
    x: bool = False,
    t: bool = False,
    z: bool = False,
    j: bool = False,
    J: bool = False,
    v: bool = False,
    h: bool = False,
    to_stdout: bool = False,
    f: PathSpec | None = None,
    C: list[PathSpec] | None = None,
    strip_components: int = 0,
    exclude: str | None = None,
    one_file_system: bool = False,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    cwd: PathSpec | str = "/",
    relay: bool = False,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # With no -f the archive is standard input or output, which is GNU
    # tar's compiled-in default (no TAPE in the environment).
    archive = f or replace(PathSpec.from_str_path("/dev/stdin"), raw_path="-")
    if relay and archive is not None:
        # Relay doors address by full virtual path (flat_scopes'
        # convention), not by the mount-relative key the wrapper's
        # accessor stamped.
        archive = replace(archive, vfs_path=archive.virtual.strip("/"))
    # Only the last -C is a destination; create checks every one.
    dest_path = extract_dest(C[-1] if C else None, cwd, relay)
    chosen = list(selectors or [])
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = strip_components
    if c:
        plan = await plan_create(
            paths,
            archive=archive,
            exclude=exclude,
            dereference=h,
            stat=stat,
            walk=walk,
            is_dir=is_dir,
            directories=C or [],
            links=links,
            mounts=mounts,
            one_file_system=one_file_system,
        )
        if not plan.write:
            return None, IOResult(
                exit_code=plan.exit_code, stderr=_stderr_of(list(plan.notices))
            )
        return await _write_archive(
            plan, archive, mode_suffix, v, read_bytes, write_bytes
        )
    if t:
        return await _list_archive(
            archive,
            mode_suffix,
            chosen,
            v,
            C or [],
            stat,
            stdin_bytes(read_bytes, stdin),
            is_dir,
        )
    if x:
        return await _extract_archive(
            archive,
            dest_path,
            C or [],
            mode_suffix,
            strip_n,
            v,
            to_stdout,
            chosen,
            relay,
            stdin_bytes(read_bytes, stdin),
            write_bytes,
            mkdir_fn,
            stat,
            is_dir,
        )
    raise UsageError(f"{NO_MODE}\n{USAGE_HINT}", CREATE_ERROR_EXIT)


__all__ = ["tar"]


@dataclass(frozen=True, slots=True)
class TarFlags:
    create: bool = False
    extract: bool = False
    list_only: bool = False
    gzip: bool = False
    bzip2: bool = False
    xz: bool = False
    verbose: bool = False
    deref: bool = False
    to_stdout: bool = False
    archive: PathSpec | None = None
    directories: tuple[PathSpec, ...] = ()
    strip_components: int = 0
    exclude: str | None = None
    one_file_system: bool = False


_MODES = ("create", "extract", "list")
_STRIP_COUNT_PATTERN = re.compile(rf"^{C_SPACE}\+?([0-9]+)$")


def strip_count(raw: str) -> int:
    """A --strip-components value as tar reads it, or tar's refusal.

    xstrtoumax at base 10 with no suffix: leading blanks and one ``+``
    pass, a sign, another letter or a count past UINTMAX does not (tar
    1.35).

    Args:
        raw (str): the value as typed.

    Raises:
        UsageError: the value is no count.
    """
    match = _STRIP_COUNT_PATTERN.match(raw)
    if match is None or int(match.group(1)) > UINTMAX:
        raise UsageError(
            f"{STRIP_COUNT.format(raw)}\n{USAGE_HINT}", CREATE_ERROR_EXIT
        )
    return int(match.group(1))


def parse_flags(flags: Mapping[str, FlagValue]) -> TarFlags:
    """tar's flags as argp reads them, refusing what tar refuses.

    argp meets the options in line order and stops at the first it
    refuses: a second main operation where one is already set, or a
    --strip-components value that is no count. After the scan, more than
    one archive is refused without -M, which mirage does not have (tar
    1.35).

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.

    Raises:
        UsageError: tar's refusal, exit 2.
    """
    fl = FlagView(flags, spec=SPECS["tar"])
    mode: str | None = None
    strip = 0
    for name, value in fl.occurrences(*_MODES, "strip_components"):
        if name == "strip_components":
            strip = strip_count(str(value))
        elif mode is not None and name != mode:
            raise UsageError(
                f"{MODE_CONFLICT}\n{USAGE_HINT}", CREATE_ERROR_EXIT
            )
        else:
            mode = name
    if len(fl.occurrences("file")) > 1:
        raise UsageError(
            f"{MULTIPLE_ARCHIVES}\n{USAGE_HINT}", CREATE_ERROR_EXIT
        )
    archive = fl.raw("file")
    return TarFlags(
        create=fl.as_bool("create"),
        extract=fl.as_bool("extract"),
        list_only=fl.as_bool("list"),
        gzip=fl.as_bool("gzip"),
        bzip2=fl.as_bool("bzip2"),
        xz=fl.as_bool("xz"),
        verbose=fl.as_bool("verbose"),
        deref=fl.as_bool("dereference"),
        to_stdout=fl.as_bool("to_stdout"),
        archive=archive if isinstance(archive, PathSpec) else None,
        directories=tuple(fl.as_paths("directory")),
        strip_components=strip,
        exclude=fl.as_str("exclude"),
        one_file_system=fl.as_bool("one_file_system"),
    )


async def tar_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await tar(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        mkdir_fn=mkdir_fn,
        stat=stat,
        walk=walk,
        is_dir=is_dir,
        selectors=list(texts),
        c=parsed.create,
        x=parsed.extract,
        t=parsed.list_only,
        z=parsed.gzip,
        j=parsed.bzip2,
        J=parsed.xz,
        v=parsed.verbose,
        h=parsed.deref,
        to_stdout=parsed.to_stdout,
        f=parsed.archive,
        C=list(parsed.directories) or None,
        strip_components=parsed.strip_components,
        exclude=parsed.exclude,
        one_file_system=parsed.one_file_system,
        links=opts.ns.links if opts.ns is not None else None,
        mounts=opts.ns.mounts if opts.ns is not None else None,
        cwd=opts.cwd,
        relay=relay,
        stdin=opts.stdin,
    )
