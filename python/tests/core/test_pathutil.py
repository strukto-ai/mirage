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

from mirage.core.pathutil import norm, parent


def test_norm_adds_leading_slash():
    assert norm("a/b.txt") == "/a/b.txt"


def test_norm_strips_trailing_slash():
    assert norm("/a/b/") == "/a/b"


def test_norm_collapses_to_root():
    assert norm("/") == "/"
    assert norm("") == "/"


def test_parent_of_nested_path():
    assert parent("/a/b/c.txt") == "/a/b"


def test_parent_of_top_level_path():
    assert parent("/a.txt") == "/"


def test_parent_of_root():
    assert parent("/") == "/"
