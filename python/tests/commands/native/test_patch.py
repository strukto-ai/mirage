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


def test_patch_N(env):
    env.create_file("f.txt", b"hello\nworld\n")
    patch_content = (b"--- a/f.txt\n"
                     b"+++ b/f.txt\n"
                     b"@@ -1,2 +1,2 @@\n"
                     b"-hello\n"
                     b"+goodbye\n"
                     b" world\n")
    env.create_file("fix.patch", patch_content)
    env.mirage("patch -N -p1 -i /data/fix.patch")
    result = env.mirage("cat /data/f.txt")
    assert "goodbye" in result


def test_patch_R(env):
    env.create_file("f.txt", b"goodbye\nworld\n")
    patch_content = (b"--- a/f.txt\n"
                     b"+++ b/f.txt\n"
                     b"@@ -1,2 +1,2 @@\n"
                     b"-hello\n"
                     b"+goodbye\n"
                     b" world\n")
    env.create_file("fix.patch", patch_content)
    env.mirage("patch -R -p1 -i /data/fix.patch")
    result = env.mirage("cat /data/f.txt")
    assert "hello" in result
