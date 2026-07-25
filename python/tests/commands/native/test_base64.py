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


def test_base64_encode(env):
    data = b"hello world\n"
    assert env.mirage("base64", stdin=data) == env.native("base64", stdin=data)


def test_base64_decode(env):
    data = b"aGVsbG8gd29ybGQK\n"
    assert env.mirage("base64 -d", stdin=data) == env.native("base64 -d",
                                                             stdin=data)


def test_base64_file(env):
    env.create_file("f.txt", b"hello world\n")
    assert env.mirage("base64 /data/f.txt") == env.native("base64 < f.txt")


def test_base64_w(env):
    data = b"hello world this is a longer string for wrapping"
    result = env.mirage("base64 -w 20", stdin=data)
    lines = result.strip().split("\n")
    assert all(len(line) <= 20 for line in lines[:-1])


def test_base64_D(env):
    data = b"aGVsbG8=\n"
    result = env.mirage("base64 -D", stdin=data)
    assert result == "hello"


def test_base64_wrap_and_ignore_garbage(env):
    assert env.mirage("base64 -w 4", stdin=b"abcdef") == "YWJj\nZGVm\n"
    assert env.mirage("base64 --decode --ignore-garbage",
                      stdin=b"YWJj$\n") == "abc"
