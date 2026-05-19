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


def test_find_iname(env):
    env.create_file("Hello.txt", b"hi")
    result = env.mirage("find /data -iname hello.txt")
    assert "Hello.txt" in result


def test_find_mindepth(env):
    env.create_file("a.txt", b"a")
    env.create_file("sub/b.txt", b"b")
    result_all = env.mirage("find /data -type f")
    result_md1 = env.mirage("find /data -mindepth 1 -type f")
    result_md2 = env.mirage("find /data -mindepth 2 -type f")
    assert "a.txt" in result_all
    assert "a.txt" in result_md1
    assert "b.txt" in result_md1
    assert "a.txt" not in result_md2
    assert "b.txt" in result_md2


def test_find_path(env):
    env.create_file("sub/hello.txt", b"hi")
    env.create_file("other/hello.txt", b"hi")
    result = env.mirage("find /data -path '*/sub/*'")
    assert "sub" in result
    assert "other" not in result


def test_find_name(env):
    env.create_file("hello.txt", b"hi")
    env.create_file("world.txt", b"hi")
    result = env.mirage("find /data -name hello.txt")
    assert "hello.txt" in result
    assert "world.txt" not in result


def test_find_maxdepth(env):
    env.create_file("a.txt", b"hi")
    env.create_file("sub/deep/c.txt", b"hi")
    result = env.mirage("find /data -maxdepth 1 -type f")
    assert "a.txt" in result
    assert "c.txt" not in result


def test_find_size(env):
    env.create_file("big.txt", b"x" * 1000)
    env.create_file("small.txt", b"x")
    result = env.mirage("find /data -size +500c -type f")
    assert "big.txt" in result
    assert "small.txt" not in result


def test_find_mtime(env):
    if env.resource_type == "redis":
        return
    env.create_file("f.txt", b"hello")
    result = env.mirage("find /data -mtime -1 -type f")
    assert "f.txt" in result
