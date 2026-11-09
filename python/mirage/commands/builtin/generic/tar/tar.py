import logging
import posixpath
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import tzinfo

from mirage.commands.builtin.generic.archive.extract import extract_dest
from mirage.commands.builtin.generic.archive.walk import DirProbe, WalkFn
from mirage.commands.builtin.generic.tar import constants
from mirage.commands.builtin.generic.tar.create import (
    Exclusion,
    cannot,
    check_directories,
    plan_create,
)
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mount_view,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import virtual_key
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view, decode_text
from mirage.types import (
    Follow,
    JsonValue,
    LineFacts,
    PathSpec,
    ReadStreamFn,
    StatFn,
)
from mirage.utils.dates import parse_date_expr_async, stat_epoch
from mirage.utils.timezone import zone_from_env
from mirage.view.types import LinkView, MountView

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TarFlags:
    create: bool = False
    extract: bool = False
    list_only: bool = False
    codec: str | None = None
    verbose: bool = False
    deref: bool = False
    to_stdout: bool = False
    archive: PathSpec | None = None
    directories: tuple[PathSpec, ...] = ()
    typed: tuple[tuple[str, str], ...] = ()
    exclude: tuple["Exclusion | _ExcludeFile", ...] = ()
    lists_after: tuple[int, ...] = ()
    one_file_system: bool = False
    append: bool = False
    update: bool = False
    delete: bool = False
    auto_compress: bool = False
    absolute: bool = False
    preserve: bool = False
    numeric: bool = False
    mtime: str | None = None
    files_from: tuple[PathSpec, ...] = ()
    null: bool = False
    wildcards: bool | None = None
    unanchored: bool = False

    @property
    def sources(self) -> bool:
        """Whether the operands are files to archive."""
        return self.create or self.append or self.update


@dataclass(frozen=True, slots=True)
class _ExcludeFile:
    """A ``-X`` list, and how its patterns match.

    Args:
        path (PathSpec): the list.
        anchored (bool): as ``Exclusion``.
        wildcards (bool): as ``Exclusion``.
    """

    path: PathSpec
    anchored: bool
    wildcards: bool


_MODES = ("create", "extract", "list", "append", "update", "delete")
_CODECS = ("gzip", "bzip2", "xz")
_TYPED = (
    *_MODES,
    "strip_components",
    "file",
    *_CODECS,
    "keep_old_files",
    "overwrite",
    "skip_old_files",
    "sort",
    "owner",
    "group",
    "transform",
)
_MATCHING = (
    "exclude",
    "exclude_from",
    "exclude_vcs",
    "wildcards",
    "no_wildcards",
    "anchored",
    "no_anchored",
)


def _typed_config(typed: tuple[tuple[str, str], ...]) -> list[JsonValue]:
    """The options the tar engine reads, each text as a byte view.

    Args:
        typed (tuple[tuple[str, str], ...]): ``[name, text]`` as typed.
    """
    return [[name, byte_view(text)] for name, text in typed]


