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


def test_sort_default(env):
    env.create_file("f.txt", b"cherry\napple\nbanana\n")
    assert env.mirage("sort /data/f.txt") == env.native("sort f.txt")


def test_sort_r(env):
    env.create_file("f.txt", b"a\nb\nc\n")
    assert env.mirage("sort -r /data/f.txt") == env.native("sort -r f.txt")


def test_sort_n(env):
    env.create_file("f.txt", b"10\n2\n1\n20\n")
    assert env.mirage("sort -n /data/f.txt") == env.native("sort -n f.txt")


def test_sort_u(env):
    env.create_file("f.txt", b"a\nb\na\nc\nb\n")
    assert env.mirage("sort -u /data/f.txt") == env.native("sort -u f.txt")


def test_sort_nr(env):
    env.create_file("f.txt", b"10\n2\n1\n20\n")
    assert env.mirage("sort -nr /data/f.txt") == env.native("sort -nr f.txt")


def test_sort_k_t(env):
    env.create_file("f.txt", b"b,3\na,1\nc,2\n")
    assert env.mirage("sort -t , -k 2 -n /data/f.txt") == env.native(
        "sort -t , -k 2 -n f.txt")


def test_sort_stdin(env):
    data = b"cherry\napple\nbanana\n"
    assert env.mirage("sort", stdin=data) == env.native("sort", stdin=data)


def test_sort_h(env):
    env.create_file("f.txt", b"10K\n1M\n5G\n100\n2K\n")
    assert env.mirage("sort -h /data/f.txt") == env.native("sort -h f.txt")


def test_sort_hr(env):
    env.create_file("f.txt", b"10K\n1M\n5G\n100\n2K\n")
    assert env.mirage("sort -hr /data/f.txt") == env.native("sort -hr f.txt")


def test_sort_h_stdin(env):
    data = b"1G\n500M\n2T\n100K\n"
    assert env.mirage("sort -h", stdin=data) == env.native("sort -h",
                                                           stdin=data)


def test_sort_V(env):
    env.create_file("f.txt", b"v1.10\nv1.2\nv1.1\nv2.0\n")
    assert env.mirage("sort -V /data/f.txt") == env.native("sort -V f.txt")


def test_sort_Vr(env):
    env.create_file("f.txt", b"v1.10\nv1.2\nv1.1\nv2.0\n")
    assert env.mirage("sort -Vr /data/f.txt") == env.native("sort -Vr f.txt")


def test_sort_V_stdin(env):
    data = b"lib-2.1\nlib-1.10\nlib-1.2\nlib-3.0\n"
    assert env.mirage("sort -V", stdin=data) == env.native("sort -V",
                                                           stdin=data)


def test_sort_s(env):
    env.create_file("f.txt", b"b 2\na 1\nc 1\na 2\n")
    assert env.mirage("sort -s -k 2 -t ' ' /data/f.txt") == env.native(
        "sort -s -k 2 -t ' ' f.txt")


def test_sort_s_stdin(env):
    data = b"b 2\na 1\nc 1\na 2\n"
    assert env.mirage("sort -s -k 2 -t ' '",
                      stdin=data) == env.native("sort -s -k 2 -t ' '",
                                                stdin=data)


def test_sort_f(env):
    env.create_file("f.txt", b"B\na\nC\nb\n")
    result = env.mirage("sort -f /data/f.txt")
    assert "a" in result and "B" in result


# KEYDEF grammar cases pinned to GNU coreutils 9.7 output (BSD sort on
# macOS diverges on these, so they use hardcoded expectations rather than
# env.native).
def test_sort_multi_key_with_per_key_modifiers(env):
    env.create_file("f.txt", b"a 2 z\nb 2 a\nc 1 m\n")
    assert env.mirage("sort -k2,2n -k1,1r /data/f.txt") == \
        "c 1 m\nb 2 a\na 2 z\n"


def test_sort_combined_global_reverse_and_key(env):
    env.create_file("f.txt", b"z 2\nm 2\na 2\n")
    assert env.mirage("sort -rk2,2n /data/f.txt") == "z 2\nm 2\na 2\n"


def test_sort_field_to_eol_differs_from_range(env):
    env.create_file("f.txt", b"a 2 z\nb 2 a\nc 1 m\n")
    assert env.mirage("sort -k2 /data/f.txt") == "c 1 m\nb 2 a\na 2 z\n"
    assert env.mirage("sort -k2,2 /data/f.txt") == "c 1 m\na 2 z\nb 2 a\n"


def test_sort_char_offset_with_sep(env):
    env.create_file("f.txt", b"apple:12\nbee:3\ncat:100\n")
    assert env.mirage("sort -t: -k1.2,1.3 /data/f.txt") == \
        "cat:100\nbee:3\napple:12\n"


def test_sort_stable_keeps_input_order_on_ties(env):
    env.create_file("f.txt", b"z 2\nm 2\na 2\n")
    assert env.mirage("sort -s -k2,2n /data/f.txt") == "z 2\nm 2\na 2\n"
