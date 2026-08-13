import posixpath
from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.wrap import to_pathspec
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, StatFn
from mirage.utils.key_prefix import mount_prefix_of


async def _exists(stat_fn: StatFn, path: PathSpec) -> bool:
    try:
        await stat_fn(path)
        return True
    except (FileNotFoundError, ValueError):
        return False


async def realpath(
    paths: list[PathSpec],
    *,
    stat_fn: StatFn,
    e: bool = False,
    m: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    lines: list[str] = []
    for p in paths:
        resolved_display = posixpath.normpath(p.virtual)
        if e:
            prefix = mount_prefix_of(p.virtual, p.resource_path)
            resolved = to_pathspec(resolved_display, prefix)
            if not await _exists(stat_fn, resolved):
                # Fully GNU-formatted (quoted path), emitted verbatim by
                # format_fs_error. Must NOT be a FileNotFoundError: the fs
                # branch would re-prefix and re-suffix it (doubling the
                # message); a plain error matches the TS realpath throw.
                raise ValueError(
                    f"realpath: '{p.virtual}': No such file or directory")
        lines.append(resolved_display)
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["realpath"]


@dataclass(frozen=True, slots=True)
class RealpathFlags:
    must_exist: bool = False
    allow_missing: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> RealpathFlags:
    fl = FlagView(flags, spec=SPECS["realpath"])
    return RealpathFlags(must_exist=fl.as_bool("e"),
                         allow_missing=fl.as_bool("m"))


async def realpath_generic(paths, texts, opts: CommandOpts, stat_fn):
    parsed = parse_flags(opts.flags)
    return await realpath(paths,
                          stat_fn=stat_fn,
                          e=parsed.must_exist,
                          m=parsed.allow_missing)
