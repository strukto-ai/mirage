import json
from collections.abc import AsyncIterator

from mirage.accessor.wandb import WandbAccessor
from mirage.core.hierarchy.probe import parent_spec, rows_of
from mirage.core.render.json import json_bytes, jsonl_bytes
from mirage.core.wandb.metadata import run_metadata
from mirage.core.wandb.pathing import LEAVES, parts, run_vars
from mirage.core.wandb.queries import RUN, RUN_CONFIG, RUN_SUMMARY
from mirage.core.wandb.readdir import readdir
from mirage.errors.fs import eisdir, enoent
from mirage.io.types import materialize
from mirage.types import FileType, PathSpec


async def _is_directory(
    accessor: WandbAccessor, path: PathSpec, name: str
) -> bool:
    listed = rows_of(await readdir(accessor, parent_spec(path)))
    return any(
        row.name == name and row.type == FileType.DIRECTORY for row in listed
    )


async def read_stream(
    accessor: WandbAccessor, path: PathSpec
) -> AsyncIterator[bytes]:
    ps = parts(accessor, path)
    if len(ps) > 4 and ps[3] == "files":
        file = await accessor.client.file(run_vars(ps), "/".join(ps[4:]))
        if file is not None:
            async for chunk in accessor.client.download(
                file.get("directUrl") or file["url"]
            ):
                yield chunk
            return
    if len(ps) != 4 or ps[3] not in LEAVES:
        if not ps or await _is_directory(accessor, path, ps[-1]):
            raise eisdir(path)
        raise enoent(path)
    variables = run_vars(ps)
    if ps[3] == "history.jsonl":
        async for row in accessor.client.history(variables):
            yield jsonl_bytes([row])
        return
    query = {
        "run.json": RUN,
        "config.json": RUN_CONFIG,
        "summary.json": RUN_SUMMARY,
    }[ps[3]]
    run = await accessor.client.run(variables, query)
    if ps[3] == "run.json":
        yield json_bytes(run_metadata(run, variables))
    elif ps[3] == "config.json":
        raw = run.get("config") or "{}"
        config = json.loads(raw) if isinstance(raw, str) else raw
        yield json_bytes({k: v["value"] for k, v in config.items()})
    else:
        raw = run.get("summaryMetrics") or "{}"
        yield json_bytes(json.loads(raw) if isinstance(raw, str) else raw)


async def read(accessor: WandbAccessor, path: PathSpec) -> bytes:
    return await materialize(read_stream(accessor, path))
