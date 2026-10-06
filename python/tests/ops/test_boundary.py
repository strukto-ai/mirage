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

from mirage.errors.types import ReadOnlyError
from mirage.ops.boundary import OpBoundary
from mirage.policy import Deny, Limit, Policies, Policy, PolicyDenied
from mirage.policy.types import OpsContext, OpsResultContext
from mirage.types import MountMode, PathSpec


class _Sealed(Policy):
    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if ctx.path.virtual.startswith("/d/sec"):
            return Deny("sealed")
        return None


class _Capped(Policy):
    async def post_ops(self, ctx: OpsResultContext) -> Limit:
        return Limit(max_bytes=3)


def _path(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_admit_raises_a_coded_deny_as_eacces():
    boundary = OpBoundary(Policies([_Sealed()]), "/d/", MountMode.WRITE)
    await boundary.admit("read", _path("/d/pub"), False)
    with pytest.raises(PolicyDenied) as refused:
        await boundary.admit("read", _path("/d/sec/k"), False)
    assert refused.value.errno == errno.EACCES
    assert refused.value.filename == "/d/sec/k"


@pytest.mark.asyncio
async def test_admit_holds_the_mount_mode():
    boundary = OpBoundary(Policies(), "/ro/", MountMode.READ)
    await boundary.admit("read", _path("/ro/f"), False)
    with pytest.raises(ReadOnlyError):
        await boundary.admit("write", _path("/ro/f"), True)


@pytest.mark.asyncio
async def test_complete_applies_the_post_ops_limit():
    capped = OpBoundary(Policies([_Capped()]), "/d/")
    assert await capped.complete("read", _path("/d/f"), False, b"abcdef") == (
        b"abc"
    )
    bare = OpBoundary(Policies(), "/d/")
    assert await bare.complete("read", _path("/d/f"), False, b"abcdef") == (
        b"abcdef"
    )
