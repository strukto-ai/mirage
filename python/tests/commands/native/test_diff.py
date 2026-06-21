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


def test_diff_identical(env):
    env.create_file("a.txt", b"same\n")
    env.create_file("b.txt", b"same\n")
    assert env.mirage("diff /data/a.txt /data/b.txt") == env.native(
        "diff a.txt b.txt")


def test_diff_different(env):
    if env.resource_type == "redis":
        return
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    m = env.mirage("diff /data/a.txt /data/b.txt")
    n = env.native("diff a.txt b.txt")
    assert ("hello" in m) == ("hello" in n)
    assert ("world" in m) == ("world" in n)


def test_diff_i(env):
    env.create_file("a.txt", b"Hello\n")
    env.create_file("b.txt", b"hello\n")
    assert env.mirage("diff -i /data/a.txt /data/b.txt") == env.native(
        "diff -i a.txt b.txt")


def test_diff_u(env):
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    result = env.mirage("diff -u /data/a.txt /data/b.txt")
    assert "@@" in result
    assert "-hello" in result
    assert "+world" in result


def test_diff_q_differ(env):
    if env.resource_type == "redis":
        return
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    result = env.mirage("diff -q /data/a.txt /data/b.txt")
    assert "differ" in result


def test_diff_q_same(env):
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"hello\n")
    result = env.mirage("diff -q /data/a.txt /data/b.txt")
    assert result.strip() == ""


def test_diff_w(env):
    env.create_file("a.txt", b"hello  world\n")
    env.create_file("b.txt", b"helloworld\n")
    result = env.mirage("diff -w /data/a.txt /data/b.txt")
    assert result.strip() == ""


def test_diff_b(env):
    env.create_file("a.txt", b"hello  world\n")
    env.create_file("b.txt", b"hello world\n")
    result = env.mirage("diff -b /data/a.txt /data/b.txt")
    assert result.strip() == ""


def test_diff_e(env):
    if env.resource_type == "redis":
        return
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    result = env.mirage("diff -e /data/a.txt /data/b.txt")
    assert "c" in result or "d" in result or "a" in result


def test_diff_r(env):
    env.create_file("dir1/a.txt", b"hello\n")
    env.create_file("dir2/a.txt", b"world\n")
    result = env.mirage("diff -r /data/dir1 /data/dir2")
    assert "differ" in result or "hello" in result or "world" in result


def test_diff_r_recurses_subdirs(env):
    env.create_file("d1/top.txt", b"same\n")
    env.create_file("d2/top.txt", b"same\n")
    env.create_file("d1/sub/x.txt", b"alpha\n")
    env.create_file("d2/sub/x.txt", b"beta\n")
    result = env.mirage("diff -r /data/d1 /data/d2")
    assert "alpha" in result and "beta" in result
    assert "/data/d1/sub/x.txt" in result


def test_diff_r_only_in(env):
    env.create_file("o1/shared.txt", b"s\n")
    env.create_file("o2/shared.txt", b"s\n")
    env.create_file("o1/leftonly.txt", b"l\n")
    env.create_file("o2/rightonly.txt", b"r\n")
    result = env.mirage("diff -r /data/o1 /data/o2")
    assert "Only in /data/o1: leftonly.txt" in result
    assert "Only in /data/o2: rightonly.txt" in result


def test_diff_r_on_files(env):
    env.create_file("f1.txt", b"hello\n")
    env.create_file("f2.txt", b"world\n")
    result = env.mirage("diff -r /data/f1.txt /data/f2.txt")
    assert "hello" in result and "world" in result
    assert "Not a directory" not in result


def test_diff_r_identical_tree(env):
    env.create_file("s1/a.txt", b"x\n")
    env.create_file("s1/sub/b.txt", b"y\n")
    env.create_file("s2/a.txt", b"x\n")
    env.create_file("s2/sub/b.txt", b"y\n")
    assert env.mirage("diff -r /data/s1 /data/s2") == ""
