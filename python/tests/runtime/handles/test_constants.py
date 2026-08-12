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

from mirage.runtime.handles.constants import MODE_BASES, MODE_CHARS


def test_every_base_spelling_draws_from_the_mode_alphabet():
    for base in MODE_BASES:
        assert base <= MODE_CHARS


def test_the_bases_are_cpythons_four_plus_c_fopens_wx():
    assert set(MODE_BASES) == {
        frozenset("r"),
        frozenset("w"),
        frozenset("a"),
        frozenset("x"),
        frozenset("wx"),
    }
