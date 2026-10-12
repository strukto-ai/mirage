from abc import ABC, abstractmethod

from mirage.core.dev.pipe import DevicePipe


class PipeFiles(ABC):
    """Opt-in capability for a byte table with virtual pipe endpoints."""

    @abstractmethod
    def pipe_of(self, key: str) -> DevicePipe | None: ...
