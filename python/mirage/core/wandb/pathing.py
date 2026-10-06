from mirage.accessor.wandb import WandbAccessor
from mirage.core.wandb.types import RunVariables
from mirage.errors.fs import enoent
from mirage.types import PathSpec

LEAVES = ("run.json", "config.json", "summary.json", "history.jsonl")


def parts(accessor: WandbAccessor, path: PathSpec) -> list[str]:
    key = path.mount_path.strip("/")
    result = key.split("/") if key else []
    if any(not safe_name(p) for p in result) or (
        result and result[0] not in accessor.config.entities
    ):
        raise enoent(path)
    return result


def safe_name(name: str) -> bool:
    return (
        bool(name)
        and name not in (".", "..")
        and not any(c in name for c in ("/", "\\", "\x00"))
    )


def run_vars(segments: list[str]) -> RunVariables:
    entity, project, run = segments[:3]
    return {"entity": entity, "project": project, "run": run}
