from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from mirage.commands.builtin.generic.archive.extract import extract_dest
from mirage.commands.builtin.generic.archive.walk import DirProbe, WalkFn
from mirage.commands.builtin.generic.tar.create import (
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
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view
from mirage.types import (
    Follow,
    JsonValue,
    LineFacts,
    PathSpec,
    ReadStreamFn,
    StatFn,
)
from mirage.view.types import LinkView, MountView


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
    exclude: str | None = None
    one_file_system: bool = False


_MODES = ("create", "extract", "list")
_CODECS = ("gzip", "bzip2", "xz")


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
    typed = tuple(fl.texts(*_MODES, "strip_components", "file"))
    try:
        open_stream("tar", {"typed": _typed_config(typed)})
    except StreamRefusal as refusal:
        return refused(refusal)
    archive = fl.raw("file")
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
        exclude=fl.as_str("exclude"),
        one_file_system=fl.as_bool("one_file_system"),
    )


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
) -> tuple[ByteSource | None, IOResult]:
    """Plan what the host decides and run mirage-rs's tar over it: ``-c``
    walks its operands and checks every ``-C`` here, then the engine
    encodes; ``-t`` and ``-x`` check every ``-C`` here, and the engine
    reads the archive and writes what it extracts where the last ``-C``
    or the working directory says, on whichever mount owns it.

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
    """
    # With no -f the archive is standard input or output, which is GNU
    # tar's compiled-in default (no TAPE in the environment).
    archive = flags.archive or replace(
        PathSpec.from_str_path("/dev/stdin"), raw_path="-"
    )
    if relay:
        archive = virtual_key(archive)
    directories = list(flags.directories)
    config: dict[str, JsonValue] = {
        "archive": byte_view(archive.raw_path),
        "codec": flags.codec,
        "verbose": flags.verbose,
    }
    if flags.create:
        plan = await plan_create(
            paths,
            archive=archive,
            exclude=flags.exclude,
            dereference=flags.deref,
            stat=stat,
            walk=walk,
            is_dir=is_dir,
            directories=directories,
            links=links,
            mounts=mounts,
            one_file_system=flags.one_file_system,
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
            }
            if member.path is not None:
                reads.append(member.path)
                item["path"] = byte_view(member.path.raw_path)
                item["operand"] = len(reads)
            members.append(item)
        if archive.walk_error is not None:
            refused = fs_strerror(walk_refusal(archive))
            config["unopened"] = byte_view(refused or "")
        config |= {
            "mode": "create",
            "output": byte_view(archive.virtual),
            "members": members,
            "notices": [byte_view(notice) for notice in plan.notices],
            "status": plan.exit_code,
        }
        host = StreamHost(reads, stream, None, dispatch, cwd, dash=False)
    else:
        refusal = await check_directories(directories, is_dir, stat)
        dest = directories[-1] if directories else None
        config |= {
            "mode": "list" if flags.list_only else "extract",
            "probe": archive.walk_error is None,
            "selectors": [byte_view(selector) for selector in selectors],
            "typed": _typed_config(flags.typed),
            "to_stdout": flags.to_stdout,
            "base": byte_view(extract_dest(dest, cwd).rstrip("/")),
            "refusal": [byte_view(line) for line in refusal],
        }
        host = StreamHost([archive], stream, stdin, dispatch, cwd, dash=False)
    io = IOResult()
    return hosted_stream("tar", config, host, io), io


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
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A tar line hands a link operand to its planner as given, which
    reads ``-h`` itself, reads below what it archives under ``-c``, and
    writes to create or extract, not to list or extract to stdout.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    create = fl.as_bool("create")
    return LineFacts(
        follows=Follow.NONE,
        reads_subtree=create,
        writes=create
        or (fl.as_bool("extract") and not fl.as_bool("to_stdout")),
    )
