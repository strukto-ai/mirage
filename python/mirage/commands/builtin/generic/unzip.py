import fnmatch
import io
import zipfile
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.generic.archive.extract import (ensure_dir,
                                                             extract_dest)
from mirage.commands.builtin.generic.archive.walk import StatFn
from mirage.commands.builtin.generic.archive.zipinfo import (ZipRow,
                                                             render_header,
                                                             render_row,
                                                             render_totals,
                                                             zipinfo_layout)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

# Info-ZIP's wording and spacing, verbatim (two spaces after the colon).
CAUTION_PREFIX = "caution: filename not matched:  "
EXCLUDED_CAUTION_PREFIX = "caution: excluded filename not matched:  "

# Info-ZIP looks for the end-of-central-directory record in the last
# 65557 bytes (a 22-byte record behind a comment of at most 65535); a
# file without one is not an archive at all, whatever its name says.
EOCD_SIGNATURE = b"PK\x05\x06"
EOCD_SEARCH = 65557
CENTRAL_SIGNATURE = b"PK\x01\x02"
# Info-ZIP's refusals verbatim (process.c). The paragraph is shared;
# unzip signs it below, zipinfo signs it below under its own name, and
# -p names the archive above it and does not sign. The exit codes are
# theirs too: 9 for no archive, 3 for a corrupt one.
NO_EOCD = ("  End-of-central-directory signature not found.  Either this file"
           " is not\n  a zipfile, or it constitutes one disk of a multi-part"
           " archive.  In the\n  latter case the central directory and zipfile"
           " comment will be found on\n  the last disk(s) of this archive.\n")
UNZIP_NO_DIRECTORY = ("unzip:  cannot find zipfile directory in one of {0} or"
                      "\n        {0}.zip, and cannot find {0}.ZIP, period.\n")
ZIPINFO_NO_DIRECTORY = (
    "zipinfo:  cannot find zipfile directory in one of {0} or"
    "\n          {0}.zip, and cannot find {0}.ZIP, period.\n")
CORRUPT_CDIR = (
    "error [{0}]:  start of central directory not found;\n"
    "  zipfile corrupt.\n"
    "  (please check that you have transferred or created the zipfile in the"
    "\n  appropriate BINARY mode and that you have compiled UnZip properly)\n")
NO_ARCHIVE_EXIT = 9
CORRUPT_EXIT = 3
# The end record says where the central directory should start; bytes
# before the archive (a self-extractor stub) push it later, and Info-ZIP
# reports the difference as a warning (exit 1) and carries on with every
# offset shifted, or as an error (exit 2) when bytes are missing instead.
# Info-ZIP prints this on stdout under -t and between the header and
# the rows under -Z; mirage keeps every diagnostic on stderr.
EXTRA_BYTES = ("warning [{0}]:  {1} extra byte{2} at beginning or within "
               "zipfile\n  (attempting to process anyway)\n")
MISSING_BYTES = ("error [{0}]:  missing {1} bytes in zipfile\n"
                 "  (attempting to process anyway)\n")
ZERO_TESTED = "Caution:  zero files tested in {0}.\n"
WARN_EXIT = 1
MISSING_EXIT = 2
# Info-ZIP answers an option it does not know with its usage block and
# exit 10; -1, -2 and -h are zipinfo's letters and mean nothing to unzip
# proper (Info-ZIP's `unzip -h` is its help screen).
USAGE_EXIT = 10


def _spec_index(name: bytes, members: tuple[bytes, ...]) -> int | None:
    for i, member in enumerate(members):
        if fnmatch.fnmatchcase(name, member):
            return i
    return None


