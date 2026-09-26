import io
import tarfile
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.generic.archive.extract import (ensure_dir,
                                                             extract_dest)
from mirage.commands.builtin.generic.archive.walk import (DirProbe, StatFn,
                                                          WalkFn)
from mirage.commands.builtin.generic.tar.constants import (CREATE_ERROR_EXIT,
                                                           ERROR_TRAILER,
                                                           FATAL_TRAILER,
                                                           READ_MODES,
                                                           WRITE_MODES)
from mirage.commands.builtin.generic.tar.create import plan_create
from mirage.commands.builtin.generic.tar.types import (CompressionSuffix,
                                                       CreateResult, Member,
                                                       ReadMode, WriteMode)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror


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


def _stderr(lines: list[str]) -> bytes:
    return ("\n".join(lines) + "\n").encode() if lines else b""


DOTDOT_NOTICE = "tar: Removing leading `../' from member names"


def _matches(name: str, selector: str) -> bool:
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


def _selected(names: list[str],
              selectors: list[str]) -> tuple[set[int], list[str]]:
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
            if _matches(name, sel):
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


async def _create_archive(
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
                    notices.append(f"tar: {shown}: Cannot open: "
                                   f"{fs_strerror(exc)}")
                    exit_code = CREATE_ERROR_EXIT
                    continue
            tf.addfile(_info(member, len(data)), io.BytesIO(data))
            names.append(member.name)
    if exit_code:
        notices.append(ERROR_TRAILER)
    archive = buf.getvalue()
    try:
        await write_bytes(archive_path, archive)
    except FS_ERRORS as exc:
        # GNU opens the archive before it reads a member, so an archive
        # it cannot create is the whole run's one fatal line.
        shown = archive_path.raw_path or archive_path.virtual
        return None, IOResult(exit_code=CREATE_ERROR_EXIT,
                              stderr=_stderr([
                                  f"tar: {shown}: Cannot open: "
                                  f"{fs_strerror(exc)}", FATAL_TRAILER
                              ]))
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(writes={archive_path.mount_path: archive},
                            stderr=_stderr(notices),
                            exit_code=exit_code)


async def _list_archive(
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    selectors: list[str],
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(archive_path)
    with tarfile.open(fileobj=io.BytesIO(data),
                      mode=_read_mode(mode_suffix)) as tf:
        names = [
            member.name + "/" if member.isdir() else member.name
            for member in tf.getmembers()
        ]
    keep, misses = _selected(names, selectors)
    shown = [name for idx, name in enumerate(names) if idx in keep]
    stdout = ("\n".join(shown) + "\n").encode() if shown else None
    if misses:
        return stdout, IOResult(exit_code=2,
                                stderr=_stderr(misses + [ERROR_TRAILER]))
    return stdout, IOResult()


async def _extract_archive(
    archive_path: PathSpec,
    dest_path: str,
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
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(archive_path)
    writes: dict[str, ByteSource] = {}
    names: list[str] = []
    notices: list[str] = []
    made: set[str] = set()
    extracted_bytes: list[bytes] = []
    # A member GNU cannot create (a read-only region, a missing op) is
    # reported by its own name and the run goes on to the next one,
    # closing with the one trailer and exit 2.
    failed = False
    with tarfile.open(fileobj=io.BytesIO(data),
                      mode=_read_mode(mode_suffix)) as tf:
        members = tf.getmembers()
        listed = [
            member.name + "/" if member.isdir() else member.name
            for member in members
        ]
        keep, misses = _selected(listed, selectors)
        for idx, member in enumerate(members):
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
                        out_dir = dest_path.rstrip("/") + "/" + "/".join(parts)
                        try:
                            await ensure_dir(out_dir, mkdir_fn, stat, made)
                        except FS_ERRORS as exc:
                            notices.append(f"tar: {'/'.join(parts)}: Cannot "
                                           f"mkdir: {fs_strerror(exc)}")
                            failed = True
                            continue
                        names.append(member.name.rstrip("/") + "/")
                continue
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
                    notices.append(f"tar: {'/'.join(parts[:-1])}: Cannot "
                                   f"mkdir: {fs_strerror(exc)}")
                    notices.append(f"tar: {'/'.join(parts)}: Cannot open: "
                                   "No such file or directory")
                    failed = True
                    continue
            try:
                await write_bytes(PathSpec.from_str_path(out_path),
                                  data=content)
            except FS_ERRORS as exc:
                notices.append(f"tar: {'/'.join(parts)}: Cannot open: "
                               f"{fs_strerror(exc)}")
                failed = True
                continue
            if not relay:
                # Relay writes land on whichever mount owns each path
                # and invalidate through the dispatcher; keying them here
                # would have the runner prefix them onto this mount.
                writes[out_path] = content
            names.append(member.name)
    if to_stdout:
        # GNU moves the verbose listing to stderr when stdout carries
        # the member bytes.
        stdout: ByteSource | None = b"".join(extracted_bytes) or None
        stderr_lines = notices + (names if verbose else [])
    else:
        listing = ("\n".join(names) + "\n").encode() if verbose and names \
            else None
        stdout = listing
        stderr_lines = list(notices)
    if misses or failed:
        stderr_lines = stderr_lines + misses + [ERROR_TRAILER]
    return stdout, IOResult(exit_code=2 if misses or failed else 0,
                            stderr=_stderr(stderr_lines),
                            writes=writes)


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
    strip_components: str | None = None,
    exclude: str | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    cwd: PathSpec | str = "/",
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    archive = f if f else None
    if relay and archive is not None:
        # Relay doors address by full virtual path (flat_scopes'
        # convention), not by the mount-relative key the wrapper's
        # accessor stamped.
        archive = PathSpec.from_str_path(archive.virtual)
    # Only the last -C is a destination; create checks every one.
    dest_path = extract_dest(C[-1] if C else None, cwd, relay)
    chosen = list(selectors or [])
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = int(strip_components) if strip_components else 0
    if c:
        if archive is None:
            raise ValueError("tar: -f is required")
        plan = await plan_create(paths,
                                 archive=archive,
                                 exclude=exclude,
                                 dereference=h,
                                 stat=stat,
                                 walk=walk,
                                 is_dir=is_dir,
                                 directories=C or [],
                                 links=links,
                                 mounts=mounts)
        if not plan.write:
            return None, IOResult(exit_code=plan.exit_code,
                                  stderr=_stderr(list(plan.notices)))
        return await _create_archive(plan, archive, mode_suffix, v, read_bytes,
                                     write_bytes)
    if t:
        if archive is None:
            raise ValueError("tar: -f is required")
        return await _list_archive(archive, mode_suffix, chosen, read_bytes)
    if x:
        if archive is None:
            raise ValueError("tar: -f is required")
        return await _extract_archive(archive, dest_path, mode_suffix, strip_n,
                                      v, to_stdout, chosen, relay, read_bytes,
                                      write_bytes, mkdir_fn, stat)
    raise ValueError("tar: must specify -c, -x, or -t")


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
    strip_components: str | None = None
    exclude: str | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> TarFlags:
    fl = FlagView(flags, spec=SPECS["tar"])
    archive = fl.raw("f")
    return TarFlags(
        create=fl.as_bool("c"),
        extract=fl.as_bool("x"),
        list_only=fl.as_bool("t"),
        gzip=fl.as_bool("z"),
        bzip2=fl.as_bool("j"),
        xz=fl.as_bool("J"),
        verbose=fl.as_bool("v"),
        deref=fl.as_bool("h"),
        to_stdout=fl.as_bool("to_stdout"),
        archive=archive if isinstance(archive, PathSpec) else None,
        directories=tuple(fl.as_paths("C")),
        strip_components=fl.as_str("strip_components"),
        exclude=fl.as_str("exclude"),
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
    return await tar(paths,
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
                     links=opts.ns.links if opts.ns is not None else None,
                     mounts=opts.ns.mounts if opts.ns is not None else None,
                     cwd=opts.cwd,
                     relay=relay)
