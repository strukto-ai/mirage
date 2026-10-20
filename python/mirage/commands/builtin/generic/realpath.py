import functools
import posixpath
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.links import links_of
from mirage.commands.builtin.utils.paths import dispatch_stat, link_target
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import missing_operand_error
from mirage.errors.fs import eloop, enoent, enotdir
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import FileType, PathSpec, StatFn

_MODES = {"canonicalize_existing": "e", "canonicalize_missing": "m"}
_LINKS = {"logical": "L", "physical": "P", "strip": "s", "no_symlinks": "s"}
# GNU 9.7 resolves a chain of any length (3,000 links measured) and calls
# a loop of any length a loop; a walk here stops at _LINK_LIMIT links, so a
# longer chain is refused as a loop. On a loop, `-m` keeps unresolved the
# first link that comes round again counting from the 21st: of
# l1 -> l2 -> ... -> lk -> l1, measured for k from 1 to 50, `realpath -m l1`
# prints l((20 mod k) + 1), and behind a chain of more than 20 links it
# prints the loop's first link.
_LINK_LIMIT = 1024
_KEPT_FROM = 21

_Step = tuple[str, tuple[str, ...]]


def _kept_link(steps: list[_Step], first: int) -> _Step:
    """The link ``-m`` leaves unresolved once the walk is back at a link.

    From ``first`` on the walk repeats itself every ``len(steps) - first``
    links, so the first link met again from the ``_KEPT_FROM``-th on is
    the loop's own first link, or the link that step lands on when fewer
    links lead into the loop.

    Args:
        steps (list[_Step]): each link followed, with the names left after
            it, in order.
        first (int): the index of the step the walk has come back to.
    """
    period = len(steps) - first
    landing = max(_KEPT_FROM - 1, first)
    return steps[first + (landing - first) % period]


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
) -> str:
    """A path with its links resolved, the walk ``realpath`` and
    ``readlink -f`` share.

    A relative word starts at the working directory. Each named component
    is appended and, unless ``nolinks``, a link there is read and its
    target put in front of the names left, so a ``..`` climbs from where a
    link leads. A link the session cannot see is no link, as a hidden path
    is no path: ``readlink`` is the dispatcher's reader, which answers
    none for it. A component followed by ``.`` or ``..`` must be a
    directory. A trailing slash rejects an existing non-directory. GNU
    9.7's default mode accepts a missing final component with a slash;
    ``nolinks`` also accepts missing parents. ``e`` requires existence;
    ``m`` checks nothing. A walk that comes back to a link with the same
    names left is in a loop, ``Too many levels of symbolic links``, and so
    is one that meets more than ``_LINK_LIMIT`` links, which covers a link
    that grows the names it leaves (``a -> a/x``) and that GNU walks until
    memory runs out. ``m`` instead leaves one link unresolved and goes on
    with the names left after it: on a loop the one ``_kept_link`` picks,
    past the limit the link it stopped at.

    Args:
        word (str): the path as given.
        cwd (str): the working directory, physical as getcwd's.
        mode (str): ``e``, ``m`` or empty, as ``RealpathFlags.mode``.
        nolinks (bool): resolve no link (``-s``, and ``-L``'s first pass).
        readlink (Callable[[str], str | None] | None): one link's target,
            None for a path that is not a link or one the session cannot
            see; None while the namespace holds no link.
        stat (StatFn): the workspace's stat of one path.

    Raises:
        OSError: the first check the walk fails.
    """
    if not word:
        raise enoent(word)
    names = [n for n in posixpath.join(cwd, word).split("/") if n]
    slash = word.endswith("/")
    path = "/"
    last = None
    steps: list[_Step] = []
    step_of: dict[_Step, int] = {}
    while names:
        last = name = names.pop(0)
        if name in (".", ".."):
            path = posixpath.dirname(path) if name == ".." else path
            continue
        path = posixpath.join(path, name)
        target = None if nolinks or readlink is None else readlink(path)
        if target is not None:
            here = (path, tuple(names))
            again = step_of.get(here)
            if again is None and len(steps) < _LINK_LIMIT:
                step_of[here] = len(steps)
                steps.append(here)
                slash = slash or (not names and target.endswith("/"))
                names[:0] = [n for n in target.split("/") if n]
                path = (
                    "/" if target.startswith("/") else posixpath.dirname(path)
                )
                continue
            if mode != "m":
                raise eloop(word)
            if again is not None:
                path, rest = _kept_link(steps, again)
                names[:] = rest
                last = posixpath.basename(path)
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
        )
        if flags.links != "L":
            return path
        return await canonicalize(path, cwd, flags.mode, False, readlink, stat)

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
    ctx: Context,
    stat_fn: StatFn,
) -> tuple[ByteSource | None, IOResult]:
    return await realpath(
        paths,
        stat=(
            functools.partial(dispatch_stat, ctx.vfs.dispatch)
            if ctx.vfs is not None
            else stat_fn
        ),
        cwd=ctx.cwd.virtual,
        readlink=link_target(links_of(ctx)),
        flags=parse_flags(ctx.flags),
    )
