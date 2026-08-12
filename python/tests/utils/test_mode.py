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

from mirage.utils.mode import parse_chmod


def test_parse_chmod_octal():
    assert parse_chmod("644", 0) == 0o644
    assert parse_chmod("0", 0o777) == 0
    assert parse_chmod("7777", 0) == 0o7777


def test_parse_chmod_octal_out_of_range():
    assert parse_chmod("77777", 0) is None


def test_parse_chmod_symbolic_add():
    assert parse_chmod("u+x", 0o644) == 0o744
    assert parse_chmod("+x", 0o644) == 0o755


def test_parse_chmod_symbolic_remove():
    assert parse_chmod("go-r", 0o644) == 0o600


def test_parse_chmod_symbolic_assign():
    assert parse_chmod("a=r", 0o777) == 0o444
    assert parse_chmod("u=rwx,go=", 0o644) == 0o700


def test_parse_chmod_symbolic_comma_clauses():
    assert parse_chmod("u+x,g-r", 0o644) == 0o704


def test_parse_chmod_invalid():
    assert parse_chmod("zz", 0o644) is None
    assert parse_chmod("u~x", 0o644) is None
    assert parse_chmod("u+q", 0o644) is None
