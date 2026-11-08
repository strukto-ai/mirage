import logging
import posixpath
import string
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from mirage.commands.builtin.constants import (
    GZIP_KNOWN_SUFFIXES,
    GZIP_LIST_HEAD,
    GZIP_LIST_VERBOSE_HEAD,
    GZIP_LIST_VERBOSE_INDENT,
    GZIP_MAX_SUFFIX,
    GZIP_RETRY_SUFFIXES,
    GZIP_SUFFIX,
    GZIP_TAR_SUFFIXES,
)
from mirage.commands.builtin.utils.constants import MONTHS, STDIN_OPERAND
from mirage.commands.builtin.utils.copy import path_exists
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.paths import (
    descendant_path,
    is_implicit_dir,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.builtin.utils.tree import before_full_walk
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eloop, enoent
from mirage.errors.render import fs_error_line
from mirage.errors.types import DotWalkMissing
from mirage.io.spool import ByteSpool, spooled
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    PolymorphicReadFn,
    ReaddirFn,
    StatFn,
)
from mirage.utils.clock import system_now
from mirage.utils.compress import (
    GzipDataError,
    GzipFacts,
    gunzip_stream,
    read_gzip_facts,
)
from mirage.utils.dates import epoch_to_iso, iso_timestamp

logger = logging.getLogger(__name__)

SetAttrsFn = Callable[[PathSpec, Mapping[str, Any]], Awaitable[Any]]

_ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)


def _ascii_lower(text: str) -> str:
    return text.translate(_ASCII_LOWER)


def gzip_suffix(name: str, suffix: str) -> str | None:
    """The compression suffix gzip reads off ``name``, as spelled there.

    As gzip 1.13 reads it: the -S suffix and the ones gzip always
    knows, compared without regard to ASCII case, and only where the
    name is longer than the suffix with no slash right before it, so
    neither ``.gz`` nor ``d/.gz`` has one. A -S suffix that ends one of
    the built-in ones is tried after them, or ``-S z`` would take the
    ``z`` off ``a.gz``.

    Args:
        name (str): the file name as typed.
        suffix (str): the -S suffix, ``.gz`` by default.
    """
    inner = any(
        len(suffix) < len(known) and known.endswith(suffix)
        for known in GZIP_KNOWN_SUFFIXES
    )
    own = _ascii_lower(suffix)
    order = (
        (*GZIP_KNOWN_SUFFIXES, own) if inner else (own, *GZIP_KNOWN_SUFFIXES)
    )
    lowered = _ascii_lower(name)
    for known in order:
        cut = len(lowered) - len(known)
        if cut > 0 and lowered.endswith(known) and lowered[cut - 1] != "/":
            return name[cut:]
    return None


def suffix_refusal(suffix: str) -> IOResult | None:
    """gzip's refusal of a -S suffix it cannot use, before any input.

    Args:
        suffix (str): the -S suffix, ``.gz`` by default.
    """
    if 0 < len(encode_text(suffix)) <= GZIP_MAX_SUFFIX:
        return None
    return IOResult(
        exit_code=1, stderr=encode_text(f"gzip: invalid suffix '{suffix}'\n")
    )


def _decompressed(path: PathSpec, suffix: str) -> tuple[str, PathSpec] | None:
    """The output ``gzip -d`` names for ``path``, typed and mounted.

    None for a name with no suffix gzip knows. ``.tgz`` and ``.taz``, in
    any case, become ``.tar``; any other suffix is dropped.

    Args:
        path (PathSpec): the compressed input.
        suffix (str): the -S suffix.
    """
    found = gzip_suffix(path.raw_path, suffix)
    if found is None:
        return None
    tar = ".tar" if _ascii_lower(found) in GZIP_TAR_SUFFIXES else ""
    cut = len(found)
    return (
        path.raw_path[:-cut] + tar,
        PathSpec.from_str_path(("/" + path.virtual.strip("/"))[:-cut] + tar),
    )


