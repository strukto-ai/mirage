class PipeClosed(Exception):
    """The reader or writer of a byte pipe has closed."""


class MemoryExhausted(Exception):
    """An object a line holds grew past the line's ``max_memory``."""

    def __init__(self) -> None:
        super().__init__("memory exhausted")
