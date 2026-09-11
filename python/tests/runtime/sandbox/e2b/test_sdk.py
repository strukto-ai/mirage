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

import importlib
import sys

from mirage.runtime.sandbox.e2b import sdk

NAMES = ("AsyncSandbox", "CommandExitException")


def test_the_extra_resolves_as_a_unit():
    """Every name comes from the SDK, or every name is None; never a mix."""
    present = [getattr(sdk, name) is not None for name in NAMES]
    assert all(present) or not any(present)


def test_an_absent_extra_reads_as_none():
    """CI installs every extra, so this is the only run of the except arm."""
    saved = sys.modules.get("e2b")
    sys.modules["e2b"] = None
    try:
        module = importlib.reload(sdk)
        assert all(getattr(module, name) is None for name in NAMES)
    finally:
        if saved is None:
            sys.modules.pop("e2b", None)
        else:
            sys.modules["e2b"] = saved
        importlib.reload(sdk)