def _retries(
    path: PathSpec, missing: FileNotFoundError, suffix: str
) -> list[PathSpec]:
    """The names gzip -d opens in turn when ``path`` does not exist.

    Each is the name as typed with one suffix appended, in the same
    directory; the empty name makes the suffix itself the name. A name
    ending in a slash or a dot, or one whose walk failed before its last
    component, has no directory to hold a suffixed twin, so every one of
    them misses too. A retried name is read on the operand's own mount,
    where a namespace link is not followed.

    Args:
        path (PathSpec): the operand that does not exist.
        missing (FileNotFoundError): why it could not be opened.
        suffix (str): the -S suffix.
    """
    suffixes = (
        GZIP_RETRY_SUFFIXES
        if suffix == GZIP_SUFFIX
        else (suffix, *GZIP_RETRY_SUFFIXES)
    )
    typed = path.raw_path
    here = "/" + path.virtual.strip("/")
    if not typed:
        base = here.rstrip("/") + "/"
        return [
            replace(PathSpec.from_str_path(base + s), raw_path=s)
            for s in suffixes
        ]
    if typed.rsplit("/", 1)[-1] in ("", ".", "..") or isinstance(
        missing, DotWalkMissing
    ):
        return []
    return [
        replace(PathSpec.from_str_path(here + s), raw_path=typed + s)
        for s in suffixes
    ]


