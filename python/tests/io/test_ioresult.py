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

from mirage.io.types import IOResult
from mirage.types import Refusal


def test_default_exit_code():
    io = IOResult()
    assert io.exit_code == 0


def test_merge_combines_stderr():

    async def _run():
        a = IOResult(stderr=b"err1")
        b = IOResult(stderr=b"err2")
        merged = await a.merge(b)
        assert merged.stderr == b"err1err2"

    asyncio.run(_run())


def test_merge_combines_cache():

    async def _run():
        a = IOResult(cache=["/a"])
        b = IOResult(cache=["/b"])
        merged = await a.merge(b)
        assert merged.cache == ["/a", "/b"]

    asyncio.run(_run())


def test_merged_read_follows_a_late_settling_origin():
    """The read is fresh however late the origin settles, with no sync.

    This is grep's shape: merge happens while the stream is still lazy,
    and exit_on_empty writes the origin only when the stream drains.
    The early read before the settle is deliberate: the old
    sync_exit_code() assigned through the setter, which severed the
    link, so one too-early sync froze the provisional 0 forever.
    """

    async def _run():
        origin = IOResult(exit_code=0)
        merged = await IOResult().merge(origin)
        assert merged.exit_code == 0
        origin.exit_code = 1
        assert merged.exit_code == 1

    asyncio.run(_run())


def test_explicit_exit_code_wins_and_detaches_issue_43():

    async def _run():
        inner = IOResult(exit_code=1)
        outer = await IOResult().merge(inner)
        assert outer._stream_source is inner
        outer.exit_code = 0
        assert outer._stream_source is None
        inner.exit_code = 2
        assert outer.exit_code == 0

    asyncio.run(_run())


def test_explicit_exit_code_survives_chain_with_failing_leaf_issue_43():

    async def _run():
        a = IOResult(exit_code=0)
        b = IOResult(exit_code=1)
        c = IOResult(exit_code=1)
        merged = await IOResult().merge(a)
        merged = await merged.merge(b)
        merged = await merged.merge(c)
        merged.exit_code = 0
        assert merged.exit_code == 0

    asyncio.run(_run())


def test_chain_of_merges_stays_fresh_end_to_end():

    async def _run():
        origin = IOResult()
        step = await IOResult().merge(origin)
        top = await IOResult().merge(step)
        origin.exit_code = 3
        assert top.exit_code == 3

    asyncio.run(_run())


def test_merge_keeps_the_latest_refusal():

    async def _run():
        refused = Refusal(kind="deny", reason="no deletes", policy="Rule")
        merged = await IOResult(refusal=refused).merge(IOResult())
        assert merged.refusal == refused
        later = Refusal(kind="pending", reason="sign-off", ask_id="a1")
        merged = await IOResult(refusal=refused).merge(IOResult(refusal=later))
        assert merged.refusal == later
        assert (await IOResult().merge(IOResult())).refusal is None

    asyncio.run(_run())
