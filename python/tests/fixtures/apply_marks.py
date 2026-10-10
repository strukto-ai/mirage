from collections.abc import Callable

from mirage.observe.record import OpRecord
from mirage.types import CacheFacts, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

Mark = tuple[str, str]


def caching_ram_workspace() -> Workspace:
    """A writable workspace with a read-caching RAM mount at ``/r``."""
    ram = RAMVFS()
    ram.caches_reads = True
    return Workspace({"/r": ram}, mode=MountMode.WRITE)


def capture_marks(ws: Workspace) -> list[tuple[list[Mark], bool]]:
    """Snapshot the records each line's end keeps versions against.

    Args:
        ws (Workspace): the workspace whose dispatcher to wrap.

    Returns:
        list[tuple[list[Mark], bool]]: per line end, each record's
        ``(op, path)`` and whether the line was nested.
    """
    captured: list[tuple[list[Mark], bool]] = []
    orig = ws._dispatcher.keep_versions

    async def recording(
        records: list[OpRecord],
        cache_facts: Callable[[str], CacheFacts],
        nested: bool = False,
    ) -> None:
        captured.append(([(r.op, r.path) for r in records], nested))
        await orig(records, cache_facts, nested)

    ws._dispatcher.keep_versions = recording  # type: ignore[method-assign]
    return captured
