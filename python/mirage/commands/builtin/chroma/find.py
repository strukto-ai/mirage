from dataclasses import replace
from functools import partial

from mirage.commands.builtin.chroma.io import resolve_glob
from mirage.commands.builtin.generic.find import find_generic
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.chroma.find import find as find_core
from mirage.core.chroma.stat import stat as stat_core
from mirage.core.chroma.stat import stat_light
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _is_bare_name(texts: list[str]) -> bool:
    return bool(texts) and not texts[0].startswith("-") and texts[0] not in (
        "(", ")", "!")


def _default_name(name: str | None, texts: list[str]) -> str | None:
    if name is not None:
        return name
    if _is_bare_name(texts):
        return texts[0]
    return None


def _expr_texts(texts: list[str]) -> list[str]:
    if _is_bare_name(texts):
        return []
    return texts


async def _normalize_find_output(
    stdout: ByteSource | None,
    search_path: PathSpec,
) -> ByteSource | None:
    if stdout is None:
        return None
    data = stdout if isinstance(stdout, bytes) else b""
    root = mount_prefix_of(search_path.virtual,
                           search_path.resource_path).rstrip("/") or "/"
    lines = data.decode().splitlines()
    normalized = [root if line == root + "/" else line for line in lines]
    return format_records(normalized)


@command("find", resource="chroma", spec=SPECS["find"])
async def find(
    accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    paths = default_paths(paths, opts.cwd)
    paths = await resolve_glob(accessor, paths, opts.index)
    search_path = paths[0]

    fl = FlagView(opts.flags, spec=SPECS["find"])
    # Push-down choices: a bare word acts as the -name filter, and the
    # heavier per-document stat is only paid when -mtime needs times.
    bag = dict(opts.flags)
    default_name = _default_name(fl.as_str("name"), texts)
    if default_name is not None:
        bag["name"] = default_name
    stat_fn = (partial(stat_core, accessor, index=opts.index)
               if fl.as_str("mtime") is not None else partial(
                   stat_light, accessor, index=opts.index))
    stdout, io = await find_generic(paths,
                                    _expr_texts(texts),
                                    replace(opts, flags=bag),
                                    find_core=partial(find_core,
                                                      accessor,
                                                      index=opts.index),
                                    stat=stat_fn)
    return await _normalize_find_output(stdout, search_path), io
