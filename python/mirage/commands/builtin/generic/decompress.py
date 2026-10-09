import posixpath
import string
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace

from mirage.commands.builtin.constants import (
    GZIP_KNOWN_SUFFIXES,
    GZIP_MAX_SUFFIX,
    GZIP_RETRY_SUFFIXES,
    GZIP_SUFFIX,
    GZIP_TAR_SUFFIXES,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.copy import path_exists
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eloop, enoent
from mirage.errors.render import fs_error_line
from mirage.errors.types import DotWalkMissing
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.compress import GzipDataError, gunzip_stream
from mirage.utils.key_prefix import mounted_path

_ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)


def gzip_suffix(name: str, suffix: str) -> str | None:
    """The compression suffix gzip reads off ``name``, as spelled there.

    gzip 1.13's get_suffix: the -S suffix and the ones gzip always
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
    own = suffix.translate(_ASCII_LOWER)
    order = (
        (*GZIP_KNOWN_SUFFIXES, own) if inner else (own, *GZIP_KNOWN_SUFFIXES)
    )
    lowered = name.translate(_ASCII_LOWER)
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
    tar = ".tar" if found.translate(_ASCII_LOWER) in GZIP_TAR_SUFFIXES else ""
    cut = len(found)
    return (
        path.raw_path[:-cut] + tar,
        mounted_path(path, path.mount_path[:-cut] + tar),
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
    if not typed:
        base = path.mount_path.rstrip("/") + "/"
        return [
            replace(mounted_path(path, base + s), raw_path=s) for s in suffixes
        ]
    if typed.rsplit("/", 1)[-1] in ("", ".", "..") or isinstance(
        missing, DotWalkMissing
    ):
        return []
    return [
        replace(mounted_path(path, path.mount_path + s), raw_path=typed + s)
        for s in suffixes
    ]


async def _resumed(
    first: bytes | None, rest: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    if first is None:
        return
    yield first
    async for chunk in rest:
        yield chunk


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
    """Open one operand the way gzip 1.13's open_input_file does.

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
    suffix: str = GZIP_SUFFIX,
    write: Callable[..., Awaitable[None]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
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
    then turns out corrupt GNU has already unlinked it: mirage keeps it.

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
        suffix (str): The -S suffix.
        write (Callable | None): Write an in-place result.
        unlink (Callable | None): Remove a replaced input.
        stat (StatFn | None): Stat an operand or an in-place output.
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

    def report(line: str, code: int, warning: bool = False) -> None:
        if not (warning and quiet):
            errors.append(encode_text(line))
            io.stderr = b"".join(errors)
        if io.exit_code != 1:
            io.exit_code = code

    def fail(exc: GzipDataError, shown: str) -> None:
        report(exc.render(shown), exc.exit_code, exc.exit_code == 2)

    async def run() -> AsyncIterator[bytes]:
        for operand in operands:
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
            if in_place and output is None:
                if not quiet:
                    report(f"gzip: {shown}: unknown suffix -- ignored\n", 2)
                continue
            chunks: list[bytes] = []
            failure: GzipDataError | None = None
            try:
                async for chunk in gunzip_stream(
                    source, test_only, force and not in_place
                ):
                    if in_place:
                        chunks.append(chunk)
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
                    if failure.fatal or (on_stdin and failure.first_header):
                        return
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
            if link is not None:
                out = beside_link(link, out_name)
            existed = await output_taken(out, stat, resolver)
            if existed and not force:
                report(
                    f"gzip: {out_name} already exists;\tnot overwritten\n", 2
                )
                continue
            if failure is not None:
                fail(failure, shown)
                if failure.fatal:
                    return
                if not failure.keeps_output:
                    continue
            data = b"".join(chunks)
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
            if not keep:
                await (
                    unlink(path)
                    if link is None or resolver is None
                    else resolver.unlink(link)
                )

    body = run()
    if test_only or any(
        not (to_stdout or p.raw_path == "-") for p in operands
    ):
        return (await materialize(body)) or None, io
    return body, io


async def replace_output(
    out: PathSpec,
    data: bytes,
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
