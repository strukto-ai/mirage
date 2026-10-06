import random
import string
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.path import resolve_path

_ALPHABET = string.ascii_letters + string.digits
DEFAULT_TEMPLATE = "tmp.XXXXXXXXXX"
# How many names a create draws before it gives up with EEXIST.
ATTEMPTS = 100


def _random_suffix(length: int) -> str:
    return "".join(random.choices(_ALPHABET, k=length))


def _typed(value: PathSpec | None) -> str:
    return value.raw_path if value is not None else ""


def plan_template(
    template: str | None,
    suffix: str | None,
    dest_dir: str,
    use_dest_dir: bool,
    t: bool,
    env_tmpdir: str,
) -> tuple[str, int, int]:
    """The template a create names, formed as GNU mktemp forms it.

    The name stays as typed, so a relative template or directory prints
    and refuses relative: a bare template lives in the working
    directory, and only a line with no template, ``-p``/``--tmpdir`` or
    ``-t`` joins a directory in front of it (``$TMPDIR`` if set, else
    ``/tmp``; ``-t`` prefers ``$TMPDIR`` over ``-p``). Pinned against
    GNU coreutils 9.7 (debian:stable-slim).

    Args:
        template (str | None): the operand, or None for the default.
        suffix (str | None): the ``--suffix`` value.
        dest_dir (str): the ``-p``/``--tmpdir`` value as typed, or "".
        use_dest_dir (bool): whether ``-p``, ``--tmpdir`` or ``-t`` was
            given.
        t (bool): whether ``-t`` was given.
        env_tmpdir (str): the session's ``$TMPDIR``, or "".

    Returns:
        tuple[str, int, int]: the formed template, how many X's end its
            body, and the length of the suffix after them.
    """
    if template is None:
        template = DEFAULT_TEMPLATE
        use_dest_dir = True
    if suffix is not None:
        if not template.endswith("X"):
            raise UsageError(
                f"mktemp: with --suffix, template '{quote_text(template)}' "
                "must end in X",
                1,
            )
        template += suffix
    else:
        last_x = template.rfind("X")
        suffix = template[last_x + 1 :] if last_x >= 0 else ""
    if "/" in suffix:
        raise UsageError(
            f"mktemp: invalid suffix '{quote_text(suffix)}', contains "
            "directory separator",
            1,
        )
    body = template[: len(template) - len(suffix)]
    x_count = len(body) - len(body.rstrip("X"))
    if x_count < 3:
        raise UsageError(
            f"mktemp: too few X's in template '{quote_text(template)}'", 1
        )
    if use_dest_dir or t:
        if t:
            directory = env_tmpdir or dest_dir or "/tmp"
            if "/" in template:
                raise UsageError(
                    f"mktemp: invalid template, '{quote_text(template)}', "
                    "contains directory separator",
                    1,
                )
        else:
            directory = dest_dir or env_tmpdir or "/tmp"
            if template.startswith("/"):
                raise UsageError(
                    f"mktemp: invalid template, '{quote_text(template)}'; "
                    "with --tmpdir, it may not be absolute",
                    1,
                )
        separator = "" if directory.endswith("/") else "/"
        template = directory + separator + template
    return template, x_count, len(suffix)


