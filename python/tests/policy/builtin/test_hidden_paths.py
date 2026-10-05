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
from mirage.policy.builtin.hidden_paths import HiddenPathsPolicy
from mirage.policy.types import OpsContext
from mirage.types import HiddenPaths, PathSpec
from mirage.workspace.session import SessionState


def _ctx(virtual: str, create: bool = False) -> OpsContext:
    return OpsContext(
        op="write" if create else "read",
        path=PathSpec.from_str_path(virtual),
        write=create,
        prefix="/w/",
        create=create,
    )


@pytest.mark.asyncio
async def test_a_hidden_path_answers_as_absent():
    sess = SessionState(
        session_id="agent", hidden_paths=HiddenPaths(paths=("/w/vault",))
    )
    token = set_current_session(sess)
    try:
        policy = HiddenPathsPolicy()
        assert await policy.pre_ops(_ctx("/w/open.txt")) is None
        under = await policy.pre_ops(_ctx("/w/vault/k"))
        assert under is not None and under.error is not None
        assert under.error.errno == errno.ENOENT
        named = await policy.pre_ops(_ctx("/w/vault", create=True))
        assert named is not None and named.error is not None
        assert named.error.errno == errno.EACCES
    finally:
        reset_current_session(token)


@pytest.mark.asyncio
async def test_without_a_session_nothing_is_hidden():
    assert await HiddenPathsPolicy().pre_ops(_ctx("/w/vault/k")) is None
