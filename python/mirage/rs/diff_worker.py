import json
from collections.abc import Mapping

from mirage.rs.stream import OpenStream, open_stream
from mirage.types import JsonValue

_STREAM: OpenStream | None = None


def open_pair(config: Mapping[str, JsonValue]) -> None:
    global _STREAM
    if _STREAM is not None:
        raise RuntimeError("previous diff pair is still open")
    _STREAM = open_stream("diff", config)


def feed(index: int, chunk: bytes) -> bytes:
    assert _STREAM is not None
    return _STREAM.feed_input(index, chunk)


def end(index: int) -> bytes:
    assert _STREAM is not None
    return _STREAM.end_input(index)


def drain() -> tuple[bytes, bool]:
    assert _STREAM is not None
    return _STREAM.drain(), _STREAM.busy()


def inspect_pair() -> tuple[str, int, bytes]:
    assert _STREAM is not None
    return (
        json.loads(_STREAM.metadata())["outcome"],
        _STREAM.status(),
        _STREAM.take_stderr(),
    )


def drop_pair() -> None:
    global _STREAM
    _STREAM = None