async def _resumed(
    first: bytes | None, rest: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    try:
        if first is None:
            return
        yield first
        async for chunk in rest:
            yield chunk
    finally:
        await close_quietly(rest)


async def _opened(source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """``source`` read up to its first chunk, so a failed open raises here.

    Args:
        source (AsyncIterator[bytes]): an input not yet read.
    """
    first = await anext(source, None)
    return _resumed(first, source)


@dataclass(frozen=True, slots=True)
class GzipInput:
    """One input gzip opened, and the name it opened it by.

    Attributes:
        name (PathSpec): the name opened, the operand or a suffixed retry
            of it, as typed.
        stream (AsyncIterator[bytes]): its bytes, read up to the first
            chunk, so the open has already succeeded.
        link (str | None): where the link the name stands on sits, when
            gzip followed one: an output in place is made beside the
            link, and the input it then removes is the link itself.
    """

    name: PathSpec
    stream: AsyncIterator[bytes]
    link: str | None = None


async def open_gzip_input(
    path: PathSpec,
    source: Callable[[PathSpec], AsyncIterator[bytes]],
    report: Callable[[str, int, bool], None],
    *,
    suffix: str = GZIP_SUFFIX,
    decompress: bool = True,
    follow: bool = False,
    resolver: LinkResolver | None = None,
) -> GzipInput | None:
    """Open one operand the way gzip 1.13 opens it.

    A name typed with a trailing slash has to be a directory. Without
    -c, -t or -f gzip opens with O_NOFOLLOW, so a link standing at the
    name, dangling or not, is ELOOP, which -q never quiets; with them it
    is followed, a retried name through the dispatcher, since what it leads to
    may live on any mount. A directory is a warning. A missing name with
    no suffix gzip knows is retried, when decompressing, with each
    suffix in turn and reported with the -S one; any other failure ends
    the operand. Every failure is reported in gzip's words, as its line,
    its exit code and whether it is a warning, and answers None.

    Args:
        path (PathSpec): the operand.
        source (Callable): reads a name on the operand's own mount.
        report (Callable): takes a failure's line, exit code and warning
            flag.
        suffix (str): the -S suffix.
        decompress (bool): whether a missing name is retried.
        follow (bool): -c, -t or -f, under which a link is followed.
        resolver (LinkResolver | None): the namespace's links, None when there
            are none.
    """
    retry = decompress and gzip_suffix(path.raw_path, suffix) is None
    names = [path]
    for name in names:
        link = resolver.link_at(name) if resolver is not None else None
        if link is not None and not follow:
            report(fs_error_line("gzip", name, eloop(name)), 1, False)
            return None
        try:
            if (
                resolver is not None
                and name is path
                and resolver.vanished(name)
            ):
                raise enoent(name.raw_path)
            # The router followed the operand itself; a retried name it
            # never saw is followed through the dispatcher.
            reads = (
                resolver.read(link)
                if resolver is not None
                and link is not None
                and name is not path
                else source(name)
            )
            return GzipInput(name, await _opened(reads), link)
        except IsADirectoryError:
            report(
                f"gzip: {name.raw_path} is a directory -- ignored\n", 2, True
            )
            return None
        except FileNotFoundError as exc:
            if retry and name is path:
                names.extend(_retries(path, exc, suffix))
        except FS_ERRORS as exc:
            report(fs_error_line("gzip", name, exc), 1, False)
            return None
    missing = path.raw_path + suffix if retry else path.raw_path
    report(fs_error_line("gzip", missing, FileNotFoundError()), 1, False)
    return None


async def output_taken(
    where: PathSpec, stat: StatFn | None, resolver: LinkResolver | None
) -> bool:
    """Whether anything stands where gzip creates an output.

    gzip creates with O_EXCL, which a link standing there refuses,
    dangling or not, so the probe is an lstat: through the dispatcher while
    the namespace holds links, the mount's own stat otherwise.

    Args:
        where (PathSpec): the output.
        stat (StatFn | None): the mount's stat.
        resolver (LinkResolver | None): the namespace's links.
    """
    if resolver is not None:
        return await path_exists(
            resolver.lstat, PathSpec.from_str_path(where.virtual)
        )
    return stat is not None and await path_exists(stat, where)


def beside_link(link: str, typed: str) -> PathSpec:
    """An output gzip names from a typed name standing on a link: in the
    link's own directory, whatever the link leads to.

    Args:
        link (str): where the link sits.
        typed (str): the output's name as gzip spells it.
    """
    return PathSpec.from_str_path(
        posixpath.join(posixpath.dirname(link), posixpath.basename(typed))
    )


def gzip_ratio(size: int, compressed: int, header: int) -> str:
    """gzip's ratio column: how far below ``size`` the deflated bytes
    come, the ``header`` bytes left out, none for empty data.

    Args:
        size (int): the uncompressed length.
        compressed (int): the compressed length.
        header (int): the bytes of it a header and trailer take.
    """
    saved = 0.0 if size == 0 else 100 * (size - (compressed - header)) / size
    return f"{saved:5.1f}%"


def verbose_line(shown: str, ratio: str, keep: bool, output: str) -> str:
    """What -v says once an input is done, ``output`` its result's name
    or ``stdout``.

    Args:
        shown (str): the input as typed.
        ratio (str): its ratio column.
        keep (bool): -k, under which the output was created beside it.
        output (str): the output's name.
    """
    done = "created" if keep else "replaced with"
    return f"{shown}:\t{ratio} -- {done} {output}\n"


def _list_date(epoch: float) -> str:
    """-l -v's date column, the month, day and minute in UTC.

    Args:
        epoch (float): the time as epoch seconds.
    """
    when = datetime.fromtimestamp(epoch, tz=UTC)
    return f"{MONTHS[when.month - 1]} {when.day:>2} {when.hour:02d}:{when.minute:02d}"


async def input_info(
    stat: StatFn | None,
    path: PathSpec,
    link: str | None = None,
    resolver: LinkResolver | None = None,
) -> FileStat | None:
    """The stat of what the input opened, for the attributes its output
    takes: a link it followed gives what it leads to. None when it cannot
    be had.

    Args:
        stat (StatFn | None): the mount's stat.
        path (PathSpec): the input.
        link (str | None): the link the input was opened through.
        resolver (LinkResolver | None): the namespace's links.
    """
    if stat is None or path.raw_path == "-":
        return None
    try:
        if link is not None and resolver is not None:
            return await resolver.stat(resolver.target(link))
        return await stat(path)
    except FS_ERRORS as exc:
        logger.debug("gzip: no stat for %s: %s", path.virtual, exc)
        return None


async def keep_attributes(
    set_attrs: SetAttrsFn | None,
    out: PathSpec,
    info: FileStat | None,
    mtime: int = 0,
) -> None:
    """Give an in-place output its input's mode and times, as gzip does;
    a nonzero ``mtime`` is the time -N restores from the header.

    Args:
        set_attrs (SetAttrsFn | None): sets attributes through the
            dispatcher.
        out (PathSpec): the output.
        info (FileStat | None): the input's stat.
        mtime (int): the stored time to restore, 0 for none.
    """
    if set_attrs is None:
        return
    fields: dict[str, Any] = {}
    if info is not None:
        if info.mode is not None:
            fields["mode"] = info.mode & 0o7777
        fields.update(mtime=info.modified, atime=info.atime)
    if mtime:
        fields["mtime"] = epoch_to_iso(mtime)
    kept = {k: v for k, v in fields.items() if v not in (None, "")}
    if not kept:
        return
    try:
        await set_attrs(out, kept)
    except FS_ERRORS as exc:
        logger.debug("gzip: attributes not kept on %s: %s", out.virtual, exc)


async def _is_directory(
    stat: StatFn, readdir: ReaddirFn, path: PathSpec
) -> bool:
    """Whether -r walks into ``path``: a directory, or a prefix a keyed
    backend lists; a path that cannot be told is opened as a file, which
    reports why.

    Args:
        stat (StatFn): the mount's stat.
        readdir (ReaddirFn): the mount's readdir.
        path (PathSpec): the operand or a file the walk found.
    """
    try:
        return (await stat(path)).type is FileType.DIRECTORY
    except FileNotFoundError:
        try:
            return await is_implicit_dir(readdir, path)
        except FS_ERRORS as exc:
            logger.debug("gzip: no listing for %s: %s", path.virtual, exc)
            return False
    except FS_ERRORS as exc:
        logger.debug("gzip: no stat for %s: %s", path.virtual, exc)
        return False


async def walked(
    paths: list[PathSpec],
    report: Callable[[str, int, bool], None],
    *,
    recursive: bool = False,
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
) -> AsyncIterator[tuple[PathSpec, bool]]:
    """Each operand in turn and, under -r, every file below a directory
    one, siblings in name order; True marks a file the walk found.

    Args:
        paths (list[PathSpec]): the operands.
        report (Callable): takes a failure's line, exit code and warning
            flag.
        recursive (bool): -r.
        stat (StatFn | None): the mount's stat.
        readdir (ReaddirFn | None): the mount's readdir.
    """

    async def below(
        stat: StatFn, readdir: ReaddirFn, root: PathSpec, directory: PathSpec
    ) -> AsyncIterator[PathSpec]:
        try:
            names = sorted(await readdir(directory))
        except FS_ERRORS as exc:
            report(fs_error_line("gzip", directory, exc), 1, False)
            return
        for name in names:
            child = descendant_path(root, name.rstrip("/"))
            if await _is_directory(stat, readdir, child):
                async for found in below(stat, readdir, root, child):
                    yield found
            else:
                yield child

    for path in paths:
        if (
            not recursive
            or stat is None
            or readdir is None
            or path.raw_path == "-"
            or not await _is_directory(stat, readdir, path)
        ):
            yield path, False
            continue
        async for found in below(stat, readdir, path, path):
            yield found, True


async def ask_before_walks(
    paths: list[PathSpec],
    stat: StatFn | None,
    readdir: ReaddirFn | None,
    dispatch: DispatchFn | None,
) -> None:
    """Let the mount under each directory -r reads refuse the walk, before
    any file is touched.

    Args:
        paths (list[PathSpec]): the operands.
        stat (StatFn | None): the mount's stat.
        readdir (ReaddirFn | None): the mount's readdir.
        dispatch (DispatchFn | None): the command's dispatcher.

    Raises:
        UsageError: a mount refused the walk.
    """
    if stat is None or readdir is None:
        return
    for path in paths:
        if path.raw_path != "-" and await _is_directory(stat, readdir, path):
            await before_full_walk(dispatch, path, "gzip")


def _named(path: PathSpec, stored: str | None) -> tuple[str, PathSpec] | None:
    """The output -N names from the stored name: its last component,
    beside the input; None when it stores no usable one.

    Args:
        path (PathSpec): the compressed input.
        stored (str | None): the name its header stores.
    """
    base = posixpath.basename(stored or "")
    if base in ("", ".", ".."):
        return None
    typed = posixpath.join(posixpath.dirname(path.raw_path), base)
    here = posixpath.dirname("/" + path.virtual.strip("/"))
    return typed, PathSpec.from_str_path(posixpath.join(here, base))


async def decompress_inputs(
    paths: list[PathSpec],
    *,
    read: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    to_stdout: bool = False,
    test_only: bool = False,
    keep: bool = False,
    force: bool = False,
    quiet: bool = False,
    verbose: bool = False,
    restore: bool = False,
    recursive: bool = False,
    suffix: str = GZIP_SUFFIX,
    write: Callable[..., Awaitable[None]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
    set_attrs: SetAttrsFn | None = None,
    resolver: LinkResolver | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Decode operands in order the way gzip 1.13 does, in its voice.

    gunzip and zcat are gzip, so every line says ``gzip:``. Each operand
    opens as ``open_gzip_input`` says. In place, a name with no known
    suffix and an output already there are skipped with a warning (exit
    2), a link standing there counting as one; a warning under -q prints
    nothing and keeps its exit code, except the unknown suffix, which -q
    drops whole. -f replaces an output, and decodes a name standing on a
    link beside the link, removing the link rather than what it leads
    to; with the output stdout it copies what is not gzip. An input
    stdin cannot open as gzip ends the run, as gzip exits there.

    With -f, an output already there is replaced, and when the input
    then turns out corrupt the reference has already unlinked it: mirage
    keeps it.

    Under -r a directory gives way to the files below it, and one found
    there with no known suffix is passed over, said only under -v,
    unless its bytes go to stdout. -v says each input's ratio once done
    (``OK`` under -t), never for stdin's. -N names an in-place output
    from the stored name and gives it the stored time; any in-place
    output takes its input's mode and times.

    Args:
        paths (list[PathSpec]): Expanded operands, empty for stdin.
        read (PolymorphicReadFn): Backend reader.
        stdin (ByteSource | None): Shared standard input cursor.
        to_stdout (bool): Write decoded bytes to stdout.
        test_only (bool): Validate without writing decoded bytes.
        keep (bool): Preserve compressed input after replacement.
        force (bool): Replace an output, follow a link, and copy what is
            not gzip.
        quiet (bool): Drop gzip's warnings.
        verbose (bool): -v.
        restore (bool): -N.
        recursive (bool): -r.
        suffix (str): The -S suffix.
        write (Callable | None): Write an in-place result.
        unlink (Callable | None): Remove a replaced input.
        stat (StatFn | None): Stat an operand or an in-place output.
        readdir (ReaddirFn | None): List a directory under -r.
        set_attrs (SetAttrsFn | None): Set an in-place output's
            attributes.
        resolver (LinkResolver | None): The namespace's links, None when there
            are none.
    """
    refused = suffix_refusal(suffix)
    if refused is not None:
        return None, refused
    operands = paths or [STDIN_OPERAND]
    raw_stream = normalized_read(read)
    stream = stdin_stream(raw_stream, stdin)
    follow = to_stdout or test_only or force
    io = IOResult()
    errors: list[bytes] = []

    def note(line: str) -> None:
        errors.append(encode_text(line))
        io.stderr = b"".join(errors)

    def report(line: str, code: int, warning: bool = False) -> None:
        if not (warning and quiet):
            note(line)
        if io.exit_code != 1:
            io.exit_code = code

    def fail(exc: GzipDataError, shown: str) -> None:
        report(exc.render(shown), exc.exit_code, exc.exit_code == 2)

    async def run() -> AsyncIterator[bytes]:
        async for operand, found in walked(
            operands, report, recursive=recursive, stat=stat, readdir=readdir
        ):
            on_stdin = operand.raw_path == "-"
            in_place = not (to_stdout or test_only or on_stdin)
            opened = (
                None
                if on_stdin
                else await open_gzip_input(
                    operand,
                    raw_stream if in_place else stream,
                    report,
                    suffix=suffix,
                    follow=follow,
                    resolver=resolver,
                )
            )
            if opened is None and not on_stdin:
                continue
            path = operand if opened is None else opened.name
            source = stream(operand) if opened is None else opened.stream
            link = None if opened is None else opened.link
            shown = "stdin" if on_stdin else path.raw_path
            output = _decompressed(path, suffix) if in_place else None
            passed = (
                found
                and (in_place or test_only)
                and gzip_suffix(path.raw_path, suffix) is None
            )
            if passed or (in_place and output is None):
                if verbose if found else not quiet:
                    report(f"gzip: {shown}: unknown suffix -- ignored\n", 2)
                await close_quietly(source)
                continue
            facts: list[GzipFacts] = []
            spool = ByteSpool()
            try:
                failure: GzipDataError | None = None
                try:
                    async with aclosing(
                        gunzip_stream(
                            source,
                            test_only,
                            force and not in_place,
                            facts.append,
                        )
                    ) as decoded:
                        async for chunk in decoded:
                            if in_place:
                                await spool.append(chunk)
                            elif not test_only:
                                yield chunk
                except GzipDataError as exc:
                    failure = exc
                except FS_ERRORS as exc:
                    report("\n" + fs_error_line("gzip", shown, exc), 1)
                    return
                if output is None:
                    if failure is not None:
                        fail(failure, shown)
                        if failure.fatal or (
                            on_stdin and failure.first_header
                        ):
                            return
                    elif verbose and test_only:
                        note(" OK\n" if on_stdin else f"{shown}:\t OK\n")
                    elif verbose and facts and not on_stdin:
                        note(_decoded_line(shown, facts[0], keep, "stdout"))
                    continue
                if failure is not None and failure.first_header:
                    fail(failure, shown)
                    if failure.fatal:
                        return
                    continue
                if write is None or unlink is None:
                    raise ValueError(
                        "in-place decompression requires write and unlink"
                    )
                out_name, out = output
                stored = facts[0] if facts else None
                named = (
                    _named(path, stored.name)
                    if restore and stored is not None
                    else None
                )
                if named is not None:
                    out_name, out = named
                if link is not None:
                    out = beside_link(link, out_name)
                existed = await output_taken(out, stat, resolver)
                if existed and not force:
                    report(exists_line(out_name), 2)
                    continue
                if failure is not None:
                    fail(failure, shown)
                    if failure.fatal:
                        return
                    if not failure.keeps_output:
                        continue
                data = spool.stream()
                try:
                    await replace_output(
                        out, data, write, resolver, link is not None
                    )
                except FS_ERRORS as exc:
                    line = fs_error_line("gzip", out_name, exc)
                    report(line if existed else "\n" + line, 1)
                    if existed:
                        continue
                    return
                await keep_attributes(
                    set_attrs,
                    out,
                    await input_info(stat, path, link, resolver),
                    stored.mtime if restore and stored is not None else 0,
                )
                if verbose and stored is not None:
                    note(_decoded_line(shown, stored, keep, out_name))
                if not keep:
                    await remove_input(path, link, unlink, resolver)
            finally:
                await spool.close()
                await close_quietly(source)

    body = run()
    if test_only or any(
        not (to_stdout or p.raw_path == "-") for p in operands
    ):
        return await spooled(body), io
    return body, io


def _decoded_line(shown: str, facts: GzipFacts, keep: bool, out: str) -> str:
    return verbose_line(
        shown,
        gzip_ratio(facts.size, facts.compressed, facts.header),
        keep,
        out,
    )


async def list_inputs(
    paths: list[PathSpec],
    *,
    read: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    quiet: bool = False,
    verbose: bool = False,
    restore: bool = False,
    recursive: bool = False,
    suffix: str = GZIP_SUFFIX,
    stat: StatFn | None = None,
    readdir: ReaddirFn | None = None,
    resolver: LinkResolver | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """``gzip -l``: one row per input that decodes, checked whole.

    An input opens as for ``-c`` and one that fails to decode is reported
    in gzip's words and passed over. The head comes before the first
    row, and with more than one operand a totals row ends the table once
    any row was printed, its ratio leaving out the header bytes of the
    input tried last (none for one that failed), as the reference counts
    it; -q drops both. The name is the input's without its suffix, or the
    stored one under -N; -v adds the method, the CRC and the date: the
    file's own, or the stored one under -N.

    Args:
        paths (list[PathSpec]): Expanded operands, empty for stdin.
        read (PolymorphicReadFn): Backend reader.
        stdin (ByteSource | None): Shared standard input cursor.
        quiet (bool): -q.
        verbose (bool): -v.
        restore (bool): -N.
        recursive (bool): -r.
        suffix (str): The -S suffix.
        stat (StatFn | None): Stat an input for its date.
        readdir (ReaddirFn | None): List a directory under -r.
        resolver (LinkResolver | None): The namespace's links.
    """
    refused = suffix_refusal(suffix)
    if refused is not None:
        return None, refused
    operands = paths or [STDIN_OPERAND]
    stream = stdin_stream(normalized_read(read), stdin)
    io = IOResult()
    errors: list[bytes] = []
    rows: list[str] = []
    totals = [0, 0]
    header = 0

    def report(line: str, code: int, warning: bool = False) -> None:
        if not (warning and quiet):
            errors.append(encode_text(line))
            io.stderr = b"".join(errors)
        if io.exit_code != 1:
            io.exit_code = code

    async for operand, found in walked(
        operands, report, recursive=recursive, stat=stat, readdir=readdir
    ):
        on_stdin = operand.raw_path == "-"
        opened = (
            None
            if on_stdin
            else await open_gzip_input(
                operand,
                stream,
                report,
                suffix=suffix,
                follow=True,
                resolver=resolver,
            )
        )
        if opened is None and not on_stdin:
            continue
        path = operand if opened is None else opened.name
        source = stream(operand) if opened is None else opened.stream
        shown = "stdin" if on_stdin else path.raw_path
        if found and gzip_suffix(path.raw_path, suffix) is None:
            await close_quietly(source)
            if verbose:
                report(f"gzip: {shown}: unknown suffix -- ignored\n", 2)
            continue
        try:
            facts = await read_gzip_facts(source)
        except GzipDataError as exc:
            header = 0
            report(exc.render(shown), exc.exit_code, exc.exit_code == 2)
            continue
        except FS_ERRORS as exc:
            header = 0
            report("\n" + fs_error_line("gzip", shown, exc), 1)
            continue
        header = facts.header
        totals[0] += facts.compressed
        totals[1] += facts.size
        stripped = _decompressed(path, suffix)
        name = (
            "stdout"
            if on_stdin
            else path.raw_path
            if stripped is None
            else stripped[0]
        )
        if restore and facts.name:
            name = facts.name
        numbers = (
            f"{facts.compressed:>19} {facts.size:>19} "
            f"{gzip_ratio(facts.size, facts.compressed, facts.header)}"
        )
        if not rows and not quiet:
            rows.append(GZIP_LIST_VERBOSE_HEAD if verbose else GZIP_LIST_HEAD)
        if verbose:
            if restore and facts.mtime:
                when: float = facts.mtime
            else:
                info = await input_info(stat, path)
                stamp = None if info is None else iso_timestamp(info.modified)
                when = system_now() if stamp is None else stamp
            numbers = f"defla {facts.crc:08x} {_list_date(when)} {numbers}"
        rows.append(f"{numbers} {name}")
    if rows and len(operands) > 1 and not quiet:
        indent = " " * GZIP_LIST_VERBOSE_INDENT if verbose else ""
        rows.append(
            f"{indent}{totals[0]:>19} {totals[1]:>19} "
            f"{gzip_ratio(totals[1], totals[0], header)} (totals)"
        )
    return encode_text("".join(f"{row}\n" for row in rows)), io


async def replace_output(
    out: PathSpec,
    data: ByteSource,
    write: Callable[..., Awaitable[None]],
    resolver: LinkResolver | None,
    beside: bool,
) -> None:
    """Write an in-place output, replacing a link standing at its name.

    gzip -f unlinks whatever holds the name before it creates the file,
    so a link there is removed, never written through; an output beside
    a link goes through the dispatcher, since the link may sit on any mount.

    Args:
        out (PathSpec): the output.
        data (bytes): its content.
        write (Callable): the operand mount's write.
        resolver (LinkResolver | None): the namespace's links.
        beside (bool): whether the output goes beside a link.
    """
    if (
        resolver is not None
        and resolver.links.stat_at(out.virtual) is not None
    ):
        await resolver.unlink(out.virtual)
    if beside and resolver is not None:
        await resolver.write(out.virtual, data)
        return
    await write(out, data)


async def remove_input(
    path: PathSpec,
    link: str | None,
    unlink: Callable[..., Awaitable[None]],
    resolver: LinkResolver | None,
) -> None:
    """Remove an input once its in-place output is written: the link it
    was named through, when there is one.

    Args:
        path (PathSpec): the operand.
        link (str | None): the link the operand stood on.
        unlink (Callable): the operand mount's unlink.
        resolver (LinkResolver | None): the namespace's links.
    """
    if link is None or resolver is None:
        await unlink(path)
    else:
        await resolver.unlink(link)


def exists_line(name: str) -> str:
    """gzip's refusal to replace an output already standing at its name.

    Args:
        name (str): the output as gzip names it.
    """
    return f"gzip: {name} already exists;\tnot overwritten\n"
