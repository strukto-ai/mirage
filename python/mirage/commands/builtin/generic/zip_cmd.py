# Refusal wording from Info-ZIP Zip 3.0 (Info-ZIP license; see
# licenses/third_party/info-zip.txt).

from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.builtin.generic.archive.walk import (
    OTHER_FILESYSTEM,
    WalkFn,
    scan_operand,
)
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, ReadStreamFn, StatFn
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


def parse_flags(flags: Mapping[str, FlagValue]) -> ZipFlags:
    fl = FlagView(flags, spec=SPECS["zip"])
    return ZipFlags(
        recursive=fl.as_bool("r"),
        junk_paths=fl.as_bool("j"),
        quiet=fl.as_bool("q"),
        store_links=fl.as_bool("y"),
        exclude=tuple(fl.as_list("x")),
    )


async def zip_cmd(
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
    """
    if not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    archive = paths[0]
    reads = [archive]
    found: list[JsonValue] = []
    warnings: list[JsonValue] = []
    for path in paths[1:]:
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
        "junk": flags.junk_paths,
        "quiet": flags.quiet,
    }
    host = StreamHost(reads, stream, None, dispatch, cwd, dash=False)
    io = IOResult()
    return hosted_stream("zip", config, host, io), io


__all__ = ["zip_cmd"]
