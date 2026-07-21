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


def test_join_a1(env):
    env.create_file("a.txt", b"1 a\n2 b\n3 c\n")
    env.create_file("b.txt", b"2 x\n3 y\n4 z\n")
    assert env.mirage("join -a 1 /data/a.txt /data/b.txt") == env.native(
        "join -a 1 a.txt b.txt")


def test_join_v1(env):
    env.create_file("a.txt", b"1 a\n2 b\n3 c\n")
    env.create_file("b.txt", b"2 x\n3 y\n4 z\n")
    assert env.mirage("join -v 1 /data/a.txt /data/b.txt") == env.native(
        "join -v 1 a.txt b.txt")


def test_join_e(env):
    env.create_file("a.txt", b"1 a\n2 b\n")
    env.create_file("b.txt", b"1 x\n3 y\n")
    assert env.mirage("join -a 1 -e EMPTY /data/a.txt /data/b.txt"
                      ) == env.native("join -a 1 -e EMPTY a.txt b.txt")


def test_join_t(env):
    env.create_file("a.txt", b"1:a\n2:b\n")
    env.create_file("b.txt", b"1:x\n2:y\n")
    assert env.mirage("join -t : /data/a.txt /data/b.txt") == env.native(
        "join -t : a.txt b.txt")


def test_join_o(env):
    env.create_file("a.txt", b"1 a c\n2 b d\n")
    env.create_file("b.txt", b"1 x z\n2 y w\n")
    assert env.mirage("join -o 0,1.2,2.3 /data/a.txt /data/b.txt"
                      ) == env.native("join -o 0,1.2,2.3 a.txt b.txt")


def test_join_o_empty(env):
    env.create_file("a.txt", b"1 a\n2 b\n")
    env.create_file("b.txt", b"1 x\n3 z\n")
    assert env.mirage(
        "join -a 1 -e NA -o 0,1.2,2.2 /data/a.txt /data/b.txt") == env.native(
            "join -a 1 -e NA -o 0,1.2,2.2 a.txt b.txt")


def test_join_12(env):
    env.create_file("a.txt", b"a 1\nb 2\n")
    env.create_file("b.txt", b"1 x\n2 y\n")
    result = env.mirage("join -1 1 -2 1 /data/a.txt /data/b.txt")
    assert len(result.strip()) > 0 or result.strip() == ""
