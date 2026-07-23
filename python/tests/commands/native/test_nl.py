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


def test_nl_default(env):
    data = b"hello\nworld\n"
    assert env.mirage("nl", stdin=data) == env.native("nl", stdin=data)


def test_nl_ba(env):
    data = b"hello\n\nworld\n"
    assert env.mirage("nl -b a", stdin=data) == env.native("nl -b a",
                                                           stdin=data)


def test_nl_file(env):
    env.create_file("f.txt", b"aaa\nbbb\n")
    assert env.mirage("nl /data/f.txt") == env.native("nl f.txt")


def test_nl_v(env):
    data = b"a\nb\nc\n"
    result = env.mirage("nl -v 10", stdin=data)
    assert "10" in result


def test_nl_i(env):
    data = b"a\nb\nc\n"
    result = env.mirage("nl -i 2", stdin=data)
    assert "1" in result and "3" in result


def test_nl_w(env):
    data = b"a\nb\n"
    result = env.mirage("nl -w 6", stdin=data)
    assert "     1" in result or "1" in result


def test_nl_s(env):
    data = b"a\nb\n"
    result = env.mirage("nl -s '>> '", stdin=data)
    assert ">>" in result


def test_nl_logical_page_sections(env):
    # GNU writes an empty line in place of each delimiter line.
    data = b"\\:\\:\\:\nhead\n\\:\\:\nbody\n\\:\nfoot\n"
    result = env.mirage("nl -h a -b a -f a -w 1 -s :", stdin=data)
    assert result == "\n1:head\n\n1:body\n\n1:foot\n"
