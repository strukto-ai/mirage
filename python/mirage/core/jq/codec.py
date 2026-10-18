# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import AsyncIterator, Mapping

from mirage.io.cooperative import chunks
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import OpenStream, open_stream
from mirage.types import JsonValue


async def run_codec(
    kind: str, config: Mapping[str, JsonValue], data: bytes
) -> AsyncIterator[bytes]:
    """Run a jq codec with bounded calls and cooperative drains.

    Args:
        kind (str): the Rust codec.
        config (Mapping[str, JsonValue]): resolved codec options.
        data (bytes): original input or compact evaluator output.
    """
    stream = open_stream(kind, config)
    budget = YieldBudget()
    try:
        async for piece in chunks(data):
            output = stream.feed(piece)
            if output:
                yield output
            while stream.busy():
                await budget.run()
                output = stream.drain()
                if output:
                    yield output
        output = stream.finish()
        if output:
            yield output
        while stream.busy():
            await budget.run()
            output = stream.drain()
            if output:
                yield output
    finally:
        await close_codec(stream)


async def close_codec(stream: OpenStream) -> None:
    """Discard buffered jq data with cooperative, bounded cleanup.

    Args:
        stream (OpenStream): an owned jq codec.
    """
    stream.begin({"discard": True})
    budget = YieldBudget()
    while stream.busy():
        await budget.run()
        stream.drain()
