from collections.abc import Callable, Iterator, Mapping, MutableMapping
from weakref import finalize

from mirage.shell.parse.program import retain_programs
from mirage.shell.types import FunctionBody


def _release_entries(entries: dict[str, Callable[[], None]]) -> None:
    for release in entries.values():
        release()
    entries.clear()


class FunctionTable(MutableMapping[str, FunctionBody]):
    """A session's independent leases on stored function programs."""

    def __init__(
        self, initial: Mapping[str, FunctionBody] | None = None
    ) -> None:
        self._entries: dict[str, FunctionBody] = {}
        self._leases: dict[str, Callable[[], None]] = {}
        self._finalizer = finalize(self, _release_entries, self._leases)
        self.update(initial or {})

    def __setitem__(self, name: str, body: FunctionBody) -> None:
        release = retain_programs(body if isinstance(body, list) else [])
        previous = self._leases.pop(name, None)
        if previous is not None:
            previous()
        self._leases[name] = release
        self._entries[name] = body

    def __delitem__(self, name: str) -> None:
        del self._entries[name]
        release = self._leases.pop(name)
        release()

    def __getitem__(self, name: str) -> FunctionBody:
        return self._entries[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._entries)

    def __len__(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()
        _release_entries(self._leases)

    def copy(self) -> "FunctionTable":
        return FunctionTable(self)
