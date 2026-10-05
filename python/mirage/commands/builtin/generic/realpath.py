import functools
import posixpath
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.paths import dispatch_stat, link_target
from mirage.commands.builtin.utils.wrap import to_pathspec
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import missing_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec, StatFn, Visibility
from mirage.utils.errors import eloop, enoent, enotdir, fs_error_line
from mirage.utils.hidden import path_visible
from mirage.utils.key_prefix import mount_prefix_of

_MODES = {"canonicalize_existing": "e", "canonicalize_missing": "m"}
_LINKS = {"logical": "L", "physical": "P", "strip": "s", "no_symlinks": "s"}
_LOOP_CHECK_AFTER = 20
_LINK_CEILING = 1024


@dataclass(frozen=True, slots=True)
class RealpathFlags:
    """GNU realpath's options, the last of each family winning.

    Args:
        mode (str): ``e`` every component must exist, ``m`` none has to,
            empty for all but the last (the default).
        links (str): ``P`` resolves each link as the walk meets it, ``L``
            resolves the ``..`` components first, ``s`` resolves none.
        quiet (bool): ``-q``, no message for an operand that fails.
        zero (bool): ``-z``, each line ends in NUL.
        relative_to (str | None): ``--relative-to``.
        relative_base (str | None): ``--relative-base``.
    """

    mode: str = ""
    links: str = "P"
    quiet: bool = False
    zero: bool = False
    relative_to: str | None = None
    relative_base: str | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> RealpathFlags:
    fl = FlagView(flags, spec=SPECS["realpath"])
    modes = fl.typed_order(*_MODES)
    links = fl.typed_order(*_LINKS)
    return RealpathFlags(
        mode=_MODES[modes[-1]] if modes else "",
        links=_LINKS[links[-1]] if links else "P",
        quiet=fl.as_bool("quiet"),
        zero=fl.as_bool("zero"),
        relative_to=fl.as_str("relative_to"),
        relative_base=fl.as_str("relative_base"),
    )


async def _directory(stat: StatFn, path: str, word: str) -> None:
    if (await stat(PathSpec.from_str_path(path))).type != FileType.DIRECTORY:
        raise enotdir(word)


async def canonicalize(
    word: str,
    cwd: str,
    mode: str,
    nolinks: bool,
    readlink: Callable[[str], str | None] | None,
    stat: StatFn,
    visibility: Visibility | None = None,
) -> str:
    """gnulib's canonicalize_filename_mode, over the workspace, which
    ``realpath`` and ``readlink -f`` share.

    A relative word starts at the working directory. Each named component
    is appended and, unless ``nolinks``, a link there is read and its
    target put in front of the names left, so a ``..`` climbs from where a
    link leads. A link the session cannot see is no link, as a hidden path
    is no path. A component followed by ``.`` or ``..`` must be a
    directory. A trailing slash rejects an existing non-directory. GNU
    9.7's default mode accepts a missing final component with a slash;
    ``nolinks`` also accepts missing parents. ``e`` requires existence;
    ``m`` checks nothing. A loop is a link met again with the same names
    left, looked for once 20 links are behind, as gnulib does; a link
    that grows the names it leaves (``a -> a/x``) never repeats, and GNU
    walks it until memory runs out, so the walk stops at
    ``_LINK_CEILING`` links. ``m`` leaves the looping link unresolved.

    Args:
        word (str): the path as given.
        cwd (str): the working directory, physical as getcwd's.
        mode (str): ``e``, ``m`` or empty, as ``RealpathFlags.mode``.
        nolinks (bool): resolve no link (``-s``, and ``-L``'s first pass).
        readlink (Callable[[str], str | None] | None): one link's target,
            None for a path that is not a link; None while the namespace
            holds no link.
        stat (StatFn): the workspace's stat of one path.
        visibility (Visibility | None): the session's visibility; a link
            it hides is no link.

    Raises:
        OSError: the first check the walk fails.
    """
    if not word:
        raise enoent(word)
    names = [n for n in posixpath.join(cwd, word).split("/") if n]
    slash = word.endswith("/")
    path = "/"
    last = None
    links = 0
    seen: set[tuple[str, tuple[str, ...]]] = set()
    while names:
        last = name = names.pop(0)
        if name in (".", ".."):
            path = posixpath.dirname(path) if name == ".." else path
            continue
        path = posixpath.join(path, name)
        target = (
            None
            if nolinks
            or readlink is None
            or not path_visible(visibility, path)
            else readlink(path)
        )
        if target is not None:
            links += 1
            key = (path, tuple(names))
            if links <= _LOOP_CHECK_AFTER or (
                key not in seen and links <= _LINK_CEILING
            ):
                if links > _LOOP_CHECK_AFTER:
                    seen.add(key)
                slash = slash or (not names and target.endswith("/"))
                names[:0] = [n for n in target.split("/") if n]
                path = (
                    "/" if target.startswith("/") else posixpath.dirname(path)
                )
                continue
            if mode != "m":
                raise eloop(word)
        if mode != "m" and names[:1] in ([".."], ["."]):
            await _directory(stat, path, word)
    if mode == "m" or last in (None, "..", "."):
        return path
    try:
        if slash:
            await _directory(stat, path, word)
        else:
            await stat(PathSpec.from_str_path(path))
    except FileNotFoundError:
        if mode == "e":
            raise
        if not nolinks:
            await _directory(stat, posixpath.dirname(path), word)
    return path


