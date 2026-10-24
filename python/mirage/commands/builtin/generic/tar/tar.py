import io
import logging
import re
import stat as stat_mode
import tarfile
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
)
from contextlib import aclosing, asynccontextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import BinaryIO

from mirage.commands.builtin.constants import C_SPACE, UINTMAX
from mirage.commands.builtin.generic.archive.extract import (
    ensure_dir,
    extract_dest,
)
from mirage.commands.builtin.generic.archive.walk import (
    DirProbe,
    WalkFn,
)
from mirage.commands.builtin.generic.tar.constants import (
    CHILD_NAME,
    CHILD_STATUS,
    CODECS,
    CREATE_ERROR_EXIT,
    EMPTY_PIPE,
    ERROR_TRAILER,
    FATAL_TRAILER,
    FOREIGN_INPUT,
    INVALID_ARCHIVE,
    MODE_CONFLICT,
    MULTIPLE_ARCHIVES,
    NO_MODE,
    STRIP_COUNT,
    TAPE_START,
    UNEXPECTED_EOF,
    USAGE_HINT,
)
from mirage.commands.builtin.generic.tar.create import (
    cannot,
    check_directories,
    plan_create,
)
from mirage.commands.builtin.generic.tar.types import (
    CompressionSuffix,
    CreateResult,
    Member,
    ReadResult,
)
from mirage.commands.builtin.utils.links import links_of, mount_view
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.output import (
    format_optional_records,
    format_records,
)
from mirage.commands.builtin.utils.paths import virtual_key
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.concurrency.limiter import run_blocking
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eisdir, fs_strerror
from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.spool import ByteSpool
from mirage.io.stream import OutputStream, prime_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.compress import (
    GZIP_MAGIC,
    GzipDataError,
    compress_stream,
    decompress_stream,
    gunzip_stream,
    gzip_compress_stream,
)
from mirage.utils.quote import escape_quote
from mirage.view.types import LinkView, MountView

logger = logging.getLogger(__name__)


def _compression_suffix(z: bool, j: bool, J: bool) -> CompressionSuffix:
    if z:
        return ":gz"
    if j:
        return ":bz2"
    if J:
        return ":xz"
    return ""


def _stderr_of(lines: list[str]) -> bytes:
    return format_records(lines)


class ZeroTail(io.RawIOBase):
    def __init__(self, file: BinaryIO, limit: int) -> None:
        self.file, self.limit, self.position = file, limit, 0

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        self.position = (
            offset
            if whence == 0
            else self.position + offset
            if whence == 1
            else self.limit + offset
        )
        return self.position

    def read(self, size: int = -1) -> bytes:
        size = max(0, self.limit - self.position) if size < 0 else size
        self.file.seek(min(self.position, self.limit))
        data = self.file.read(min(size, max(0, self.limit - self.position)))
        self.position += size
        return data + bytes(size - len(data))


