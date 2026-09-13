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

from mirage.io import IOResult
from mirage.workspace.abort import StatusWriter
from mirage.workspace.executor.statement import (assignment_status,
                                                 finish_statement,
                                                 restore_status,
                                                 snapshot_status)
from mirage.workspace.session import Session


@pytest.mark.asyncio
async def test_finish_statement_materializes_and_seeds():
    session = Session(session_id="t")
    session.last_exit_code = 7

    async def gen():
        yield b"ab"
        yield b"c"

    io = IOResult(exit_code=3)
    out = await finish_statement(gen(), io, session)
    assert out == b"abc"
    assert session.last_exit_code == 3


@pytest.mark.asyncio
async def test_finish_statement_none_stdout_still_seeds():
    session = Session(session_id="t")
    io = IOResult(exit_code=1)
    assert await finish_statement(None, io, session) == b""
    assert session.last_exit_code == 1


@pytest.mark.asyncio
async def test_finish_statement_pulls_lazy_exit_code():
    session = Session(session_id="t")
    source = IOResult(exit_code=0)
    merged = await IOResult().merge(source)

    async def gen():
        yield b"out"
        source.exit_code = 4

    out = await finish_statement(gen(), merged, session)
    assert out == b"out"
    assert merged.exit_code == 4
    assert session.last_exit_code == 4


def test_assignment_status_tracks_substitutions():
    session = Session(session_id="t")
    assert assignment_status(session, session._cmdsub_seq) == 0
    seq = session._cmdsub_seq
    session._cmdsub_seq += 1
    session._cmdsub_status = 5
    assert assignment_status(session, seq) == 5
    assert assignment_status(session, session._cmdsub_seq) == 0


def test_restore_status_puts_back_the_captured_shell_status():
    session = Session(session_id="t")
    session.last_exit_code = 3
    session.pipe_status = (0, 3)
    before = snapshot_status(session)
    session.last_exit_code = 0
    session.pipe_status = (0, )
    session._pipe_status_pending = (1, )
    restore_status(session, before, None)
    assert session.last_exit_code == 3
    assert session.pipe_status == (0, 3)
    assert session._pipe_status_pending is None


def test_restore_status_declines_over_a_status_another_line_stamped():
    # Two `execute()` calls can share a session, and a snapshot taken
    # before a concurrent line finished is older than that line's
    # result. Putting it back would resurrect a value the shell moved
    # past.
    session = Session(session_id="t")
    mine = StatusWriter()
    theirs = StatusWriter()
    session.last_exit_code = 1
    before = snapshot_status(session)

    session.last_exit_code = 0
    session.pipe_status = (0, )
    session.status_writer = theirs

    restore_status(session, before, mine)
    assert session.last_exit_code == 0
    assert session.pipe_status == (0, )

    restore_status(session, before, theirs)
    assert session.last_exit_code == 1
