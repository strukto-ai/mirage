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

from mirage.runtime.handles.mode import parse_mode


def test_parse_mode_reads_the_five_facts():
    read = parse_mode("r")
    assert not read.writable and not read.create
    update = parse_mode("r+b")
    assert update.writable and not update.truncate and not update.create
    write = parse_mode("w")
    assert write.writable and write.truncate and write.create
    append = parse_mode("a")
    assert append.writable and append.append and not append.truncate
    exclusive = parse_mode("x")
    assert exclusive.writable and exclusive.exclusive and exclusive.create
