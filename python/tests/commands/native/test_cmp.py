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


def test_cmp_identical(env):
    env.create_file("a.txt", b"same\n")
    env.create_file("b.txt", b"same\n")
    assert env.mirage("cmp /data/a.txt /data/b.txt") == env.native(
        "cmp a.txt b.txt")


def test_cmp_s(env):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    assert env.mirage("cmp -s /data/a.txt /data/b.txt") == ""
    assert env.native("cmp -s a.txt b.txt") == ""


def test_cmp_n(env):
    env.create_file("a.txt", b"hello world")
    env.create_file("b.txt", b"hello earth")
    m = env.mirage("cmp -n 5 /data/a.txt /data/b.txt")
    n = env.native("cmp -n 5 a.txt b.txt")
    assert m == n


def test_cmp_n_differ(env):
    env.create_file("a.txt", b"hello world")
    env.create_file("b.txt", b"hello earth")
    m = env.mirage("cmp -n 10 /data/a.txt /data/b.txt")
    n = env.native("cmp -n 10 a.txt b.txt")
    assert (len(m) > 0) == (len(n) > 0)


def test_cmp_i(env):
    env.create_file("a.txt", b"XXhello")
    env.create_file("b.txt", b"YYhello")
    m = env.mirage("cmp -i 2 /data/a.txt /data/b.txt")
    n = env.native("cmp -i 2 a.txt b.txt")
    assert m == n


def test_cmp_l(env):
    env.create_file("a.txt", b"abc")
    env.create_file("b.txt", b"axc")
    result = env.mirage("cmp -l /data/a.txt /data/b.txt")
    native = env.native("cmp -l a.txt b.txt")
    assert result.split() == native.split()


def test_cmp_b(env):
    env.create_file("a.txt", b"abc")
    env.create_file("b.txt", b"axc")
    result = env.mirage("cmp -b /data/a.txt /data/b.txt")
    assert "differ" in result
