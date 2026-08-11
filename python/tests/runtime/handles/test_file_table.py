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

from mirage.runtime.handles.file_table import FileTable


def test_table_hands_out_dense_ids_from_first_id():
    table: FileTable[str] = FileTable(first_id=4)
    assert table.add("a") == 4
    assert table.add("b") == 5
    assert table.get(4) == "a"
    assert 5 in table and 9 not in table


def test_table_set_and_pop_move_entries_without_burning_ids():
    table: FileTable[str] = FileTable()
    fd = table.add("a")
    table.set(0, "seeded")
    assert table.pop(fd) == "a"
    assert table.pop(fd) is None
    assert table.get(0) == "seeded"
    assert list(table.values()) == ["seeded"]
