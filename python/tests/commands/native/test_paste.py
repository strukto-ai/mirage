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


def test_paste_two_files(env):
    env.create_file("a.txt", b"1\n2\n3\n")
    env.create_file("b.txt", b"a\nb\nc\n")
    assert env.mirage("paste /data/a.txt /data/b.txt") == env.native(
        "paste a.txt b.txt")


def test_paste_d(env):
    env.create_file("a.txt", b"x\ny\n")
    env.create_file("b.txt", b"1\n2\n")
    assert env.mirage("paste -d , /data/a.txt /data/b.txt") == env.native(
        "paste -d , a.txt b.txt")


def test_paste_stdin(env):
    data = b"a\nb\nc\n"
    assert env.mirage("paste -s", stdin=data) == "a\tb\tc\n"


def test_paste_serial_and_delimiter_list(env):
    env.create_file("f.txt", b"a\nb\nc\n")
    assert env.mirage("paste -s -d, /data/f.txt") == "a,b,c\n"
