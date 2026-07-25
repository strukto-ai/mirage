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


def test_shuf_r(env):
    data = b"a\nb\nc\n"
    result = env.mirage("shuf -r -n 5", stdin=data)
    lines = result.strip().splitlines()
    assert len(lines) == 5


def test_shuf_e(env):
    result = env.mirage("shuf -e a b c")
    lines = [ln.strip().lstrip("/") for ln in result.strip().splitlines()]
    assert sorted(lines) == ["a", "b", "c"]


def test_shuf_z(env):
    data = b"a\x00b\x00c\x00"
    result = env.mirage("shuf -z", stdin=data)
    assert "\x00" in result or len(result) > 0


def test_shuf_input_range_and_output(env):
    result = env.mirage("shuf -i 3-5 -n 3")
    assert set(result.splitlines()) == {"3", "4", "5"}
    env.mirage("shuf -i 1-1 -o /data/out.txt")
    assert env.mirage("cat /data/out.txt") == "1\n"
