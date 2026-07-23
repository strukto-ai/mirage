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


def test_sha256sum_c(env):
    env.create_file("f.txt", b"hello\n")
    checksums = env.mirage("sha256sum /data/f.txt")
    env.create_file("sums.txt", checksums.encode())
    result = env.mirage("sha256sum -c /data/sums.txt")
    assert "OK" in result


def test_sha256sum_tag_and_zero(env):
    assert env.mirage("sha256sum --tag",
                      stdin=b"abc").startswith("SHA256 (-) = ")
    assert env.mirage("sha256sum -b -z", stdin=b"abc").endswith(" *-\0")
