import json
from typing import NamedTuple

from mirage.rs.stream import OpenStream


class Progress(NamedTuple):
    consumed: int
    retained: int


def progress(stream: OpenStream) -> Progress:
    """Read a selector's consumed input and retained bytes.

    Args:
        stream (OpenStream): The shared selector.
    """
    value = json.loads(stream.metadata())
    return Progress(value["consumed"], value["retained"])