def _index_archive(
    file: BinaryIO, size: int
) -> tuple[tarfile.TarFile, int | None]:
    tf = tarfile.open(fileobj=ZeroTail(file, size // 512 * 512), mode="r:")
    try:
        members = tf.getmembers()
    except BaseException:
        tf.close()
        raise
    cut = next(
        (
            idx
            for idx, member in enumerate(members)
            if member.offset_data + member.size > size // 512 * 512
        ),
        None,
    )
    return tf, cut


def _detect_compression(first: bytes) -> CompressionSuffix:
    """The compression whose magic opens an archive, as GNU tar sniffs
    one that -z, -j and -J did not name.

    Args:
        first (bytes): the archive's first bytes.
    """
    if first.startswith(GZIP_MAGIC):
        return ":gz"
    return next(
        (
            kind
            for kind, (magic, *_) in FOREIGN_INPUT.items()
            if first.startswith(magic)
        ),
        "",
    )


@asynccontextmanager
async def _open_archive(
    data: ByteSpool, suffix: CompressionSuffix
) -> AsyncIterator[ReadResult]:
    decoded = ByteSpool()
    tf: tarfile.TarFile | None = None
    try:
        first = await data.read(0, 6)
        foreign = FOREIGN_INPUT.get(suffix)
        if (
            foreign is not None
            and not first.startswith(foreign[0])
            and (data.size or foreign[3])
        ):
            yield ReadResult(
                None,
                GzipDataError((foreign[1],), fatal=True, exit_code=foreign[2]),
            )
            return
        failure = None
        source = data
        kind = suffix or _detect_compression(first)
        if kind:
            try:
                await decoded.fill(
                    gunzip_stream(data.stream())
                    if kind == ":gz"
                    else decompress_stream(data.stream(), CODECS[kind])
                )
            except GzipDataError as exc:
                failure = exc
            source = decoded
        if failure is not None and source.size == 0:
            yield ReadResult(None, failure)
            return
        notices: tuple[str, ...] = ()
        cut = None
        tail: ByteSource = b""
        try:
            if source.size < 512:
                raise tarfile.ReadError("short header")
            tf, cut = await run_blocking(
                _index_archive, await source.file(), source.size
            )
            if cut is not None:
                assert tf is not None
                member = tf.getmembers()[cut]
                tail = source.stream(
                    member.offset_data,
                    max(0, source.size // 512 * 512 - member.offset_data),
                )
        except tarfile.TarError as exc:
            logger.debug("tar: failed to parse archive: %s", exc)
            notices = (
                INVALID_ARCHIVE
                if source.size >= 512
                else INVALID_ARCHIVE[:1]
                if failure is None
                else ()
            )
        yield ReadResult(tf, failure, notices, cut, tail)
    finally:
        try:
            if tf is not None:
                await run_blocking(tf.close)
        finally:
            try:
                await decoded.close()
            finally:
                await data.close()


async def _member_stream(
    tf: tarfile.TarFile, member: tarfile.TarInfo
) -> AsyncIterator[bytes]:
    file = await run_blocking(tf.extractfile, member)
    if file is None:
        return
    try:
        while data := await run_blocking(file.read, CHUNK_SIZE):
            yield data
    finally:
        await run_blocking(file.close)


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
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    names: list[str] = []
    notices = [n for n in plan.notices if n != ERROR_TRAILER]
    result = IOResult(exit_code=plan.exit_code)
    read = normalized_read(read_bytes)

    async def raw_archive() -> AsyncGenerator[bytes, None]:
        total = 0
        for member in plan.members:
            async with ByteSpool() as spool:
                source: ByteSource = b""
                size = member.size
                try:
                    if member.path is not None:
                        if size is None:
                            await spool.fill(read(member.path))
                            source, size = spool.stream(), spool.size
                        else:
                            source = await prime_stream(read(member.path))
                    else:
                        size = 0
                except FS_ERRORS as exc:
                    notices.append(
                        cannot(
                            member.spelled or member.name,
                            "open",
                            fs_strerror(exc),
                        )
                    )
                    result.exit_code = CREATE_ERROR_EXIT
                    continue
                assert size is not None
                seen = 0
                header = _info(member, size).tobuf()
                async with aclosing(chunks(source)) as content:
                    yield header
                    async for data in content:
                        remaining = max(0, size - seen)
                        if remaining:
                            yield data[:remaining]
                        seen += len(data)
                if seen != size:
                    shown = member.spelled or member.name
                    warning = (
                        f"File shrank by {size - seen} bytes; padding with zeros"
                        if seen < size
                        else "file changed as we read it"
                    )
                    notices.append(f"tar: {shown}: {warning}")
                    result.exit_code = max(result.exit_code, 1)
                    while seen < size:
                        count = min(CHUNK_SIZE, size - seen)
                        yield bytes(count)
                        seen += count
                padding = (-size) % tarfile.BLOCKSIZE
                if padding:
                    yield bytes(padding)
                total += len(header) + size + padding
                names.append(escape_quote(member.name))
        trailer = 2 * tarfile.BLOCKSIZE
        yield bytes(trailer + (-(total + trailer)) % tarfile.RECORDSIZE)
        if result.exit_code >= CREATE_ERROR_EXIT:
            notices.append(ERROR_TRAILER)
        result.stderr = _stderr_of(
            notices
            + (names if verbose and archive_path.raw_path == "-" else [])
        )

    async def archive() -> AsyncGenerator[bytes, None]:
        async with aclosing(raw_archive()) as source:
            if mode_suffix == ":gz":
                async with aclosing(
                    chunks(gzip_compress_stream(source, -1))
                ) as compressed:
                    async for data in compressed:
                        yield data
            elif mode_suffix:
                async with aclosing(
                    compress_stream(source, CODECS[mode_suffix])
                ) as compressed:
                    async for data in compressed:
                        yield data
            else:
                async for data in source:
                    yield data

    if archive_path.raw_path == "-":
        return archive(), result
    try:
        async with aclosing(archive()) as source:
            await write_bytes(archive_path, source)
    except FS_ERRORS as exc:
        return None, _open_failure(
            archive_path.raw_path, exc, mode_suffix, False
        )
    stdout = format_optional_records(names) if verbose else None
    return stdout, result


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
            cannot(shown, "read", fs_strerror(exc), who),
            _voiced(TAPE_START, who),
        ]
    else:
        lines = [cannot(shown, "open", fs_strerror(exc), who)]
    lines.append(_voiced(FATAL_TRAILER, who))
    if suffix:
        if reading and not isinstance(exc, FileNotFoundError):
            lines.extend(EMPTY_PIPE.get(suffix, ()))
        lines += [CHILD_STATUS.format(CREATE_ERROR_EXIT), FATAL_TRAILER]
    return IOResult(exit_code=CREATE_ERROR_EXIT, stderr=_stderr_of(lines))


async def _read_archive(
    archive_path: PathSpec,
    read_bytes: PolymorphicReadFn,
    is_dir: DirProbe,
    suffix: CompressionSuffix,
) -> ByteSpool | IOResult:
    """The archive's bytes, or the run's fatal lines when GNU would stop.

    Args:
        archive_path (PathSpec): the ``-f`` operand.
        read_bytes (Callable[..., Awaitable[bytes]]): the backend read.
        is_dir (DirProbe): whether a path is a directory, asked only once
            the read failed: a backend that keys files alone reports a
            directory as absent, where GNU opens it and fails the read.
        suffix (CompressionSuffix): the compressor, empty for none.
    """
    spool = ByteSpool()
    try:
        await spool.fill(normalized_read(read_bytes)(archive_path))
        return spool
    except FS_ERRORS as exc:
        await spool.close()
        failure: OSError = exc
        if (
            isinstance(exc, FileNotFoundError)
            and archive_path.walk_error is None
            and await is_dir(archive_path)
        ):
            failure = eisdir(archive_path)
        return _open_failure(archive_path.raw_path, failure, suffix, True)
    except BaseException:
        await spool.close()
        raise


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
    target = escape_quote(member.linkname)
    suffix = (
        f" -> {target}"
        if member.issym()
        else (f" link to {target}" if member.islnk() else "")
    )
    size = f"{member.size:>{max(1, 19 - len(owner))}}"
    return f"{mode} {owner}{size} {stamp} {escape_quote(name)}{suffix}"


async def _list_archive(
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    selectors: list[str],
    verbose: bool,
    directories: list[PathSpec],
    stat: StatFn,
    read_bytes: PolymorphicReadFn,
    is_dir: DirProbe,
) -> tuple[ByteSource | None, IOResult]:
    names: list[str] = []
    rows: list[str] = []
    data = await _read_archive(archive_path, read_bytes, is_dir, mode_suffix)
    if isinstance(data, IOResult):
        return None, data
    async with _open_archive(data, mode_suffix) as result:
        tf, failure = result.archive, result.failure
        if tf is not None:
            names = [
                member.name + "/" if member.isdir() else member.name
                for member in tf.getmembers()
            ]
            rows = [
                _long_member(member, name) if verbose else escape_quote(name)
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
    stdout = format_optional_records(shown)
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
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    is_dir: DirProbe,
) -> tuple[ByteSource | None, IOResult]:
    output = ByteSpool()
    handed_off = False
    try:
        names: list[str] = []
        notices: list[str] = []
        made: set[str] = set()
        misses: list[str] = []
        # A member GNU cannot create (a read-only region, a missing op) is
        # reported by its own name and the run goes on to the next one,
        # closing with the one trailer and exit 2.
        failed = False
        data = await _read_archive(
            archive_path, read_bytes, is_dir, mode_suffix
        )
        if isinstance(data, IOResult):
            return None, data
        async with _open_archive(data, mode_suffix) as result:
            tf, failure = result.archive, result.failure
            if tf is None:
                _, misses = _selected_members([], selectors)
            else:
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
                                    dest_path.rstrip("/")
                                    + "/"
                                    + "/".join(parts)
                                )
                                try:
                                    await ensure_dir(
                                        out_dir, mkdir_fn, stat, made
                                    )
                                except FS_ERRORS as exc:
                                    notices.append(
                                        cannot(
                                            "/".join(parts),
                                            "mkdir",
                                            fs_strerror(exc),
                                        )
                                    )
                                    failed = True
                                    continue
                                names.append(
                                    escape_quote(member.name.rstrip("/") + "/")
                                )
                        continue
                    if idx == result.cut:
                        # Only the whole blocks that arrived are written.
                        content = result.tail
                        notices.append(UNEXPECTED_EOF)
                    else:
                        content = _member_stream(tf, member)
                    if to_stdout:
                        await output.fill(content)
                        names.append(escape_quote(member.name))
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
                                cannot(
                                    "/".join(parts[:-1]),
                                    "mkdir",
                                    fs_strerror(exc),
                                )
                            )
                            # GNU tar 1.35 (debian:stable-slim) reports ENOENT
                            # for the member after its parent mkdir failed.
                            notices.append(
                                cannot(
                                    "/".join(parts),
                                    "open",
                                    "No such file or directory",
                                )
                            )
                            failed = True
                            continue
                    try:
                        await write_bytes(
                            PathSpec.from_str_path(out_path), data=content
                        )
                    except FS_ERRORS as exc:
                        notices.append(
                            cannot("/".join(parts), "open", fs_strerror(exc))
                        )
                        failed = True
                        continue
                    names.append(escape_quote(member.name))
        notices[:0] = result.notices
        failed = failed or bool(result.notices)
        if to_stdout:
            # GNU moves the verbose listing to stderr when stdout carries
            # the member bytes.
            stdout: ByteSource | None = (
                OutputStream(output.stream(), output.close)
                if output.size
                else None
            )
            handed_off = stdout is not None
            stderr_lines = notices + (names if verbose else [])
        else:
            stdout = format_optional_records(names) if verbose else None
            stderr_lines = list(notices)
        if result.cut is not None:
            return stdout, IOResult(
                exit_code=2,
                stderr=_cut_short(failure, stderr_lines),
            )
        if failure is not None:
            return stdout, IOResult(
                exit_code=2,
                stderr=_child_failure(failure, stderr_lines),
            )
        if misses or failed:
            stderr_lines = stderr_lines + misses + [ERROR_TRAILER]
        return stdout, IOResult(
            exit_code=2 if misses or failed else 0,
            stderr=_stderr_of(stderr_lines),
        )
    finally:
        if not handed_off:
            await output.close()


async def tar(
    paths: list[PathSpec],
    *,
    read_bytes: PolymorphicReadFn,
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
        # Relay functions address by full virtual path (flat_scopes'
        # convention), not by the mount-relative key the wrapper's
        # accessor stamped.
        archive = virtual_key(archive)
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
            stdin_stream(read_bytes, stdin),
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
            stdin_stream(read_bytes, stdin),
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

    A decimal count with no suffix: leading blanks and one ``+`` pass,
    a sign, another letter or a count past UINTMAX does not (tar 1.35).

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
    ctx: Context,
    read_bytes: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
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
        links=links_of(ctx),
        mounts=mount_view(ctx.vfs),
        cwd=ctx.cwd,
        relay=relay,
        stdin=ctx.stdin,
    )
