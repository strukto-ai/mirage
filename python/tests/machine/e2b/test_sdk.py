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

import sys
from unittest.mock import patch

import pytest

from mirage.machine.e2b import E2BMachine


def test_the_sdk_loads_on_first_use(monkeypatch):
    monkeypatch.setitem(sys.modules, "e2b", None)
    machine = E2BMachine("box", config={"sandbox_id": "id"})
    with pytest.raises(ImportError, match=r"mirage-ai\[e2b\]"):
        _ = machine._sdk


def test_a_broken_dependency_keeps_its_import_error():
    machine = E2BMachine("box", config={"sandbox_id": "id"})
    failure = ModuleNotFoundError(
        "missing SDK dependency", name="upstream_dep"
    )
    with patch("mirage.machine.handle.import_module", side_effect=failure):
        with pytest.raises(ModuleNotFoundError) as caught:
            _ = machine._sdk
    assert caught.value is failure