def _select(
    infos: list[zipfile.ZipInfo], members: tuple[str,
                                                 ...], excludes: tuple[str,
                                                                       ...]
) -> tuple[list[zipfile.ZipInfo], list[str], list[str]]:
    """Choose the entries the member and exclude patterns leave.

    Info-ZIP matches filespecs against the encoded name, so `?` stands
    for one byte, not one code point: `?.txt` misses `é.txt` and
    `??.txt` hits it. It walks the archive in order and charges each
    entry to the first filespec that matches it, so a spec shadowed by
    an earlier one reports "filename not matched" even when its file
    was printed. An entry a member pattern chose still counts for that
    pattern when an exclude then drops it.

    Args:
        infos (list[zipfile.ZipInfo]): the central directory, in order.
        members (tuple[str, ...]): include patterns; none means all.
        excludes (tuple[str, ...]): ``-x`` patterns.

    Returns:
        tuple: the selected entries, the member patterns nothing matched,
            the exclude patterns nothing matched.
    """
    if not members and not excludes:
        return infos, [], []
    encoded = tuple(member.encode() for member in members)
    encoded_excludes = tuple(pattern.encode() for pattern in excludes)
    hit = [False] * len(members)
    excluded_hit = [False] * len(excludes)
    selected: list[zipfile.ZipInfo] = []
    for info in infos:
        name = info.filename.encode()
        if members:
            idx = _spec_index(name, encoded)
            if idx is None:
                continue
            hit[idx] = True
        xidx = _spec_index(name, encoded_excludes)
        if xidx is not None:
            excluded_hit[xidx] = True
            continue
        selected.append(info)
    unmatched = [m for m, h in zip(members, hit) if not h]
    unmatched_excludes = [x for x, h in zip(excludes, excluded_hit) if not h]
    return selected, unmatched, unmatched_excludes


def _cautions(unmatched: list[str], excluded: list[str] | None = None) -> str:
    text = "".join(CAUTION_PREFIX + member + "\n" for member in unmatched)
    for pattern in excluded or []:
        text += EXCLUDED_CAUTION_PREFIX + pattern + "\n"
    return text


def _offset_slack(data: bytes) -> int:
    """Bytes before the archive proper, negative when bytes are missing.

    The end record names the central directory's offset and size; where
    the record actually sits minus where those say it should is the
    slack, the same arithmetic as Info-ZIP's ``extra_bytes`` and
    zipfile's ``concat``. Zero for a well-formed archive and for a file
    with no end record, which the caller has already refused.

    Args:
        data (bytes): the operand's bytes.
    """
    at = data.rfind(EOCD_SIGNATURE, max(0, len(data) - EOCD_SEARCH))
    if at < 0 or at + 20 > len(data):
        return 0
    cd_size = int.from_bytes(data[at + 12:at + 16], "little")
    cd_offset = int.from_bytes(data[at + 16:at + 20], "little")
    return at - (cd_offset + cd_size)


def _slack_warning(slack: int, archive: str) -> tuple[str, int]:
    """Info-ZIP's line for non-zero slack and the exit it floors at.

    Args:
        slack (int): ``_offset_slack``'s answer, non-zero.
        archive (str): the archive operand as typed.
    """
    if slack < 0:
        return MISSING_BYTES.format(archive, -slack), MISSING_EXIT
    return EXTRA_BYTES.format(archive, slack,
                              "" if slack == 1 else "s"), WARN_EXIT


def _central_directory_tiles(data: bytes) -> bool:
    """Whether the end record's entry count fills its directory exactly.

    Each central entry is a 46-byte header plus a name, an extra field
    and a comment of the lengths it declares, and the directory ends where
    the end record begins. A record that reaches past that end, or a count
    that leaves bytes over, is a corrupt directory. Info-ZIP and zipfile
    both read the truncated record anyway (Info-ZIP lists it and exits 1
    or 51; a short count makes Info-ZIP exit 3 after listing); mirage
    refuses up front so the two hosts answer the same.

    Args:
        data (bytes): the operand's bytes.
    """
    at = data.rfind(EOCD_SIGNATURE, max(0, len(data) - EOCD_SEARCH))
    if at < 0 or at + 20 > len(data):
        return False
    count = int.from_bytes(data[at + 10:at + 12], "little")
    cd_size = int.from_bytes(data[at + 12:at + 16], "little")
    offset = at - cd_size
    for _ in range(count):
        if offset < 0 or offset + 46 > at or not data.startswith(
                CENTRAL_SIGNATURE, offset):
            return False
        name_len = int.from_bytes(data[offset + 28:offset + 30], "little")
        extra_len = int.from_bytes(data[offset + 30:offset + 32], "little")
        comment_len = int.from_bytes(data[offset + 32:offset + 34], "little")
        offset += 46 + name_len + extra_len + comment_len
        if offset > at:
            return False
    return offset == at


def _refusal(data: bytes, archive: str, *, zipinfo: bool,
             pipe: bool) -> IOResult:
    """Info-ZIP's answer to a file zipfile could not open.

    Args:
        data (bytes): the operand's bytes.
        archive (str): the archive operand as typed.
        zipinfo (bool): ``-Z``, which signs as zipinfo.
        pipe (bool): ``-p``, which names the archive and does not sign.
    """
    if EOCD_SIGNATURE not in data[-EOCD_SEARCH:]:
        head = f"[{archive}]\n" if pipe or zipinfo else ""
        if pipe:
            tail = ""
        elif zipinfo:
            tail = ZIPINFO_NO_DIRECTORY.format(archive)
        else:
            tail = UNZIP_NO_DIRECTORY.format(archive)
        return IOResult(exit_code=NO_ARCHIVE_EXIT,
                        stderr=(head + NO_EOCD + tail).encode())
    return IOResult(exit_code=CORRUPT_EXIT,
                    stderr=CORRUPT_CDIR.format(archive).encode())


