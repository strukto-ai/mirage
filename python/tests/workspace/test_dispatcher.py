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

from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.policy import (Action, Deny, GuardSpec, OpsContext, Policies,
                           Policy, PolicyDenied)
from mirage.types import ConsistencyPolicy, PathSpec
from mirage.workspace.dispatcher import Dispatcher


class DenyLocked(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.path.virtual.startswith("/data/locked/"):
            return Deny("locked\n")
        return None


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path="",
                    raw_path=virtual,
                    resolved=True)


def _dispatcher(policies: Policies) -> tuple[Dispatcher, MagicMock]:
    namespace = MagicMock()
    namespace.follow = MagicMock(side_effect=lambda p: p)
    mount = MagicMock()
    mount.prefix = "/data/"
    mount.resource.caches_reads = True
    mount.execute_op = AsyncMock(return_value=b"cold")
    namespace.mount_for = MagicMock(return_value=mount)
    namespace.registry.policies = policies
    cache = MagicMock()
    cache.get = AsyncMock(return_value=b"warm")
    dispatcher = Dispatcher(namespace, cache, ConsistencyPolicy.LAZY)
    reconciler = MagicMock()
    reconciler.may_serve_cached = AsyncMock(return_value=True)
    dispatcher._reconciler = reconciler
    return dispatcher, cache


@pytest.mark.asyncio
async def test_warm_cache_read_cannot_bypass_pre_ops():
    # The #241 failure class: a cached read served without consulting
    # the policy would make the cache a policy bypass. The hook fires
    # before the cache lookup, so the warm path refuses identically.
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    with pytest.raises(PolicyDenied):
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    cache.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_warm_cache_read_serves_when_no_policy_objects():
    policies = Policies()
    policies.add(DenyLocked())
    dispatcher, cache = _dispatcher(policies)
    result, _ = await dispatcher.dispatch("read", _path("/data/open/a.txt"))
    assert result == b"warm"
    cache.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_spec_op_twin_holds_on_the_dispatch_door():
    policies = Policies()
    policies.add(GuardSpec(reason="frozen", paths=("/data/locked/*", )))
    dispatcher, _ = _dispatcher(policies)
    with pytest.raises(PolicyDenied) as excinfo:
        await dispatcher.dispatch("read", _path("/data/locked/a.txt"))
    assert "frozen" in str(excinfo.value)
