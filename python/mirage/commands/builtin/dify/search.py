from mirage.commands.builtin.dify.io import resolve_glob
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.dify import search as search_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def is_mount_root(path: PathSpec) -> bool:
    root = mount_prefix_of(path.virtual, path.resource_path).rstrip("/") or "/"
    value = path.virtual.rstrip("/") or "/"
    return value == "/" or value == root


@command("search", resource="dify", spec=SPECS["search"])
async def search(
    accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["search"])
    if not texts:
        raise ValueError("search: query is required")
    query = texts[0]
    target_paths = default_paths(paths, opts.cwd)
    mount_prefix = mount_prefix_of(
        target_paths[0].virtual,
        target_paths[0].resource_path) if target_paths else ""
    if any(is_mount_root(path) for path in target_paths):
        resolved_paths: list[PathSpec] = []
    else:
        resolved_paths = await resolve_glob(accessor, target_paths, opts.index)
    top_k = fl.as_int("top_k")
    output = await search_core.search_segments(
        accessor,
        query,
        resolved_paths,
        opts.index,
        method=fl.as_str("method") or "semantic",
        top_k=top_k if top_k is not None else 10,
        threshold=fl.as_float("threshold") or 0.0,
        mount_prefix=mount_prefix)
    return output, IOResult()
