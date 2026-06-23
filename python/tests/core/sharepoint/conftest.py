import inspect
from types import SimpleNamespace

import aioresponses.core
from aiohttp import ClientResponse

_NEEDS_STREAM_WRITER = "stream_writer" in inspect.signature(
    ClientResponse.__init__).parameters


class _PatchedClientResponse(ClientResponse):

    def __init__(self, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("stream_writer", SimpleNamespace(output_size=0))
        super().__init__(*args, **kwargs)


if _NEEDS_STREAM_WRITER:
    aioresponses.core.ClientResponse = _PatchedClientResponse
