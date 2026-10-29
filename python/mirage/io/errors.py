class PipeClosed(Exception):
    """The reader or writer of a byte pipe has closed."""


class MemoryExhausted(Exception):
    """An object a command builds does not fit in its workspace's
    ``max_memory``."""

    def __init__(self) -> None:
        super().__init__("memory exhausted")
