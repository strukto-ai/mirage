import logging
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import UINTMAX
from mirage.commands.builtin.utils.links import (
    link_location,
    links_of,
    mount_root,
    name_location,
)
from mirage.commands.builtin.utils.size_suffix import decimal_value
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.errors.classify import classify, failure_text
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import Served, open_stream, serve_requests
from mirage.shell.bytes import byte_view, text_view
from mirage.types import FileStat, FileType, JsonValue, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, resolve_path
from mirage.utils.quote import shell_quote
from mirage.view.types import LinkView

logger = logging.getLogger(__name__)


# What patch changes on a path besides writing it.
PatchChanges = Mapping[str, Callable[[PathSpec], Awaitable[None]]]
# How patch sets a file's permission bits.
PatchChmod = Callable[[PathSpec, int], Awaitable[None]]


def _companion(spec: PathSpec, suffix: str) -> PathSpec:
    return PathSpec.from_str_path(
        spec.virtual + suffix, spec.vfs_path + suffix
    )


async def _load_patch_data(
    source: PathSpec | None,
    stdin: ByteSource | None,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> bytes | str:
    """The patch text, or GNU's fatal line when it cannot be had.

    GNU opens the patch file before anything else and gives up on the
    whole run when it cannot (exit 2): an open that fails names the file
    (``Can't open patch file x : ...``), a read that fails does not
    (``read error : ...``), since only one patch file is ever read.

    Args:
        source (PathSpec | None): the patch file, None for stdin.
        stdin (ByteSource | None): standard input.
        read_bytes (Callable): bound reader.
    """
    if source is None:
        data = await read_stdin_async(stdin)
        return b"" if data is None else data
    try:
        return await read_bytes(source)
    except READ_FAILURES as exc:
        return f"patch: **** read error : {fs_strerror(exc)}\n"
    except FS_ERRORS as exc:
        label = shell_quote(source.raw_path or source.virtual)
        return (
            f"patch: **** Can't open patch file {label} : {fs_strerror(exc)}\n"
        )


class _PatchFiles:
    """The files mirage-rs's patch engine reads and writes, whole.

    The engine reads the patch as ``-`` and names every other file as its
    report does: the ORIGFILE operand as typed, or a name from the patch,
    which resolves against the working directory, as GNU's does; ``.orig``
    and ``.rej`` after either name its companions. It stats the names it
    picks the file among, makes the directories a file it creates needs,
    and removes a file it empties with the directories that leaves empty.
    A file that is not there, is a directory or is a link is the engine's
    to report; any other failure is the command's.

    Args:
        source (PathSpec | None): the patch file, None for stdin.
        stdin (ByteSource | None): standard input.
        orig (PathSpec | None): ORIGFILE, the one file every section
            patches.
        cwd (str): the working directory names resolve against.
        root (str): the root of the mount the command runs on, which
            keys them.
        read_bytes (Callable): bound reader.
        write_bytes (Callable): bound writer.
        stat (Callable): stat refusing a directory with EISDIR.
        links (LinkView | None): the namespace's links, which a stat
            follows, as GNU's does; a link a name ends in stands even
            when it dangles, its file is refused and its companions
            stand beside it, as GNU's lstat finds it.
        changes (Mapping[str, Callable]): ``mkdir``, ``unlink`` and
            ``rmdir``.
        chmod (PatchChmod): sets the mode a git header gives a file.
    """

    def __init__(
        self,
        source: PathSpec | None,
        stdin: ByteSource | None,
        orig: PathSpec | None,
        cwd: str,
        root: str,
        read_bytes: Callable[..., Awaitable[bytes]],
        write_bytes: Callable[..., Awaitable[None]],
        stat: Callable[[PathSpec], Awaitable[FileStat]],
        links: LinkView | None,
        changes: PatchChanges,
        chmod: PatchChmod,
    ) -> None:
        self.errors = ByteSpool()
        self.source = source
        self.stdin = stdin
        self.orig = orig
        self.cwd = cwd
        self.root = root
        self.read_bytes = read_bytes
        self.write_bytes = write_bytes
        self.stat = stat
        self.links = links
        self.changes = changes
        self.chmod = chmod

    def _spec(self, path: str, change: bool = False) -> PathSpec:
        """The file a name the engine gives stands for.

        A stat or a read keeps the name as spelled, so `f/` or `f/.` asks
        for a directory, as GNU's stat does; a change drops the `.` steps a
        store without empty directories cannot walk, unless the name ends
        naming a directory, and keeps each `..` for the walk to take after
        the links before it, as the system's own lookup does.

        Args:
            path (str): the name, as the engine sends it.
            change (bool): the name is written, made or removed.
        """
        if self.orig is not None:
            typed = byte_view(self.orig.raw_path or self.orig.virtual)
            if path.startswith(typed):
                suffix = text_view(path[len(typed) :])
                if not suffix:
                    return self.orig
                where = self._linked(self.orig)
                if where is None:
                    return _companion(self.orig, suffix)
                return PathSpec.from_str_path(
                    where + suffix, mount_key(where + suffix, self.root)
                )
        name = text_view(path)
        virtual = resolve_path(name, self.cwd)
        key = mount_key(virtual, self.root)
        if change and not name.endswith(("/", "/.")) and name != ".":
            parts = [part for part in name.split("/") if part not in ("", ".")]
            name = "/" * name.startswith("/") + "/".join(parts)
        return PathSpec.from_str_path(name, key, cwd=self.cwd)

    def _linked(self, spec: PathSpec) -> str | None:
        """Where the link a name ends in stands, None when it ends in none.

        A name with dots walks its parent as the kernel does, each link
        followed before the ``..`` after it, so ``link/../f`` looks for
        ``f`` beside where ``link`` leads.

        Args:
            spec (PathSpec): the name, as the engine gave it.
        """
        if self.links is None:
            return None
        try:
            where = name_location(self.links, spec, self.cwd)
            if where is not None and spec.dotted is not None:
                where = link_location(self.links, spec.dotted)
        except CycleError as exc:
            logger.debug("no link ends %r: %s", spec.virtual, exc)
            return None
        if where is None or self.links.stat_at(where) is None:
            return None
        return where

    async def _kind(self, path: str) -> dict[str, JsonValue]:
        spec = self._spec(path)
        try:
            if self.links is not None and (
                (real := self.links.resolve(spec.virtual)) != spec.virtual
            ):
                spec = PathSpec.from_str_path(real, mount_key(real, self.root))
            found = await self.stat(spec)
        except IsADirectoryError:
            return {"kind": "dir"}
        except (FileNotFoundError, NotADirectoryError, CycleError) as exc:
            if self._linked(self._spec(path)) is not None:
                return {"kind": "link"}
            logger.debug("nothing stands at %r: %s", path, exc)
            return {}
        kind = "dir" if found.type == FileType.DIRECTORY else "file"
        if found.mode is None:
            return {"kind": kind}
        return {"kind": kind, "mode": found.mode}

    async def _change(
        self, run: Callable[[PathSpec], Awaitable[None]], path: str
    ) -> dict[str, JsonValue]:
        try:
            await run(self._spec(path, change=True))
        except OSError as exc:
            if (condition := classify(exc)) is None:
                raise
            return {
                "error": byte_view(failure_text(exc)),
                "errno": condition.name,
            }
        return {}

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Read the patch or a file whole, or write a file whole.

        Args:
            request (Mapping[str, JsonValue]): What the engine asks.
            data (bytes): The bytes a write carries.
        """
        path = str(request["path"])
        if request["op"] == "write":
            await self.write_bytes(self._spec(path, change=True), data)
            return Served({})
        if request["op"] == "stat":
            return Served(await self._kind(path))
        if request["op"] in self.changes:
            run = self.changes[str(request["op"])]
            return Served(await self._change(run, path))
        if request["op"] == "chmod":
            mode = int(str(request["mode"]))
            return Served(
                await self._change(lambda spec: self.chmod(spec, mode), path)
            )
        if request.get("file") is not True:
            patch = await _load_patch_data(
                self.source, self.stdin, self.read_bytes
            )
            if isinstance(patch, str):
                return Served({"line": byte_view(patch)})
            return Served({"end": True}, patch)
        spec = self._spec(path)
        try:
            if self._linked(spec) is not None:
                return Served({"errno": "ELOOP"})
            return Served({"end": True}, await self.read_bytes(spec))
        except IsADirectoryError:
            return Served({"errno": "EISDIR"})
        except (FileNotFoundError, NotADirectoryError) as exc:
            logger.debug("nothing to patch yet at %r: %s", path, exc)
            return Served({"errno": "ENOENT"})


# A -p value is one optional sign, then digits to the end of the word:
# GNU patch 2.8 refuses `3x` and ` 1`, and takes `+0`.
STRIP_COUNT = re.compile(r"[+-]?[0-9]+")


def _strip_count(text: str) -> int | None:
    """``-p`` as GNU patch scans it, None for no number.

    Args:
        text (str): the value as typed.
    """
    if STRIP_COUNT.fullmatch(text) is None:
        return None
    value = decimal_value(text.lstrip("+-"))
    return -value if text.startswith("-") else value


def _strip_refusal(text: str, value: int | None) -> str:
    """GNU patch's fatal line for a -p value that is no number or negative.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    problem = "is not a number" if value is None else "is negative"
    return f"patch: **** strip count {shell_quote(text)} {problem}"


@dataclass(frozen=True, slots=True)
class PatchFlags:
    strip: int | None = None
    reverse: bool = False
    input_path: PathSpec | None = None
    forward: bool = False
    directories: tuple[str, ...] = ()
    dry_run: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> PatchFlags:
    fl = FlagView(flags, spec=SPECS["patch"])
    input_flag = fl.raw("i")
    strip = fl.as_number("p", _strip_count, _strip_refusal, low=0, exit_code=2)
    # A count past a name's slashes strips them all, as any larger one
    # does, so UINTMAX stands in for one JSON cannot carry to mirage-rs.
    return PatchFlags(
        strip=None if strip is None else min(strip, UINTMAX),
        reverse=fl.as_bool("R"),
        input_path=input_flag if isinstance(input_flag, PathSpec) else None,
        forward=fl.as_bool("N"),
        directories=tuple(fl.as_list("directory")),
        dry_run=fl.as_bool("dry_run"),
    )


async def _directory(
    typed: str,
    cwd: str,
    root: str,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
) -> str | bytes:
    """The directory ``-d`` moves to from ``cwd``, or GNU patch's fatal
    line when it cannot move there. As chdir walks it, each entry a ``.``
    or ``..`` steps out of must be a directory too.

    Args:
        typed (str): the value as typed.
        cwd (str): where the ``-d`` before it left the run.
        root (str): the root of the mount the command runs on.
        stat (Callable): stat refusing a directory with EISDIR.
    """
    parts = typed.split("/")
    steps = [
        "/".join(parts[:at])
        for at in range(1, len(parts))
        if parts[at] in (".", "..") and any(parts[:at])
    ]
    why = "" if typed else "No such file or directory"
    for step in [*steps, typed] if typed else []:
        target = resolve_path(step, cwd)
        try:
            await stat(PathSpec.from_str_path(target, mount_key(target, root)))
            why = "Not a directory"
        except IsADirectoryError:
            continue
        except NotADirectoryError:
            why = "Not a directory"
        except FileNotFoundError as exc:
            why = "No such file or directory"
            logger.debug("no directory at %r: %s", target, exc)
        break
    if not why:
        return resolve_path(typed, cwd)
    label = shell_quote(typed)
    return f"patch: **** Can't change to directory {label} : {why}\n".encode()


def _moved(spec: PathSpec, cwd: str, root: str) -> PathSpec:
    """An operand typed relative, read from the directory ``-d`` left.

    Args:
        spec (PathSpec): the operand as the shell resolved it.
        cwd (str): the directory ``-d`` left the run in.
        root (str): the root of the mount the command runs on.
    """
    typed = spec.raw_path or spec.virtual
    if typed.startswith("/") or typed == "-":
        return spec
    return PathSpec.from_str_path(
        typed, mount_key(resolve_path(typed, cwd), root), cwd=cwd
    )


async def patch_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    changes: PatchChanges,
    chmod: PatchChmod,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.PATCH, paths[2].raw_path or paths[2].virtual
        )
    root = mount_root(ctx)
    cwd = ctx.cwd.virtual
    for typed in parsed.directories:
        moved = await _directory(typed, cwd, root, stat)
        if isinstance(moved, bytes):
            return None, IOResult(exit_code=2, stderr=moved)
        cwd = moved
    source = paths[1] if len(paths) > 1 else parsed.input_path
    if parsed.directories:
        paths = [_moved(path, cwd, root) for path in paths]
        source = None if source is None else _moved(source, cwd, root)
    # `patch [ORIGFILE [PATCHFILE]]`: the second operand is the patch
    # file, ahead of -i, and the first is the one file every hunk goes to
    # in place of the names the patch's headers carry, which otherwise
    # resolve against the working directory.
    orig = paths[0] if paths else None
    files = _PatchFiles(
        source,
        ctx.stdin,
        orig,
        cwd,
        root,
        read_bytes,
        write_bytes,
        stat,
        links_of(ctx),
        changes,
        chmod,
    )
    engine = open_stream(
        "patch",
        {
            "strip": parsed.strip,
            "reverse": parsed.reverse,
            "forward": parsed.forward,
            "dry_run": parsed.dry_run,
            "file": (
                None
                if orig is None
                else byte_view(orig.raw_path or orig.virtual)
            ),
        },
    )
    output = b"".join([chunk async for chunk in serve_requests(engine, files)])
    stderr = await files.errors.output()
    return output or None, IOResult(exit_code=engine.status(), stderr=stderr)


__all__ = ["patch_generic"]
