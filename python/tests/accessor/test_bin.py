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

from mirage.accessor.bin import BinAccessor


def test_accessor_holds_the_lookups_it_was_given():
    accessor = BinAccessor(
        lambda: ["ls"],
        lambda n: "ls is built into mirage." if n == "ls" else None,
        "2026-11-18T10:00:00Z",
    )
    assert accessor.programs() == ["ls"]
    assert accessor.note("ls") == "ls is built into mirage."
    assert accessor.note("cd") is None
    assert accessor.made == "2026-11-18T10:00:00Z"
