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

from mirage.workspace.store import RAMWorkspaceStateStore
from mirage.workspace.workspace.build import resolve_control_stores


def test_no_provider_builds_an_owned_ram_store():
    stores = resolve_control_stores("ws1", None, False, None, None, None)
    assert isinstance(stores.state_store, RAMWorkspaceStateStore)
    assert stores.owned is True
    assert stores.observe is not None
    assert stores.namespace is not None
    assert stores.sessions is not None


def test_passed_provider_is_shared_not_owned():
    provider = RAMWorkspaceStateStore()
    stores = resolve_control_stores("ws1", provider, False, None, None, None)
    assert stores.state_store is provider
    assert stores.owned is False


def test_owns_store_claims_a_passed_provider():
    provider = RAMWorkspaceStateStore()
    stores = resolve_control_stores("ws1", provider, True, None, None, None)
    assert stores.owned is True


def test_plane_overrides_win_over_the_provider():
    provider = RAMWorkspaceStateStore()
    observe = provider.observer("other")
    stores = resolve_control_stores("ws1", provider, False, observe, None,
                                    None)
    assert stores.observe is observe
