import io
import posixpath
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.commands.builtin.generic.archive.types import MemberKind
from mirage.commands.builtin.generic.archive.walk import (OTHER_FILESYSTEM,
                                                          StatFn, WalkFn,
                                                          scan_operand)
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import respell_one

# Info-ZIP 3.0's wording, pinned on debian:stable-slim. A warning is
# indented with a tab and -q silences it; the "Nothing to do!" error is
# not a warning and survives -q. Exit 12 is Info-ZIP's ZE_NONE.
WARNING_PREFIX = "\tzip warning: "
# What Info-ZIP calls a path it could not reach. It does not distinguish
# absent from unreadable, and a dangling symlink under the default
# follow prints exactly this too.
NOT_MATCHED = "name not matched: "
NOTHING_TO_DO_EXIT = 12
# Info-ZIP has no mount boundaries to describe, so this borrows GNU
# tar's --one-file-system wording rather than inventing a second one.
CROSSING_REASON = OTHER_FILESYSTEM
# Unix mode bits in the high half of external_attr, which is where
# Info-ZIP puts them and where a symlink entry is told from a file.
DIR_MODE = 0o40755 << 16 | 0x10
FILE_MODE = 0o100644 << 16
LINK_MODE = 0o120777 << 16


@dataclass(frozen=True, slots=True)
class ZipMember:
    """One entry the plan decided to store.

    Args:
        name (str): the archive entry name; a directory carries the
            trailing slash Info-ZIP stores it with.
        kind (MemberKind): file, dir, or link.
        path (PathSpec | None): where a file's bytes come from.
        target (str): a symlink's target, which is its content.
    """

    name: str
    kind: MemberKind
    path: PathSpec | None = None
    target: str = ""


@dataclass(frozen=True, slots=True)
class ZipPlan:
    """What one ``zip`` run decided, before anything is written.

    Args:
        members (tuple[ZipMember, ...]): the entries to store, in order.
        warnings (tuple[str, ...]): stderr lines without their prefix.
        write (bool): whether to write an archive at all. Info-ZIP
            leaves no file behind when nothing matched.
    """

    members: tuple[ZipMember, ...]
    warnings: tuple[str, ...]
    write: bool


def member_name(spelled: str, kind: MemberKind, junk: bool) -> str:
    """The entry name Info-ZIP stores for a path as the operand typed it.

    A leading slash is stripped in silence (unlike tar, which warns), a
    directory carries a trailing slash, and ``-j`` throws the directory
    part away entirely.

    Args:
        spelled (str): the path as the operand spelled it.
        kind (MemberKind): what the entry is.
        junk (bool): ``-j``, store the basename only.
    """
    name = spelled.lstrip("/")
    if junk:
        name = posixpath.basename(name.rstrip("/"))
    if kind == "dir" and name and not name.endswith("/"):
        return name + "/"
    return name


def excluded(name: str, patterns: list[str]) -> bool:
    """Whether an Info-ZIP ``-x`` pattern matches this entry name.

    Info-ZIP matches the whole stored name, anchored, with wildcards
    crossing slashes: ``d/sub/*`` takes ``d/sub/`` and everything under
    it, ``*.txt`` takes every ``.txt`` at any depth, and a bare
    ``b.txt`` matches nothing below the top. That is the opposite of
    GNU tar's unanchored ``--exclude``, which is why the two have
    separate matchers.

    Args:
        name (str): the stored entry name, directories slash-terminated.
        patterns (list[str]): the raw ``-x`` values.
    """
    return any(fnmatch(name, pattern) for pattern in patterns)


