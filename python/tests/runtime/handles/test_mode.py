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

from mirage.runtime.handles.mode import parse_mode


def test_parse_mode_reads_the_facts():
    read = parse_mode("r")
    assert not read.writable and not read.create
    assert read.readable and not read.binary
    update = parse_mode("r+b")
    assert update.writable and not update.truncate and not update.create
    assert update.readable and update.binary
    write = parse_mode("w")
    assert write.writable and write.truncate and write.create
    assert not write.readable
    append = parse_mode("a")
    assert append.writable and append.append and not append.truncate
    assert not append.readable
    exclusive = parse_mode("x")
    assert exclusive.writable and exclusive.exclusive and exclusive.create
    assert not exclusive.readable


def test_plus_makes_every_base_readable_and_writable():
    for spelling in ("r+", "w+", "a+", "x+"):
        mode = parse_mode(spelling)
        assert mode.readable, spelling
        assert mode.writable, spelling


def test_wx_is_c_fopen_exclusive_create():
    # CPython spells exclusive creation as a bare 'x'; C fopen (and so
    # qjs-wasi's std.open) spells it 'wx'. One parser serves both
    # dialects, so both spellings answer the same facts.
    mode = parse_mode("wx")
    assert mode.exclusive and mode.create and mode.truncate
    assert mode.writable and not mode.readable


@pytest.mark.parametrize("bad", [
    "",
    "q",
    "rw",
    "rr",
    "r++",
    "rbb",
    "rbt",
    "wq",
    "b",
])
def test_garbage_modes_raise_the_cpython_refusal(bad: str):
    # One parser, the stricter half's rule: exactly one of rwax, at
    # most one each of +, b, t, and never b with t. The message is
    # CPython's own, so a guest and an embedder read the same refusal.
    with pytest.raises(ValueError, match="invalid mode"):
        parse_mode(bad)


def test_text_flag_is_accepted_and_not_binary():
    mode = parse_mode("rt")
    assert not mode.binary
    assert mode.readable