def _row(info: zipfile.ZipInfo) -> ZipRow:
    return ZipRow(name=info.filename,
                  size=info.file_size,
                  csize=info.compress_size,
                  method=info.compress_type,
                  flags=info.flag_bits,
                  internal_attr=info.internal_attr,
                  external_attr=info.external_attr,
                  host=info.create_system,
                  host_version=info.create_version,
                  date_time=info.date_time,
                  has_extra=bool(info.extra))


def _zipinfo(archive: str, zip_size: int, infos: list[zipfile.ZipInfo],
             selected: list[zipfile.ZipInfo], unmatched: list[str],
             unmatched_excludes: list[str], filtered: bool, *,
             names_only: bool, names_headers: bool, long: bool, medium: bool,
             short: bool, header: bool,
             totals: bool) -> tuple[ByteSource | None, IOResult]:
    """The ``-Z`` listing: zipinfo's rows, header and totals.

    zipinfo prints every unmatched pattern as a caution and exits 11
    only when the patterns left nothing at all, which is ``-l``'s rule
    with the cautions kept.

    Args:
        archive (str): the archive operand as typed.
        zip_size (int): the archive's byte length.
        infos (list[zipfile.ZipInfo]): the whole central directory.
        selected (list[zipfile.ZipInfo]): the entries the patterns left.
        unmatched (list[str]): the member patterns nothing matched.
        unmatched_excludes (list[str]): the ``-x`` patterns nothing matched.
        filtered (bool): whether any member or exclude pattern was given.
        names_only (bool): ``-1``.
        names_headers (bool): ``-2``.
        long (bool): ``-l``.
        medium (bool): ``-m``.
        short (bool): ``-s``.
        header (bool): ``-h``.
        totals (bool): ``-t``.
    """
    layout = zipinfo_layout(names_only=names_only,
                            names_headers=names_headers,
                            long=long,
                            medium=medium,
                            short=short,
                            header=header,
                            totals=totals,
                            has_members=filtered)
    rows = [_row(info) for info in selected]
    parts: list[str] = []
    if layout.header:
        parts.append(render_header(archive, zip_size, len(infos)))
    if layout.rows == "names":
        parts.extend(row.name + "\n" for row in rows)
    elif layout.rows != "none":
        parts.extend(render_row(row, layout.rows) + "\n" for row in rows)
    if layout.totals:
        parts.append(render_totals(rows))
    listing = "".join(parts).encode() or None
    cautions = _cautions(unmatched, unmatched_excludes)
    stderr = cautions.encode() if cautions else None
    exit_code = 11 if filtered and not selected else 0
    return listing, IOResult(exit_code=exit_code, stderr=stderr)


async def _make_dirs(dir_path: str, mkdir_fn: Callable[..., Awaitable[None]],
                     stat: StatFn | None, made: set[str]) -> None:
    """Create the chain for one entry, per door space.

    With a stat door the shared single-level walk runs (dispatch mkdir
    is single-level on most backends); without one the accessor's own
    mkdir handles the chain, which is the pre-workspace construction
    path where no dispatcher exists.

    Args:
        dir_path (str): the directory whose chain must exist.
        mkdir_fn (Callable): mkdir door.
        stat (StatFn | None): stat door in the same path space, if any.
        made (set[str]): levels already ensured this run.
    """
    if stat is None:
        await mkdir_fn(PathSpec.from_str_path(dir_path), parents=True)
        return
    await ensure_dir(dir_path, mkdir_fn, stat, made)


