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

from mirage.errors import FsCondition
from mirage.errors.wasi import WASI, wasi_errno
from mirage.runtime.constants import HARD_LINK_REFUSAL
from mirage.runtime.wasm.errors import LINK_REFUSAL


def test_link_refusal_is_the_shared_decision_in_preview1_numbers():
    # The surface renders the refusal, the shared constant decides it:
    # pinning the translation rather than the number is what keeps a
    # change to that decision from silently leaving preview1 behind.
    assert LINK_REFUSAL == wasi_errno(HARD_LINK_REFUSAL)
    assert LINK_REFUSAL == WASI[FsCondition.EPERM]