def parse_flags(flags: Mapping[str, FlagValue]) -> TarFlags | IOResult:
    """tar's flags, refused by the tar engine as argp refuses them.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.

    Returns:
        TarFlags | IOResult: the flags, or tar's refusal, exit 2.
    """
    fl = FlagView(flags, spec=SPECS["tar"])
    archive = fl.raw("file")
    typed = tuple(
        (
            name,
            archive.raw_path
            if name == "file" and isinstance(archive, PathSpec)
            else text,
        )
        for name, text in fl.texts(*_TYPED)
    )
    try:
        open_stream("tar", {"typed": _typed_config(typed)})
    except StreamRefusal as refusal:
        return refused(refusal)
    rules: list[Exclusion | _ExcludeFile] = []
    lists = iter(fl.as_paths("exclude_from"))
    anchored, wildcards = False, True
    wildcards_typed: bool | None = None
    unanchored = False
    for name, text in fl.texts(*_MATCHING):
        if name == "exclude":
            rules.append(Exclusion(text, anchored, wildcards))
        elif name == "exclude_from":
            rules.append(_ExcludeFile(next(lists), anchored, wildcards))
        elif name == "exclude_vcs":
            rules.extend(
                Exclusion(vcs, False, False) for vcs in constants.VCS_NAMES
            )
        elif name in ("wildcards", "no_wildcards"):
            wildcards_typed = wildcards = name == "wildcards"
        else:
            anchored = name == "anchored"
            unanchored = name == "no_anchored"
    lists_after: list[int] = []
    changes = 0
    for name, _ in fl.texts("directory", "files_from"):
        if name == "directory":
            changes += 1
        else:
            lists_after.append(changes)
    return TarFlags(
        create=fl.as_bool("create"),
        extract=fl.as_bool("extract"),
        list_only=fl.as_bool("list"),
        codec=next((codec for codec in _CODECS if fl.as_bool(codec)), None),
        verbose=fl.as_bool("verbose"),
        deref=fl.as_bool("dereference"),
        to_stdout=fl.as_bool("to_stdout"),
        archive=archive if isinstance(archive, PathSpec) else None,
        directories=tuple(fl.as_paths("directory")),
        typed=typed,
        exclude=tuple(rules),
        lists_after=tuple(lists_after),
        one_file_system=fl.as_bool("one_file_system"),
        append=fl.as_bool("append"),
        update=fl.as_bool("update"),
        delete=fl.as_bool("delete"),
        auto_compress=fl.as_bool("auto_compress"),
        absolute=fl.as_bool("absolute_names"),
        preserve=fl.as_bool("preserve_permissions"),
        numeric=fl.as_bool("numeric_owner"),
        mtime=fl.as_str("mtime"),
        files_from=tuple(fl.as_paths("files_from")),
        null=fl.as_bool("null"),
        wildcards=wildcards_typed,
        unanchored=unanchored,
    )


async def _whole(
    path: PathSpec, stream: ReadStreamFn, stdin: ByteSource | None
) -> bytes:
    """A list file's bytes, standard input for ``-``.

    Args:
        path (PathSpec): the list.
        stream (ReadStreamFn): reads a file.
        stdin (ByteSource | None): standard input.
    """
    if path.raw_path == "-":
        return await materialize(stdin)
    return await materialize(stream(path))


async def _exclusions(
    flags: TarFlags, stream: ReadStreamFn, stdin: ByteSource | None
) -> list[Exclusion] | str:
    """The patterns that leave members out, each ``-X`` list read, or
    the line a list that cannot be read ends the run with.

    Args:
        flags (TarFlags): the parsed flags.
        stream (ReadStreamFn): reads a list.
        stdin (ByteSource | None): standard input.
    """
    rules: list[Exclusion] = []
    for rule in flags.exclude:
        if isinstance(rule, Exclusion):
            rules.append(rule)
            continue
        try:
            data = await _whole(rule.path, stream, stdin)
        except FS_ERRORS as exc:
            return f"tar: {rule.path.raw_path}: {fs_strerror(exc)}"
        rules.extend(
            Exclusion(pattern, rule.anchored, rule.wildcards)
            for pattern in decode_text(data).split("\n")
            if pattern
        )
    return rules


@dataclass(frozen=True, slots=True)
class _Names:
    """What the ``-T`` lists named.

    Args:
        names (list[tuple[str, PathSpec]]): each name and the directory
            it is read in.
        notices (list[str]): what reading them said.
        status (int): the status those lines came to.
        failure (str | None): the line a list that cannot be read ends the
            run with.
    """

    names: list[tuple[str, PathSpec]]
    notices: list[str]
    status: int
    failure: str | None = None


