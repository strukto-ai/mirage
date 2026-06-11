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

import pytest

from mirage.core.disk.utils import resolve_safe


def test_resolve_safe_joins_under_root(tmp_path):
    assert resolve_safe(tmp_path, "/a/b.txt") == tmp_path / "a" / "b.txt"


def test_resolve_safe_strips_leading_slashes(tmp_path):
    assert resolve_safe(tmp_path, "//a.txt") == tmp_path / "a.txt"


def test_resolve_safe_rejects_escape(tmp_path):
    with pytest.raises(ValueError):
        resolve_safe(tmp_path, "/../outside.txt")
