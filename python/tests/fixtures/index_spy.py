from datetime import datetime

from mirage.cache.index import Evicted, RAMIndexCacheStore
from mirage.types import FileStat


class WindowSpy(RAMIndexCacheStore):
    """A RAM index that records how each complete listing was written.

    A lister marks a capped fetch as a window; the index is where that
    mark lands, so a test reads it here rather than trusting the lister's
    return value.
    """

    def __init__(self) -> None:
        super().__init__(ttl=600)
        self.windows: dict[str, bool] = {}

    async def set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, FileStat]],
        expired_at: datetime | None = None,
        *,
        window: bool = False,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        self.windows[vfs_path] = window
        return await super().set_dir(
            vfs_path,
            entries,
            expired_at,
            window=window,
            excluded=excluded,
            version=version,
        )
