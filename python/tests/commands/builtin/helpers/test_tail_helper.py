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

from mirage.commands.builtin.tail_helper import number_flag_error


class TestNumberFlagError:

    def test_valid_numbers_pass(self):
        assert number_flag_error("head", "5", None) is None
        assert number_flag_error("tail", "+3", None) is None
        assert number_flag_error("head", None, "-2") is None

    def test_invalid_lines(self):
        assert number_flag_error(
            "head", "abc", None) == "head: invalid number of lines: 'abc'\n"

    def test_invalid_bytes(self):
        assert number_flag_error(
            "tail", None, "xyz") == "tail: invalid number of bytes: 'xyz'\n"