async def unzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    members: tuple[str, ...] = (),
    o: bool = False,
    args_l: bool = False,
    d: str | PathSpec | None = None,
    q: bool = False,
    p: bool = False,
    t: bool = False,
    x: tuple[str, ...] = (),
    Z: bool = False,
    args_1: bool = False,
    args_2: bool = False,
    s: bool = False,
    m: bool = False,
    h: bool = False,
    cwd: PathSpec | str = "/",
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("unzip: missing operand")
    if not Z:
        zipinfo_only = {"-1": args_1, "-2": args_2, "-s": s, "-m": m, "-h": h}
        for letter, given in zipinfo_only.items():
            if given:
                raise UsageError(
                    f"unzip: {letter} is a ZipInfo option and needs -Z",
                    exit_code=USAGE_EXIT)
    archive_path = paths[0]
    if relay:
        # Relay doors address by full virtual path (flat_scopes'
        # convention), not by the mount-relative key the wrapper's
        # accessor stamped.
        archive_path = PathSpec.from_str_path(archive_path.virtual)
    data = await read_bytes(archive_path)
    if not _central_directory_tiles(data):
        return None, _refusal(data, archive_path.virtual, zipinfo=Z, pipe=p)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data), "r")
    except zipfile.BadZipFile:
        return None, _refusal(data, archive_path.virtual, zipinfo=Z, pipe=p)
    with zf:
        out, result = await _run(zf, data, archive_path, members, x,
                                 write_bytes, mkdir_fn, stat, args_l, d, q, p,
                                 t, Z, args_1, args_2, s, m, h, cwd, relay)
    slack = _offset_slack(data)
    if slack == 0:
        return out, result
    warning, floor = _slack_warning(slack, archive_path.virtual)
    stderr = warning.encode() + (bytes(result.stderr) if isinstance(
        result.stderr, (bytes, bytearray)) else b"")
    return out, IOResult(exit_code=max(result.exit_code, floor),
                         stderr=stderr,
                         writes=result.writes)


async def _run(
    zf: zipfile.ZipFile,
    data: bytes,
    archive_path: PathSpec,
    members: tuple[str, ...],
    excludes: tuple[str, ...],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn | None,
    args_l: bool,
    d: str | PathSpec | None,
    q: bool,
    p: bool,
    t: bool,
    Z: bool,
    args_1: bool,
    args_2: bool,
    s: bool,
    m: bool,
    h: bool,
    cwd: PathSpec | str,
    relay: bool,
) -> tuple[ByteSource | None, IOResult]:
    """One mode over an opened archive: list, test, pipe, zipinfo, extract.

    Every pattern, member or ``-x``, that matched nothing is reported,
    and a filter that leaves nothing exits 11 in every mode.

    Args:
        zf (zipfile.ZipFile): the opened archive.
        data (bytes): its bytes, for the ``-Z`` header.
        archive_path (PathSpec): the archive operand.
        members (tuple[str, ...]): include patterns.
        excludes (tuple[str, ...]): ``-x`` patterns.
        write_bytes (Callable): write door.
        mkdir_fn (Callable): mkdir door.
        stat (StatFn | None): stat door in the same path space, if any.
        args_l (bool): ``-l``.
        d (str | PathSpec | None): ``-d``.
        q (bool): ``-q``.
        p (bool): ``-p``.
        t (bool): ``-t``.
        Z (bool): ``-Z``.
        args_1 (bool): ``-1``.
        args_2 (bool): ``-2``.
        s (bool): ``-s``.
        m (bool): ``-m``.
        h (bool): ``-h``.
        cwd (PathSpec | str): the session's working directory.
        relay (bool): dispatch-relayed doors.
    """
    infos = zf.infolist()
    selected, unmatched, unmatched_excludes = _select(infos, members, excludes)
    filtered = bool(members or excludes)
    nothing_left = filtered and not selected
    if Z:
        return _zipinfo(archive_path.virtual,
                        len(data),
                        infos,
                        selected,
                        unmatched,
                        unmatched_excludes,
                        filtered,
                        names_only=args_1,
                        names_headers=args_2,
                        long=args_l,
                        medium=m,
                        short=s,
                        header=h,
                        totals=t)
    if args_l:
        lines = ["  Length      Name", "---------  ----"]
        for info in selected:
            lines.append(f"{info.file_size:>9}  {info.filename}")
        listing = ("\n".join(lines) + "\n").encode()
        # GNU -l prints no caution lines and only exits 11 when the
        # patterns left nothing at all.
        if nothing_left:
            return listing, IOResult(exit_code=11)
        return listing, IOResult()
    if t:
        # GNU -t reports unmatched patterns on stdout; an unmatched
        # member counts as an error, an unmatched exclude does not, and
        # a filter that leaves nothing is its own caution.
        cautions = _cautions(unmatched, unmatched_excludes)
        if unmatched:
            msg = cautions + (f"At least one error was detected in "
                              f"{archive_path.virtual}.\n")
            return msg.encode(), IOResult(exit_code=11)
        if nothing_left:
            msg = cautions + ZERO_TESTED.format(archive_path.virtual)
            return msg.encode(), IOResult(exit_code=11)
        if filtered:
            bad = None
            for info in selected:
                if info.is_dir():
                    continue
                try:
                    zf.read(info)
                except zipfile.BadZipFile:
                    bad = info.filename
                    break
        else:
            bad = zf.testzip()
        if bad is not None:
            return f"first bad file: {bad}\n".encode(), IOResult()
        msg = cautions + f"No errors detected in {archive_path.virtual}\n"
        return msg.encode(), IOResult()
    cautions = _cautions(unmatched, unmatched_excludes)
    exit_code = 11 if unmatched or nothing_left else 0
    if p:
        chunks: list[bytes] = []
        for info in selected:
            if not info.is_dir():
                # Read the selected ZipInfo, not its name: a name
                # lookup resolves every duplicate to the last one.
                chunks.append(zf.read(info))
        return b"".join(chunks), IOResult(
            exit_code=exit_code,
            stderr=cautions.encode() if cautions else None)
    mount_prefix = mount_prefix_of(archive_path.virtual,
                                   archive_path.vfs_path) if isinstance(
                                       archive_path, PathSpec) else ""
    dest = extract_dest(d, cwd, relay)
    writes: dict[str, ByteSource] = {}
    made: set[str] = set()
    output_lines: list[str] = []
    for info in selected:
        entry_name = info.filename.lstrip("/")
        out_path = dest.rstrip("/") + "/" + entry_name.rstrip("/")
        report_path = out_path if relay else ((
            mount_prefix + out_path) if mount_prefix else out_path)
        if info.is_dir():
            # A directory entry is the only record an empty directory
            # leaves, so it has to be recreated even though nothing is
            # written inside it.
            await _make_dirs(out_path, mkdir_fn, stat, made)
            if not q:
                output_lines.append(f"   creating: {report_path}/")
            continue
        content = zf.read(info)
        parent = out_path.rsplit("/", 1)[0] or "/"
        if parent != "/":
            await _make_dirs(parent, mkdir_fn, stat, made)
        await write_bytes(PathSpec.from_str_path(out_path), data=content)
        if not relay:
            # Relay writes land on whichever mount owns each path and
            # invalidate through the dispatcher; keying them here would
            # have the runner prefix them onto this mount.
            writes[out_path] = content
        if not q:
            output_lines.append(f"  inflating: {report_path}")
    output = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    return output, IOResult(exit_code=exit_code,
                            stderr=cautions.encode() if cautions else None,
                            writes=writes)


