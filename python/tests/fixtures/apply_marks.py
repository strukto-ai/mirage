from collections.abc import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.record import OpRecord
from mirage.types import CacheFacts, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

Mark = tuple[str, str, ByteSource | None]


def caching_ram_workspace() -> Workspace:
    """A writable workspace with a read-caching RAM mount at ``/r``."""
    ram = RAMVFS()
    ram.caches_reads = True
    return Workspace({"/r": ram}, mode=MountMode.WRITE)


def capture_marks(
    ws: Workspace,
) -> list[tuple[list[Mark], dict[str, ByteSource]]]:
    """Snapshot each ``apply_io`` call's records and writes on ``ws``.

    The hook only snapshots: an assertion raised inside apply_io is
    folded into the line's result. The marks are read before the real
    apply_io, since the line clears them once it has run.

    Args:
        ws (Workspace): the workspace whose dispatcher to wrap.

    Returns:
        list[tuple[list[Mark], dict[str, ByteSource]]]: per call, each
        record's ``(op, path, claimed)`` and a copy of ``IOResult.writes``.
    """
    captured: list[tuple[list[Mark], dict[str, ByteSource]]] = []
    orig = ws._dispatcher.apply_io

    async def recording(
        result: IOResult,
        records: list[OpRecord] | None = None,
        cache_facts: Callable[[str], CacheFacts] | None = None,
        nested: bool = False,
    ) -> None:
        marks = [(r.op, r.path, r.claimed) for r in records or []]
        captured.append((marks, dict(result.writes)))
        return await orig(
            result, records=records, cache_facts=cache_facts, nested=nested
        )

    ws._dispatcher.apply_io = recording
    return captured
