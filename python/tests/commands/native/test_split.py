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


def test_split_d(env):
    env.create_file("f.txt", b"a\nb\nc\nd\n")
    env.mirage("split -d -l 2 /data/f.txt /data/part")
    result = env.mirage("cat /data/part00")
    assert "a" in result


def test_split_b(env):
    env.create_file("f.txt", b"hello world this is a test\n")
    env.mirage("split -b 10 /data/f.txt /data/chunk")
    result = env.mirage("cat /data/chunkaa")
    assert len(result) > 0


def test_split_a(env):
    env.create_file("f.txt", b"a\nb\nc\nd\n")
    env.mirage("split -d -a 3 -l 2 /data/f.txt /data/p")
    result = env.mirage("ls /data")
    assert "p000" in result


def test_split_n(env):
    env.create_file("f.txt", b"abcdefghij")
    env.mirage("split -n 2 /data/f.txt /data/chunk")
    r1 = env.mirage("cat /data/chunkaa")
    r2 = env.mirage("cat /data/chunkab")
    assert len(r1) > 0 and len(r2) > 0


def test_split_separator_and_additional_suffix(env):
    env.create_file("f.txt", b"a,b,c,d,")
    env.mirage("split -t, -l 2 --additional-suffix=.part /data/f.txt /data/p")
    assert env.mirage("cat /data/paa.part") == "a,b,"
    assert env.mirage("cat /data/pab.part") == "c,d,"