async def _listed_names(
    flags: TarFlags,
    stream: ReadStreamFn,
    stdin: ByteSource | None,
    directories: list[PathSpec],
    cwd: PathSpec,
) -> _Names:
    """The names in every ``-T`` list: a line each, blank lines passed
    over, or one per NUL under ``--null``. A line that starts with a dash
    is an option, of which mirage reads ``-CDIR`` and ``--directory=DIR``.

    Args:
        flags (TarFlags): the parsed flags.
        stream (ReadStreamFn): reads a list.
        stdin (ByteSource | None): standard input.
        directories (list[PathSpec]): each ``-C`` of the line, in order.
        cwd (PathSpec): the working directory.
    """
    names: list[tuple[str, PathSpec]] = []
    notices: list[str] = []
    status = 0
    for source, changes in zip(
        flags.files_from, flags.lists_after, strict=True
    ):
        try:
            data = await _whole(source, stream, stdin)
        except IsADirectoryError as exc:
            logger.debug("tar: -T %s: %s", source.raw_path, exc)
            continue
        except FS_ERRORS as exc:
            failure = cannot(source.raw_path, "stat", fs_strerror(exc))
            return _Names([], [], 0, failure)
        base = directories[changes - 1] if changes else cwd
        separator = b"\0" if flags.null else b"\n"
        for number, raw in enumerate(data.split(separator), start=1):
            if not raw:
                continue
            line = decode_text(raw)
            if flags.null or not line.startswith("-"):
                names.append((line, base))
            elif line.startswith("--directory="):
                base = PathSpec.from_str_path(
                    line[len("--directory=") :], cwd=base
                )
            elif line.startswith("-C") and len(line) > 2:
                base = PathSpec.from_str_path(line[2:].lstrip(), cwd=base)
            else:
                notices.append(
                    f"tar: {source.raw_path}:{number}: unrecognized option"
                )
                status = constants.CREATE_ERROR_EXIT
    return _Names(names, notices, status)


def _selector_views(listed: _Names, selectors: list[str]) -> list[JsonValue]:
    """The ``-T`` names and the operands, as the engine reads them.

    Args:
        listed (_Names): what the lists named.
        selectors (list[str]): the member operands.
    """
    return [
        byte_view(selector)
        for selector in [*(name for name, _ in listed.names), *selectors]
    ]


def _codec_of(archive: PathSpec) -> tuple[str | None, str | None]:
    """What ``-a`` makes of an archive's name: the codec its suffix asks
    for, and the program it would take that mirage does not have.

    Args:
        archive (PathSpec): the archive.
    """
    name = posixpath.basename(archive.raw_path)
    suffix = posixpath.splitext(name)[1]
    return (
        constants.SUFFIX_CODECS.get(suffix),
        constants.SUFFIX_UNAVAILABLE.get(suffix),
    )


async def _stored_time(
    text: str, stat: StatFn, cwd: PathSpec, zone: tzinfo | None
) -> tuple[int, str | None] | IOResult:
    """What ``--mtime`` records: the time of the file it names when it
    starts with ``/`` or ``.``, otherwise the date it spells.

    Args:
        text (str): the option's value.
        stat (StatFn): backend stat.
        cwd (PathSpec): what a relative file resolves against.
        zone (tzinfo | None): the zone a date is read in; None is the
            host's.

    Returns:
        tuple[int, str | None] | IOResult: the time and a warning about
            it, or the refusal.
    """
    if text.startswith(("/", ".")):
        try:
            row = await stat(PathSpec.from_str_path(text, cwd=cwd))
        except FS_ERRORS as exc:
            return IOResult(
                exit_code=constants.CREATE_ERROR_EXIT,
                stderr=format_records(
                    [
                        cannot(text, "stat", fs_strerror(exc)),
                        "tar: Date sample file not found",
                        constants.USAGE_HINT,
                    ]
                ),
            )
        return (stat_epoch(row.modified) or 0), None
    placed = await parse_date_expr_async(text, zone)
    if placed is None:
        warning = (
            "tar: Substituting -9223372036854775807 for unknown date "
            f"format '{text}'"
        )
        return 0, warning
    return int(placed.timestamp()), None


