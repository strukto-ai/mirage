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
import inspect

from mirage.context import get_current_session
from mirage.nfs.delegate import MirageNFS
from mirage.nfs.session import BOUND_METHODS, SessionBoundNFS, scoped
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def build() -> tuple[Workspace, MirageNFS]:
    """A seeded workspace and an adapter over its ops."""
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("tee /a.txt", stdin=b"hello"))
    return ws, MirageNFS(ws.ops)


def test_the_declared_attributes_are_exactly_the_bound_ones():
    # The annotations exist so a caller has a type to read; if they
    # drift from the list that installs the bodies, one of the two is
    # a lie.
    declared = {
        name
        for name in SessionBoundNFS.__annotations__ if not name.startswith("_")
    }
    assert declared == set(BOUND_METHODS)


def test_every_op_entry_point_is_bound():
    # The list is the whole guarantee: an adapter method the wrapper
    # does not name is one the kernel can reach with the workspace's
    # full grants instead of the session's. Adding a trait method means
    # adding it here, and this fails until it is.
    public = {
        name
        for name, member in inspect.getmembers(
            MirageNFS, inspect.iscoroutinefunction) if not name.startswith("_")
    }
    assert public == set(BOUND_METHODS)


class RecordingOps:
    """Ops proxy that records the session in force at each call."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self.seen: list[object] = []

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str):
        self.seen.append(get_current_session())
        return await self._inner.stat(path)


def test_the_session_reaches_the_op_that_enforces_it():
    # Not "the wrapper sets a contextvar" -- that a call arriving from
    # the kernel lands on the ops facade with the session in force, which
    # is what makes the grants apply.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("tee /a.txt", stdin=b"hello"))
    ops = RecordingOps(ws.ops)
    session = ws.create_session("scoped")
    bound = SessionBoundNFS(MirageNFS(ops), session)

    asyncio.run(bound.lookup(bound.root_dir(), "a.txt"))
    assert ops.seen == [session]


def test_an_unscoped_adapter_reaches_the_op_with_no_session():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    asyncio.run(ws.execute("tee /a.txt", stdin=b"hello"))
    ops = RecordingOps(ws.ops)
    fs = MirageNFS(ops)
    asyncio.run(fs.lookup(fs.root_dir(), "a.txt"))
    assert ops.seen == [None]


def test_the_context_is_reset_after_the_call():
    ws, fs = build()
    session = ws.create_session("scoped")
    bound = SessionBoundNFS(fs, session)
    asyncio.run(bound.getattr(fs.root_dir()))
    assert get_current_session() is None


def test_a_failing_call_still_resets_the_context():
    ws, fs = build()
    session = ws.create_session("scoped")
    bound = SessionBoundNFS(fs, session)
    try:
        asyncio.run(bound.getattr(9999))
    except Exception:
        pass
    assert get_current_session() is None


def test_root_dir_is_forwarded_without_a_session():
    # It reads no op, so binding it would buy nothing and cost a
    # coroutine on a call the server makes before it serves anything.
    ws, fs = build()
    bound = SessionBoundNFS(fs, ws.create_session("scoped"))
    assert bound.root_dir() == fs.root_dir()


def test_scoped_returns_the_adapter_itself_when_unscoped():
    _, fs = build()
    assert scoped(fs, None) is fs


def test_scoped_wraps_when_a_session_is_given():
    ws, fs = build()
    assert isinstance(scoped(fs, ws.create_session("scoped")), SessionBoundNFS)
