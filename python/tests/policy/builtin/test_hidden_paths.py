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

import errno

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.policy import Deny, Policy
from mirage.policy.builtin.hidden_paths import HiddenPathsPolicy
from mirage.policy.types import Action, Hide, VfsContext
from mirage.types import HiddenPaths, MountMode, PathSpec, Visibility
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.session import SessionState


def _ctx(virtual: str, create: bool = False) -> VfsContext:
    return VfsContext(
        op="write" if create else "read",
        path=PathSpec.from_str_path(virtual),
        write=create,
        prefix="/w/",
        create=create,
    )


@pytest.mark.asyncio
async def test_a_hidden_path_answers_as_absent():
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(paths=HiddenPaths(paths=("/w/vault",))),
    )
    token = set_current_session(sess)
    try:
        policy = HiddenPathsPolicy()
        assert await policy.pre_vfs(_ctx("/w/open.txt")) is None
        under = await policy.pre_vfs(_ctx("/w/vault/k"))
        assert isinstance(under, Hide)
        assert under.error.errno == errno.ENOENT
        named = await policy.pre_vfs(_ctx("/w/vault", create=True))
        assert isinstance(named, Hide)
        assert named.error.errno == errno.EACCES
    finally:
        reset_current_session(token)


@pytest.mark.asyncio
async def test_without_a_session_nothing_is_hidden():
    assert await HiddenPathsPolicy().pre_vfs(_ctx("/w/vault/k")) is None


class _SealedReads(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if not ctx.write and ctx.path.virtual == "/data/secret":
            return Deny("sealed")
        return None


@pytest.mark.asyncio
async def test_a_hide_answers_before_any_policy_and_leaves_no_record():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[_SealedReads()]
    )
    try:
        await ws.shell("echo s > /data/secret")
        ws.create_session(
            "veiled", profile={"paths": {"hide": ["/data/secret"]}}
        )
        hidden = await ws.shell("cat /data/secret", session_id="veiled")
        assert hidden.exit_code == 1
        assert await hidden.stderr_str() == (
            "cat: /data/secret: No such file or directory\n"
        )
        assert hidden.refusal is None
        denied = await ws.shell("cat /data/secret")
        assert denied.refusal and denied.refusal.reason == "sealed"
    finally:
        await ws.close()
