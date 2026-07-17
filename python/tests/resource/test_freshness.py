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

from mirage.resource.base import BaseResource
from mirage.resource.ram import RAMResource


def test_base_resource_does_not_claim_snapshot_support():
    assert BaseResource.SUPPORTS_SNAPSHOT is False


def test_memory_resource_does_not_claim_snapshot_support():
    assert RAMResource.SUPPORTS_SNAPSHOT is False
