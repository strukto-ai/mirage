# Refusal wording from Info-ZIP Zip 3.0 (Info-ZIP license; see
# licenses/third_party/info-zip.txt).

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from mirage.commands.builtin.generic.archive.walk import (
    OTHER_FILESYSTEM,
    WalkFn,
    link_time,
    recorded_stamp,
    scan_operand,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
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
from mirage.utils.path import respell_one
from mirage.view.types import LinkView, MountView

# What Info-ZIP calls a path it could not reach. It does not distinguish
# absent from unreadable, and a dangling symlink under the default
# follow prints exactly this too.
NOT_MATCHED = "name not matched: "


@dataclass(frozen=True, slots=True)
class ZipFlags:
    recursive: bool = False
    junk_paths: bool = False
    quiet: bool = False
    store_links: bool = False
    exclude: tuple[str, ...] = ()
    include: tuple[str, ...] = ()
    update: bool = False
    freshen: bool = False
    delete: bool = False
    move_files: bool = False
    level: int | None = None
    test: bool = False
    verbose: bool = False
    line_ends: str = "keep"
    no_directories: bool = False
    temp: PathSpec | None = None
    comment_members: bool = False
    comment_archive: bool = False
    names_from_stdin: bool = False


_LEVELS = ("0", "args_1", *(str(level) for level in range(2, 10)))


def parse_flags(flags: Mapping[str, FlagValue]) -> ZipFlags:
    fl = FlagView(flags, spec=SPECS["zip"])
    levels = fl.texts(*_LEVELS)
    temp = fl.raw("b")
    ends = fl.as_int("args_l", 0)
    return ZipFlags(
        recursive=fl.as_bool("r"),
        junk_paths=fl.as_bool("j"),
        quiet=fl.as_bool("q"),
        store_links=fl.as_bool("y"),
        exclude=tuple(fl.as_list("x")),
        include=tuple(fl.as_list("i")),
        update=fl.as_bool("u"),
        freshen=fl.as_bool("f"),
        delete=fl.as_bool("d"),
        move_files=fl.as_bool("m"),
        level=int(levels[-1][0][-1]) if levels else None,
        test=fl.as_bool("T"),
        verbose=fl.as_bool("v"),
        line_ends="keep" if ends == 0 else "to_crlf" if ends == 1 else "to_lf",
        no_directories=fl.as_bool("D"),
        temp=temp if isinstance(temp, PathSpec) else None,
        comment_members=fl.as_bool("c"),
        comment_archive=fl.as_bool("z"),
        names_from_stdin=fl.as_bool("@"),
    )


async def _stdin_lines(stdin: ByteSource | None) -> list[str]:
    """Standard input, a line each and no trailing empty one.

    Args:
        stdin (ByteSource | None): standard input.
    """
    text = decode_text(await materialize(stdin))
    return text.removesuffix("\n").split("\n") if text else []


async def zip_generic(
    paths: list[PathSpec],
    *,
    stream: ReadStreamFn,
    dispatch: DispatchFn | None,
    cwd: PathSpec,
    stat: StatFn,
    walk: WalkFn,
    flags: ZipFlags,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Walk the operands and hand what they hold to mirage-rs's zip,
    which names each member, refuses a name two paths share, deflates
    them and writes the archive.

    Info-ZIP's defaults are tar's inverted twice over: a directory operand
    contributes only itself unless ``-r`` says to descend, and a symlink is
    followed unless ``-y`` says to store the link. Both are parameters of
    the shared scan, so the traversal is the one ``tar -c`` uses.

    Args:
        paths (list[PathSpec]): the archive, then the file operands,
            glob-resolved.
        stream (ReadStreamFn): reads the archive and each member.
        dispatch (DispatchFn | None): writes the archive.
        cwd (PathSpec): the working directory.
        stat (StatFn): backend stat, raising when nothing is there.
        walk (WalkFn): subtree listing, by find type.
        flags (ZipFlags): the parsed flags.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
        stdin (ByteSource | None): standard input, which -@ names files on
            and -c and -z read comments from.
    """
    if not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    archive = paths[0]
    reads = [archive]
    found: list[JsonValue] = []
    warnings: list[JsonValue] = []
    operands = list(paths[1:])
    stdin_lines: list[str] = []
    if flags.names_from_stdin:
        named = [
            replace(PathSpec.from_str_path(line, cwd=cwd), raw_path=line)
            for line in await _stdin_lines(stdin)
            if line
        ]
        for operand in named:
            if (
                mounts is not None
                and operand.walk_error is None
                and mounts.is_root(operand.virtual)
            ):
                line = (
                    f"zip: cannot read '{operand.raw_path}': "
                    "Device or resource busy"
                )
                return None, IOResult(
                    exit_code=1, stderr=format_records([line])
                )
        operands += named
    elif flags.comment_members or flags.comment_archive:
        stdin_lines = await _stdin_lines(stdin)
    for path in () if flags.delete else operands:
        raw = path.raw_path
        if path.walk_error is not None:
            # The walk refused the operand before zip ran (the empty name,
            # a link loop above the name), which Info-ZIP matches to
            # nothing, whatever the errno.
            warnings.append(byte_view(NOT_MATCHED + raw))
            continue
        base = path.virtual.rstrip("/") or "/"
        scan = await scan_operand(
            path,
            stat=stat,
            walk=walk,
            links=links,
            mounts=mounts,
            dereference=not flags.store_links,
            recurse=flags.recursive,
        )
        for problem in scan.problems:
            # Info-ZIP stores a directory it could not open and says
            # nothing about it (pinned on debian:stable-slim).
            if not problem.unreadable:
                shown = respell_one(problem.path, base, raw)
                text = f"{shown}: {problem.reason}"
                warnings.append(
                    byte_view(NOT_MATCHED + shown if problem.fatal else text)
                )
        if scan.missing:
            continue
        for crossing in scan.crossings:
            shown = respell_one(crossing, base, raw)
            warnings.append(byte_view(f"{shown}: {OTHER_FILESYSTEM}"))
        # Info-ZIP walks a bare `.` with an empty prefix, so what it finds
        # there is named bare.
        spelling = "" if raw == "." else raw
        for entry in scan.entries:
            read = entry.read
            # Info-ZIP never stores the archive it is writing.
            if read is not None and read.virtual == archive.virtual:
                continue
            item: dict[str, JsonValue] = {
                "spelled": byte_view(
                    respell_one(entry.name_path, base, spelling)
                ),
                "kind": entry.kind,
                "target": byte_view(entry.target),
                "mtime": link_time(links, entry.name_path)
                if entry.kind == "link"
                else (await recorded_stamp(stat, read))[0],
                "source": byte_view(entry.name_path),
            }
            if read is not None:
                reads.append(read)
                item["path"] = byte_view(read.raw_path)
                item["operand"] = len(reads)
            found.append(item)
    config: dict[str, JsonValue] = {
        "archive": byte_view(archive.raw_path),
        "output": byte_view(archive.virtual),
        "found": found,
        "warnings": warnings,
        "exclude": [byte_view(pattern) for pattern in flags.exclude],
        "include": [byte_view(pattern) for pattern in flags.include],
        "junk": flags.junk_paths,
        "quiet": flags.quiet,
        "update": flags.update,
        "freshen": flags.freshen,
        "refresh_all": (flags.update or flags.freshen) and not operands,
        "store_links": flags.store_links,
        "delete": flags.delete,
        "patterns": [byte_view(path.raw_path) for path in operands]
        if flags.delete
        else [],
        "move_files": flags.move_files,
        "level": flags.level,
        "test": flags.test,
        "verbose": flags.verbose,
        "line_ends": flags.line_ends,
        "no_directories": flags.no_directories,
        "temp": None if flags.temp is None else byte_view(flags.temp.virtual),
        "comment_members": flags.comment_members,
        "comment_archive": flags.comment_archive,
        "stdin_lines": [byte_view(line) for line in stdin_lines],
    }
    host = StreamHost(
        reads, stream, None, dispatch, cwd, dash=False, links=links
    )
    io = IOResult()
    return hosted_stream("zip", config, host, io), io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A zip line stores a link operand as given, its planner deciding
    whether to follow it (``-y``), and reads below a directory under
    ``-r``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(follows=Follow.NONE, reads_subtree=fl.as_bool("r"))


__all__ = ["facts", "zip_generic"]