def _under(base: str, path: str) -> bool:
    return base == "/" or path == base or path.startswith(base + "/")


def _relative(path: str, base: str) -> str:
    common = posixpath.commonpath([path, base])
    climb = base[len(common) :].strip("/")
    rest = path[len(common) :].strip("/")
    parts = [".."] * (climb.count("/") + 1 if climb else 0)
    return "/".join(parts + ([rest] if rest else [])) or "."


async def realpath(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    cwd: str = "/",
    readlink: Callable[[str], str | None] | None = None,
    flags: RealpathFlags = RealpathFlags(),
    visibility: Visibility | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Print each operand's canonical path, GNU ``realpath`` (9.7).

    An operand that does not resolve is reported and the rest still
    print, exit 1. A ``--relative-to`` or ``--relative-base`` directory
    resolves the same way first, and one that does not ends the command.

    Args:
        paths (list[PathSpec]): the operands, read as typed.
        stat (StatFn): the workspace's stat of one path.
        cwd (str): the working directory.
        readlink (Callable[[str], str | None] | None): one link's target,
            None while the namespace holds no link.
        flags (RealpathFlags): the parsed options.
        visibility (Visibility | None): the session's visibility; a link
            it hides is no link.
    """
    if not paths:
        raise missing_operand_error("realpath", None)

    async def canon(word: str) -> str:
        path = await canonicalize(
            word,
            cwd,
            flags.mode,
            flags.links != "P",
            readlink,
            stat,
            visibility,
        )
        if flags.links != "L":
            return path
        return await canonicalize(
            path, cwd, flags.mode, False, readlink, stat, visibility
        )

    async def directory(word: str) -> str:
        path = await canon(word)
        if flags.mode == "e":
            await _directory(stat, path, word)
        return path

    relative_to = (
        flags.relative_to
        if flags.relative_to is not None
        else flags.relative_base
    )
    to = base = None
    for word in dict.fromkeys(
        w for w in (relative_to, flags.relative_base) if w is not None
    ):
        try:
            path = await directory(word)
        except OSError as exc:
            return None, IOResult(
                exit_code=1,
                stderr=encode_text(fs_error_line("realpath", word, exc)),
            )
        if word != relative_to:
            to, base = (to, path) if _under(path, to or "/") else (None, to)
        else:
            to, base = path, path if word == flags.relative_base else None
    lines: list[str] = []
    errors: list[str] = []
    failed = False
    for p in paths:
        try:
            path = await canon(p.raw_path)
        except OSError as exc:
            failed = True
            if not flags.quiet:
                errors.append(fs_error_line("realpath", p, exc))
            continue
        if to is None or (base is not None and not _under(base, path)):
            lines.append(path)
        else:
            lines.append(_relative(path, to))
    end = "\0" if flags.zero else "\n"
    out = encode_text("".join(line + end for line in lines)) or None
    return out, IOResult(
        stderr=encode_text("".join(errors)) or None,
        exit_code=1 if failed else 0,
    )


async def realpath_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat_fn: StatFn,
) -> tuple[ByteSource | None, IOResult]:
    prefix = (
        mount_prefix_of(paths[0].virtual, paths[0].vfs_path) if paths else ""
    )

    async def stat(path: PathSpec) -> FileStat:
        return await stat_fn(to_pathspec(path.virtual, prefix))

    return await realpath(
        paths,
        stat=(
            functools.partial(dispatch_stat, opts.dispatch)
            if opts.dispatch is not None
            else stat
        ),
        cwd=opts.cwd.virtual,
        readlink=link_target(opts.ns.links if opts.ns is not None else None),
        flags=parse_flags(opts.flags),
        visibility=opts.ns.visibility if opts.ns is not None else None,
    )