__all__ = ["unzip"]


@dataclass(frozen=True, slots=True)
class UnzipFlags:
    overwrite: bool = False
    list_only: bool = False
    dest: "PathSpec | str | None" = None
    quiet: bool = False
    to_stdout: bool = False
    test_only: bool = False
    excludes: tuple[str, ...] = ()
    zipinfo: bool = False
    names_only: bool = False
    names_headers: bool = False
    short: bool = False
    medium: bool = False
    header: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> UnzipFlags:
    fl = FlagView(flags, spec=SPECS["unzip"])
    dest = fl.raw("d")
    return UnzipFlags(
        overwrite=fl.as_bool("o"),
        list_only=fl.as_bool("args_l"),
        dest=dest if isinstance(dest, (PathSpec, str)) else None,
        quiet=fl.as_bool("q"),
        to_stdout=fl.as_bool("p"),
        test_only=fl.as_bool("t"),
        excludes=tuple(fl.as_list("x")),
        zipinfo=fl.as_bool("Z"),
        names_only=fl.as_bool("args_1"),
        names_headers=fl.as_bool("2"),
        short=fl.as_bool("s"),
        medium=fl.as_bool("m"),
        header=fl.as_bool("h"),
    )


async def unzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await unzip(paths,
                       read_bytes=read_bytes,
                       write_bytes=write_bytes,
                       mkdir_fn=mkdir_fn,
                       stat=stat,
                       members=tuple(texts),
                       o=parsed.overwrite,
                       args_l=parsed.list_only,
                       d=parsed.dest,
                       q=parsed.quiet,
                       p=parsed.to_stdout,
                       t=parsed.test_only,
                       x=parsed.excludes,
                       Z=parsed.zipinfo,
                       args_1=parsed.names_only,
                       args_2=parsed.names_headers,
                       s=parsed.short,
                       m=parsed.medium,
                       h=parsed.header,
                       cwd=opts.cwd,
                       relay=relay)
