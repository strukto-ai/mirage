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


def test_ln_v(env):
    env.create_file("a.txt", b"hello")
    result = env.mirage("ln -s -v /data/a.txt /data/link.txt")
    assert "->" in result


def test_ln_sf(env):
    env.create_file("a.txt", b"hello")
    env.create_file("b.txt", b"world")
    env.mirage("ln -s /data/a.txt /data/link.txt")
    env.mirage("ln -s -f /data/b.txt /data/link.txt")
    result = env.mirage("readlink /data/link.txt")
    assert "/data/b.txt" in result


def test_ln_n(env):
    env.create_file("a.txt", b"hello")
    result = env.mirage(
        "ln -s -n /data/a.txt /data/link.txt && readlink /data/link.txt")
    assert "/data/a.txt" in result
