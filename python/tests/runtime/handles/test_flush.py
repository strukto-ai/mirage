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

from mirage.runtime.handles.flush import plan_flush


def test_plan_flush_sends_a_tail_when_the_handle_only_extended():
    assert plan_flush(3, 3, b"abcXYZ") == ("append", b"XYZ")


def test_plan_flush_sends_the_whole_file_when_history_was_rewritten():
    assert plan_flush(3, 0, b"ZZZdef") == ("write", b"ZZZdef")


def test_plan_flush_sends_the_whole_file_for_a_new_one():
    # base_len 0 means create or truncate: there is nothing to extend,
    # and the mount may not have the file at all yet.
    assert plan_flush(0, 0, b"fresh") == ("write", b"fresh")


def test_plan_flush_sends_the_whole_file_when_the_buffer_shrank():
    assert plan_flush(6, 6, b"abc") == ("write", b"abc")
