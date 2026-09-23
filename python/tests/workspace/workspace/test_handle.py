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

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Session, Workspace
from mirage.workspace.session import RAMSessionStore

PROFILES = {"reviewer": {"paths": {"hide": ["/repo/secrets"]}}}


def _seeded() -> Workspace:
    ws = Workspace({"/repo/": RAMVFS()},
                   mode=MountMode.WRITE,
                   profiles=PROFILES)
    return ws


async def _seed(ws: Workspace) -> None:
    await ws.shell("mkdir -p /repo/secrets && echo hello > /repo/README.md"
                   " && echo PRIVATE > /repo/secrets/key.pem")


@pytest.mark.asyncio
async def test_a_handle_binds_both_doors_to_one_session():
    # One object per agent: the shell door and the op door answer
    # under the same profile, so a hide the shell honors is a hide the
    # file tool honors too.
    ws = _seeded()
    try:
        await _seed(ws)
        reviewer = await ws.session("reviewer", profile="reviewer")
        assert isinstance(reviewer, Session)
        assert reviewer.session_id == "reviewer"
        assert reviewer.state is ws.get_session("reviewer")
        shown = await reviewer.shell("cat /repo/README.md")
        assert shown.stdout == b"hello\n"
        hidden = await reviewer.shell("cat /repo/secrets/key.pem")
        assert hidden.exit_code == 1
        assert await reviewer.vfs.read("/repo/README.md") == b"hello\n"
        with pytest.raises(FileNotFoundError):
            await reviewer.vfs.read("/repo/secrets/key.pem")
        assert await ws.vfs.read("/repo/secrets/key.pem") == b"PRIVATE\n"
        assert reviewer.vfs.records is ws.vfs.records
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_handle_adopts_an_existing_session_and_refuses_a_profile():
    ws = _seeded()
    try:
        first = await ws.session("reviewer", profile="reviewer")
        again = await ws.session("reviewer")
        assert again.state is first.state
        with pytest.raises(ValueError, match="exists"):
            await ws.session("reviewer", profile="reviewer")
        with pytest.raises(ValueError, match="exists"):
            await ws.session("reviewer", mounts={"/repo": "read"})
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_handle_adopts_a_persisted_session_before_creating_one():
    # A session store hydrates on first use, so a handle asked for
    # before any async door has run used to see an empty session
    # table, recreate a persisted session bare, and hand the next
    # flush a record that overwrote the stored profile. The door
    # hydrates first, so the stored session is adopted as is.
    store = RAMSessionStore()
    first = Workspace({"/repo/": RAMVFS()},
                      mode=MountMode.WRITE,
                      profiles=PROFILES,
                      session_store=store)
    second = Workspace({"/repo/": RAMVFS()},
                       mode=MountMode.WRITE,
                       profiles=PROFILES,
                       session_store=store)
    try:
        created = await first.session("reviewer", profile="reviewer")
        assert created.state.hidden_paths is not None
        await first.flush_sessions()
        adopted = await second.session("reviewer")
        assert adopted.state.hidden_paths is not None
        with pytest.raises(ValueError, match="exists"):
            await second.session("reviewer", profile="reviewer")
    finally:
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_a_handle_forwards_per_call_options():
    ws = _seeded()
    try:
        await _seed(ws)
        reviewer = await ws.session("reviewer", profile="reviewer")
        forked = await reviewer.shell("pwd", cwd="/repo")
        assert forked.stdout == b"/repo\n"
        assert reviewer.state.cwd != "/repo"
        plan = await reviewer.shell("cat /repo/README.md", provision=True)
        assert plan is not None
        token = set_current_session(ws.get_session(ws.default_session_id))
        try:
            # A session already bound is kept by the op door, so a
            # handle reached from inside the default session's own
            # command reads as that session, never wider.
            assert await reviewer.vfs.read("/repo/secrets/key.pem"
                                           ) == b"PRIVATE\n"
        finally:
            reset_current_session(token)
    finally:
        await ws.close()