async def mktemp(
    *texts: str,
    mkdir_fn: Callable[..., Awaitable[None]],
    write_bytes_fn: Callable[..., Awaitable[None]],
    d: bool = False,
    p: PathSpec | None = None,
    use_dest_dir: bool = False,
    t: bool = False,
    dry_run: bool = False,
    suffix: str | None = None,
    quiet: bool = False,
    env_tmpdir: str = "",
    cwd: str = "/",
    exists_fn: Callable[[PathSpec], Awaitable[bool]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Create a temporary file or directory and print its name.

    The create is one file or one directory, never a directory the line
    named: a missing one answers ENOENT, the way GNU's
    ``open(O_CREAT|O_EXCL)`` does. The one exception is ``/tmp`` when it
    is only the fallback: a system always has it, but a workspace's root
    starts empty, so it is made on first use. ``mkdir_fn`` and
    ``write_bytes_fn`` take the resolved virtual path, so the create
    lands on whichever mount owns it, not the one the working directory
    is on. A name already taken is never reused: GNU creates exclusively
    and draws again, so an existing file is left alone, and ``-u`` names
    only a free one.

    Args:
        *texts (str): the template operand, if any.
        mkdir_fn (Callable[..., Awaitable[None]]): creates one directory.
        write_bytes_fn (Callable[..., Awaitable[None]]): creates one file.
        d (bool): create a directory (``-d``).
        p (PathSpec | None): the ``-p``/``--tmpdir`` directory.
        use_dest_dir (bool): whether ``-p``/``--tmpdir``/``-t`` was given.
        t (bool): ``-t``.
        dry_run (bool): ``-u``: print the name only.
        suffix (str | None): ``--suffix``.
        quiet (bool): ``-q``: no diagnostic for a failed create.
        env_tmpdir (str): the session's ``$TMPDIR``.
        cwd (str): the working directory a relative name resolves in.
        exists_fn (Callable[[PathSpec], Awaitable[bool]] | None): whether
            a name is taken, asked of the mount that owns it.
    """
    if len(texts) > 1:
        raise extra_operand_error(CommandName.MKTEMP, texts[1])
    dest_dir = _typed(p)
    use_dest_dir = use_dest_dir or p is not None
    template, x_count, suffix_len = plan_template(
        texts[0] if texts else None,
        suffix,
        dest_dir,
        use_dest_dir,
        t,
        env_tmpdir,
    )
    fallback = (
        (not texts or use_dest_dir or t) and not dest_dir and not env_tmpdir
    )
    end = len(template) - suffix_len

    def draw() -> str:
        return (
            template[: end - x_count]
            + _random_suffix(x_count)
            + template[end:]
        )

    async def create(path: PathSpec) -> None:
        if d:
            await mkdir_fn(path)
        else:
            await write_bytes_fn(path, b"")

    name = draw()
    try:
        for _ in range(ATTEMPTS):
            path = PathSpec.from_str_path(resolve_path(name, cwd))
            if exists_fn is None or not await exists_fn(path):
                break
            name = draw()
        else:
            raise FileExistsError(path.virtual)
        if not dry_run:
            try:
                await create(path)
            except FileNotFoundError:
                if not fallback:
                    raise
                await mkdir_fn(PathSpec.from_str_path("/tmp"))
                await create(path)
    except FS_ERRORS as exc:
        # -q suppresses the diagnostic about the create only (GNU); a
        # bad template still says so.
        if quiet:
            return None, IOResult(exit_code=1)
        kind = "directory" if d else "file"
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"mktemp: failed to create {kind} via template "
                f"'{quote_text(template)}': {fs_strerror(exc)}\n"
            ).encode(),
        )
    return (name + "\n").encode(), IOResult()


__all__ = ["mktemp"]


@dataclass(frozen=True, slots=True)
class MktempFlags:
    directory: bool = False
    tmpdir: PathSpec | None = None
    use_dest_dir: bool = False
    template_mode: bool = False
    dry_run: bool = False
    suffix: str | None = None
    quiet: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> MktempFlags:
    fl = FlagView(flags, spec=SPECS["mktemp"])
    tmpdir_flag = fl.raw("tmpdir")
    p_flag = fl.raw("p")
    tmpdir: PathSpec | None
    if isinstance(tmpdir_flag, PathSpec):
        tmpdir = tmpdir_flag
    elif isinstance(p_flag, PathSpec):
        tmpdir = p_flag
    else:
        tmpdir = None
    return MktempFlags(
        directory=fl.as_bool("directory"),
        tmpdir=tmpdir,
        use_dest_dir=tmpdir_flag is not None or p_flag is not None,
        template_mode=fl.as_bool("t"),
        dry_run=fl.as_bool("dry_run"),
        suffix=fl.as_str("suffix"),
        quiet=fl.as_bool("quiet"),
    )


async def mktemp_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    mkdir_fn: Callable[..., Awaitable[None]],
    write_bytes_fn: Callable[..., Awaitable[None]],
    exists_fn: Callable[[PathSpec], Awaitable[bool]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await mktemp(
        *texts,
        mkdir_fn=mkdir_fn,
        write_bytes_fn=write_bytes_fn,
        d=parsed.directory,
        p=parsed.tmpdir,
        use_dest_dir=parsed.use_dest_dir,
        t=parsed.template_mode,
        dry_run=parsed.dry_run,
        suffix=parsed.suffix,
        quiet=parsed.quiet,
        env_tmpdir=(opts.env or {}).get("TMPDIR", ""),
        cwd=opts.cwd.virtual,
        exists_fn=exists_fn,
    )
