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

from mirage.utils.generated.rg_types import DEFAULT_TYPES


def test_holds_ripgreps_defaults():
    assert DEFAULT_TYPES["py"] == ("*.py", "*.pyi")
    assert DEFAULT_TYPES["rust"] == ("*.rs",)
    assert "Makefile" not in DEFAULT_TYPES["make"]
    assert "[Mm]akefile" in DEFAULT_TYPES["make"]


def test_every_type_is_one_rg_can_select():
    assert "all" not in DEFAULT_TYPES
    assert list(DEFAULT_TYPES) == sorted(DEFAULT_TYPES)
    for name, globs in DEFAULT_TYPES.items():
        assert name.isalnum()
        assert globs and list(globs) == sorted(set(globs))