async def tar(
    paths: list[PathSpec],
    selectors: list[str],
    flags: TarFlags,
    *,
    stream: ReadStreamFn,
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    dispatch: DispatchFn | None,
    cwd: PathSpec,
    stdin: ByteSource | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    relay: bool = False,
    chmod: Callable[[PathSpec, int], Awaitable[None]] | None = None,
    zone: tzinfo | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Plan what the host decides and run mirage-rs's tar over it: ``-c``,
    ``-r`` and ``-u`` walk their operands and check every ``-C`` here,
    then the engine encodes; ``-t``, ``-x`` and ``--delete`` check every
    ``-C`` here, and the engine reads the archive and writes what it
    extracts where the last ``-C`` or the working directory says, on
    whichever mount owns it.

    Args:
        paths (list[PathSpec]): ``-c``'s operands, glob-resolved and
            already re-based by any ``-C``.
        selectors (list[str]): ``-t`` and ``-x``'s member operands.
        flags (TarFlags): the parsed flags.
        stream (ReadStreamFn): reads the archive and each member.
        stat (StatFn): backend stat, raising when nothing is there.
        walk (WalkFn): subtree listing, by find type.
        is_dir (DirProbe): whether a ``-C`` can be entered.
        dispatch (DispatchFn | None): stats, makes and writes what the
            run reaches.
        cwd (PathSpec): what relative names resolve against.
        stdin (ByteSource | None): the archive when it is ``-``.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
        relay (bool): the reads route by full virtual path.
        chmod (Callable[[PathSpec, int], Awaitable[None]] | None): sets
            the mode ``-p`` restores.
        zone (tzinfo | None): the zone ``--mtime`` is read in.
    """
    # With no -f the archive is standard input or output, which is GNU
    # tar's compiled-in default (no TAPE in the environment).
    archive = flags.archive or replace(
        PathSpec.from_str_path("/dev/stdin"), raw_path="-"
    )
    if relay:
        archive = virtual_key(archive)
    directories = list(flags.directories)
    listed = await _listed_names(flags, stream, stdin, directories, cwd)
    if listed.failure is not None and not flags.sources:
        return None, IOResult(
            exit_code=constants.CREATE_ERROR_EXIT,
            stderr=format_records([listed.failure, constants.FATAL_TRAILER]),
        )
    codec = flags.codec
    unavailable = None
    if flags.auto_compress and archive.raw_path != "-":
        suffix_codec, unavailable = _codec_of(archive)
        codec = suffix_codec or codec
    config: dict[str, JsonValue] = {
        "archive": byte_view(archive.raw_path),
        "codec": codec,
        "verbose": flags.verbose,
        "typed": _typed_config(flags.typed),
        "absolute": flags.absolute,
        "numeric": flags.numeric,
    }
    rules = await _exclusions(flags, stream, stdin)
    if isinstance(rules, str) and not flags.sources:
        return None, IOResult(
            exit_code=constants.CREATE_ERROR_EXIT,
            stderr=format_records([rules, constants.FATAL_TRAILER]),
        )
    if flags.sources:
        unread = None if isinstance(rules, list) else rules
        leading = list(listed.notices)
        stored_time: int | None = None
        if flags.mtime is not None:
            found = await _stored_time(flags.mtime, stat, cwd, zone)
            if isinstance(found, IOResult):
                return None, found
            stored_time, warning = found
            if warning is not None:
                leading.append(warning)
        named = [_listed_operand(name, base) for name, base in listed.names]
        for operand in named:
            if (
                mounts is not None
                and operand.walk_error is None
                and mounts.is_root(operand.virtual)
            ):
                return None, IOResult(
                    exit_code=constants.CREATE_ERROR_EXIT,
                    stderr=format_records(
                        [
                            f"tar: {operand.raw_path}: Cannot open: "
                            "Device or resource busy",
                            constants.FATAL_TRAILER,
                        ]
                    ),
                )
        operands = [*named, *paths]
        plan = await plan_create(
            operands,
            archive=archive,
            exclude=rules if isinstance(rules, list) else (),
            dereference=flags.deref,
            stat=stat,
            walk=walk,
            is_dir=is_dir,
            directories=directories,
            links=links,
            mounts=mounts,
            one_file_system=flags.one_file_system,
            absolute=flags.absolute,
            allow_empty=bool(flags.files_from) or not flags.create,
            leading=leading,
            leading_status=listed.status,
        )
        if not plan.write:
            return None, IOResult(
                exit_code=plan.exit_code, stderr=format_records(plan.notices)
            )
        reads = [archive]
        members: list[JsonValue] = []
        for member in plan.members:
            item: dict[str, JsonValue] = {
                "name": byte_view(member.name),
                "kind": member.kind,
                "target": byte_view(member.target),
                "spelled": byte_view(member.spelled),
                "size": member.size,
                "mtime": member.mtime,
                "mode": member.mode,
            }
            if member.path is not None:
                reads.append(member.path)
                item["path"] = byte_view(member.path.raw_path)
                item["operand"] = len(reads)
            members.append(item)
        if archive.walk_error is not None:
            refused = fs_strerror(walk_refusal(archive))
            config["unopened"] = byte_view(refused or "")
        mode = (
            "create"
            if flags.create
            else "append"
            if flags.append
            else "update"
        )
        notices: list[JsonValue] = [
            byte_view(notice) for notice in plan.notices
        ]
        status = plan.exit_code
        failure = listed.failure or unread
        if failure is not None:
            notices = [byte_view(failure), byte_view(constants.FATAL_TRAILER)]
            status = constants.CREATE_ERROR_EXIT
            config["abandon"] = True
        config |= {
            "mode": mode,
            "output": byte_view(archive.virtual),
            "members": members,
            "notices": notices,
            "status": status,
            "probe": archive.walk_error is None,
            "mtime": stored_time,
            "unavailable": unavailable,
        }
        host = StreamHost(reads, stream, None, dispatch, cwd, dash=False)
    elif flags.delete:
        config |= {
            "mode": "delete",
            "output": byte_view(archive.virtual),
            "selectors": _selector_views(listed, selectors),
            "wildcards": flags.wildcards,
            "unanchored": flags.unanchored,
            "probe": archive.walk_error is None,
        }
        host = StreamHost([archive], stream, stdin, dispatch, cwd, dash=False)
    else:
        refusal = await check_directories(directories, is_dir, stat)
        dest = directories[-1] if directories else None
        exclusions: list[JsonValue] = [
            {
                "pattern": byte_view(rule.pattern),
                "anchored": rule.anchored,
                "wildcards": rule.wildcards,
            }
            for rule in (rules if isinstance(rules, list) else ())
        ]
        config |= {
            "mode": "list" if flags.list_only else "extract",
            "probe": archive.walk_error is None,
            "exclusions": exclusions,
            "selectors": _selector_views(listed, selectors),
            "wildcards": flags.wildcards,
            "unanchored": flags.unanchored,
            "preserve": flags.preserve,
            "to_stdout": flags.to_stdout,
            "base": byte_view(extract_dest(dest, cwd).rstrip("/")),
            "refusal": [byte_view(line) for line in refusal],
        }
        host = StreamHost(
            [archive], stream, stdin, dispatch, cwd, dash=False, chmod=chmod
        )
    io = IOResult()
    return hosted_stream("tar", config, host, io), io


def _listed_operand(name: str, base: PathSpec) -> PathSpec:
    """A ``-T`` name as an operand, spelled as it was listed.

    Args:
        name (str): the name.
        base (PathSpec): the directory it is read in.
    """
    return replace(PathSpec.from_str_path(name, cwd=base), raw_path=name)


async def tar_generic(
    parsed: TarFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    relay: bool = False,
    chmod: Callable[[PathSpec, int], Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await tar(
        paths,
        list(texts),
        parsed,
        stream=stream,
        stat=stat,
        walk=walk,
        is_dir=is_dir,
        dispatch=dispatch_of(ctx),
        cwd=ctx.cwd,
        stdin=ctx.stdin,
        links=links_of(ctx),
        mounts=mount_view(ctx.vfs),
        relay=relay,
        chmod=chmod,
        zone=zone_from_env(ctx.env),
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A tar line hands a link operand to its planner as given, which
    reads ``-h`` itself, reads below what it archives under ``-c``, ``-r``
    and ``-u``, and writes to create, change or extract, not to list or
    extract to stdout.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    sources = (
        fl.as_bool("create") or fl.as_bool("append") or fl.as_bool("update")
    )
    return LineFacts(
        follows=Follow.NONE,
        reads_subtree=sources,
        writes=sources
        or fl.as_bool("delete")
        or (fl.as_bool("extract") and not fl.as_bool("to_stdout")),
    )
