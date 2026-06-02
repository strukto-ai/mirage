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

import asyncio
import time

import pytest

from mirage.commands.builtin.utils.safeguard import (CommandTimeoutError,
                                                     run_with_timeout,
                                                     with_timeout)
from mirage.io.types import materialize


class _Probe:

    def __init__(self) -> None:
        self.closed = False


async def _clean_producer(probe: _Probe):
    try:
        await asyncio.sleep(5)
        yield b"x"
    finally:
        probe.closed = True


async def _leaky_producer(probe: _Probe):
    try:
        await asyncio.sleep(5)
        yield b"x"
    except asyncio.CancelledError:
        await asyncio.sleep(0.4)
        probe.closed = True
        raise


async def _clean_coro(probe: _Probe):
    try:
        await asyncio.sleep(5)
    finally:
        probe.closed = True


@pytest.mark.asyncio
async def test_with_timeout_releases_resource_on_cancel():
    probe = _Probe()
    with pytest.raises(CommandTimeoutError):
        await materialize(with_timeout(_clean_producer(probe), 0.05, "cat"))
    assert probe.closed


@pytest.mark.asyncio
async def test_with_timeout_fires_promptly_for_clean_producer():
    start = time.monotonic()
    with pytest.raises(CommandTimeoutError):
        await materialize(with_timeout(_clean_producer(_Probe()), 0.05, "cat"))
    assert time.monotonic() - start < 0.3


@pytest.mark.asyncio
async def test_with_timeout_unwind_is_handler_controlled():
    start = time.monotonic()
    probe = _Probe()
    with pytest.raises(CommandTimeoutError):
        await materialize(with_timeout(_leaky_producer(probe), 0.05, "cat"))
    elapsed = time.monotonic() - start
    assert probe.closed
    assert elapsed >= 0.4


@pytest.mark.asyncio
async def test_run_with_timeout_releases_resource_on_cancel():
    probe = _Probe()
    with pytest.raises(CommandTimeoutError):
        await run_with_timeout(_clean_coro(probe), 0.05, "stat")
    assert probe.closed
