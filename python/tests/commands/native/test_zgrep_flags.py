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

import gzip as gz


def test_zgrep_w(env):
    env.create_file("f.txt", b"hello\nhelloworld\nhello there\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -w hello /data/f.txt.gz")
    assert "helloworld" not in result
    assert "hello" in result


def test_zgrep_i(env):
    env.create_file("f.txt", b"Hello\nworld\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -i hello /data/f.txt.gz")
    assert "Hello" in result


def test_zgrep_c(env):
    env.create_file("f.txt", b"hello\nworld\nhello\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -c hello /data/f.txt.gz")
    assert "2" in result


def test_zgrep_v(env):
    env.create_file("f.txt", b"hello\nworld\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -v hello /data/f.txt.gz")
    assert "world" in result
    assert "hello" not in result


def test_zgrep_n(env):
    env.create_file("f.txt", b"hello\nworld\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -n hello /data/f.txt.gz")
    assert "1:" in result or "1\t" in result


def test_zgrep_l(env):
    env.create_file("f.txt", b"hello\nworld\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -l hello /data/f.txt.gz")
    assert "f.txt" in result


def test_zgrep_e(env):
    compressed = gz.compress(b"hello\nworld\n")
    result = env.mirage("zgrep -e hello", stdin=compressed)
    assert "hello" in result


def test_zgrep_E(env):
    env.create_file("f.txt", b"foo\nbar\nbaz\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -E 'foo|bar' /data/f.txt.gz")
    assert "foo" in result and "bar" in result


def test_zgrep_F(env):
    env.create_file("f.txt", b"a.b\na*b\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -F 'a.b' /data/f.txt.gz")
    assert "a.b" in result


def test_zgrep_o(env):
    env.create_file("f.txt", b"hello world\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -o hello /data/f.txt.gz")
    assert result.strip() == "hello"


def test_zgrep_m(env):
    env.create_file("f.txt", b"a\na\na\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -m 1 a /data/f.txt.gz")
    assert result.strip().count("a") == 1


def test_zgrep_q(env):
    env.create_file("f.txt", b"hello\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -q hello /data/f.txt.gz")
    assert result.strip() == ""


def test_zgrep_H(env):
    env.create_file("f.txt", b"hello\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -H hello /data/f.txt.gz")
    assert "f.txt" in result


def test_zgrep_h(env):
    env.create_file("f.txt", b"hello\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -h hello /data/f.txt.gz")
    assert "hello" in result


def test_zgrep_reads_a_basic_expression(env):
    """zgrep is grep over decompressed bytes, so + is an ordinary character."""
    env.create_file("f.txt", b"aab\na+b\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep 'a+b' /data/f.txt.gz")
    assert "a+b" in result
    assert "aab" not in result


def test_zgrep_E_reads_an_extended_expression(env):
    env.create_file("f.txt", b"aab\na+b\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -E 'a+b' /data/f.txt.gz")
    assert "aab" in result


def test_zgrep_G_asks_for_the_default_dialect(env):
    env.create_file("f.txt", b"aab\na+b\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage("zgrep -G 'a+b' /data/f.txt.gz")
    assert "a+b" in result
    assert "aab" not in result


def test_zgrep_bre_backslash_plus_is_the_operator(env):
    env.create_file("f.txt", b"aab\na+b\n")
    env.mirage("gzip /data/f.txt")
    result = env.mirage(r"zgrep 'a\+b' /data/f.txt.gz")
    assert "aab" in result