async def plan_zip(
    paths: list[PathSpec],
    *,
    archive: PathSpec,
    stat: StatFn,
    walk: WalkFn,
    recurse: bool,
    junk: bool,
    store_links: bool,
    exclude: list[str],
    links: LinkView | None = None,
    mounts: MountView | None = None,
) -> ZipPlan:
    """Decide every entry of a new archive, before writing any of it.

    Info-ZIP's defaults are tar's inverted twice over: a directory
    operand contributes only itself unless ``-r`` says to descend, and a
    symlink is followed unless ``-y`` says to store the link. Both are
    parameters of the shared scan, so the traversal is the same one
    ``tar -c`` uses.

    Args:
        paths (list[PathSpec]): the file operands, glob-resolved.
        archive (PathSpec): the archive being written, so it is left out
            of itself the way Info-ZIP silently leaves it out.
        stat (StatFn): backend stat, raising when nothing is there.
        walk (WalkFn): subtree listing, by find type.
        recurse (bool): ``-r``.
        junk (bool): ``-j``.
        store_links (bool): ``-y``, store a symlink as a symlink.
        exclude (list[str]): the raw ``-x`` values.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
    """
    members: list[ZipMember] = []
    warnings: list[str] = []
    for path in paths:
        raw = path.raw_path
        base = path.virtual.rstrip("/") or "/"
        scan = await scan_operand(path,
                                  stat=stat,
                                  walk=walk,
                                  links=links,
                                  mounts=mounts,
                                  dereference=not store_links,
                                  recurse=recurse)
        for problem in scan.problems:
            shown = respell_one(problem.path, base, raw)
            if problem.fatal:
                warnings.append(NOT_MATCHED + shown)
            else:
                warnings.append(f"{shown}: {problem.reason}")
        if scan.missing:
            continue
        for crossing in scan.crossings:
            shown = respell_one(crossing, base, raw)
            warnings.append(f"{shown}: {CROSSING_REASON}")
        for entry in scan.entries:
            name = member_name(respell_one(entry.name_path, base, raw),
                               entry.kind, junk)
            if not name or excluded(name, exclude):
                continue
            # -j has no directory to name, so Info-ZIP drops directory
            # entries under it entirely rather than storing bare slashes.
            if junk and entry.kind == "dir":
                continue
            read = entry.read
            if read is not None and read.virtual == archive.virtual:
                # Info-ZIP never stores the archive it is writing, and
                # says nothing about it.
                continue
            members.append(
                ZipMember(name=name,
                          kind=entry.kind,
                          path=entry.read,
                          target=entry.target))
    return ZipPlan(members=tuple(members),
                   warnings=tuple(warnings),
                   write=bool(members))


def _info(member: ZipMember, size: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=member.name)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.file_size = size
    if member.kind == "dir":
        info.external_attr = DIR_MODE
        info.compress_type = zipfile.ZIP_STORED
    elif member.kind == "link":
        info.external_attr = LINK_MODE
    else:
        info.external_attr = FILE_MODE
    return info


def _stderr(warnings: tuple[str, ...], quiet: bool) -> bytes:
    if quiet:
        return b""
    return "".join(WARNING_PREFIX + line + "\n" for line in warnings).encode()


async def zip_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stat: StatFn,
    walk: WalkFn,
    r: bool = False,
    j: bool = False,
    q: bool = False,
    y: bool = False,
    x: list[str] | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    archive_path = paths[0]
    plan = await plan_zip(paths[1:],
                          archive=archive_path,
                          stat=stat,
                          walk=walk,
                          recurse=r,
                          junk=j,
                          store_links=y,
                          exclude=x or [],
                          links=links,
                          mounts=mounts)
    if not plan.write:
        # Info-ZIP writes no archive when nothing matched, and the error
        # is not a warning: -q does not silence it.
        nothing = f"\nzip error: Nothing to do! ({archive_path.raw_path})\n"
        return None, IOResult(exit_code=NOTHING_TO_DO_EXIT,
                              stderr=_stderr(plan.warnings, q) +
                              nothing.encode())
    buf = io.BytesIO()
    output_lines: list[str] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for member in plan.members:
            data = b""
            if member.kind == "link":
                data = member.target.encode()
            elif member.path is not None:
                data = await read_bytes(member.path)
            zf.writestr(_info(member, len(data)), data)
            output_lines.append(f"  adding: {member.name}")
    archive = buf.getvalue()
    await write_bytes(archive_path, archive)
    stdout = ("\n".join(output_lines) + "\n").encode() if not q else None
    return stdout, IOResult(writes={archive_path.mount_path: archive},
                            stderr=_stderr(plan.warnings, q))


__all__ = ["plan_zip", "zip_cmd"]
