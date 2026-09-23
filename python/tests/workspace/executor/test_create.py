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
"""The one place a shell redirect opens a file for writing.

Both `echo x > f` and `exec > f` route here, so the mode a fresh file
gets is decided once: 0666 masked by the session's umask, and left alone
under the default mask because a fresh file already renders as 644.
"""
import pytest

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.create import create_file
from mirage.workspace.session.session import SessionState


class _Dispatch:

    def __init__(self, exists: bool) -> None:
        self.exists = exists
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, op: str, scope: PathSpec, **kwargs):
        self.calls.append((op, kwargs))
        if op == "stat" and not self.exists:
            raise FileNotFoundError(2, "No such file or directory")
        return None, None

    @property
    def ops(self) -> list[str]:
        return [op for op, _ in self.calls]


@pytest.mark.asyncio
async def test_default_umask_never_probes_or_sets_a_mode():
    dispatch = _Dispatch(exists=False)
    await create_file(dispatch, SessionState("s"), _to_scope("/data/f"), b"x")
    assert dispatch.ops == ["write"]


@pytest.mark.asyncio
async def test_a_created_file_takes_the_masked_mode():
    dispatch = _Dispatch(exists=False)
    session = SessionState("s")
    session.umask = 0o077
    await create_file(dispatch, session, _to_scope("/data/f"), b"x")
    assert dispatch.ops == ["stat", "write", "setattr"]
    assert dispatch.calls[-1][1]["mode"] == 0o600


@pytest.mark.asyncio
async def test_an_existing_file_keeps_its_mode():
    dispatch = _Dispatch(exists=True)
    session = SessionState("s")
    session.umask = 0o077
    await create_file(dispatch, session, _to_scope("/data/f"), b"x")
    assert dispatch.ops == ["stat", "write"]


@pytest.mark.asyncio
async def test_both_redirect_forms_agree_end_to_end():
    """The reason this module exists: the rule used to be private to the
    plain-redirect path, so `exec > f` created a 644 file where
    `echo x > f` created a 600 one."""
    ws = Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("umask 077; echo z > /data/p; "
                        "( exec > /data/e; echo z ); "
                        "stat -c '%a %n' /data/p /data/e")
    assert (await io.stdout_str()) == "600 /data/p\n600 /data/e\n"
    await ws.close()
