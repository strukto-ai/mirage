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

import pytest


def test_ls_lists_same_files(env):
    env.create_file("a.txt", b"aaa")
    env.create_file("b.txt", b"bbb")
    m_names = set(env.mirage("ls /data/").strip().split("\n"))
    n_names = set(env.native("ls").strip().split("\n"))
    assert m_names == n_names


def test_ls_a_shows_hidden(env):
    env.create_file(".hidden", b"h")
    env.create_file("visible.txt", b"v")
    m_names = set(env.mirage("ls -a /data/").strip().split("\n"))
    assert ".hidden" in m_names
    assert "visible.txt" in m_names


def test_ls_r_reverse(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.txt", b"b")
    env.create_file("c.txt", b"c")
    m_names = env.mirage("ls -r /data/").strip().split("\n")
    n_names = env.native("ls -r").strip().split("\n")
    assert m_names == n_names


def test_ls_l(env):
    env.create_file("f.txt", b"hello")
    result = env.mirage("ls -l /data")
    assert "f.txt" in result


def test_ls_a(env):
    env.create_file("f.txt", b"hello")
    result = env.mirage("ls -a /data")
    assert "f.txt" in result


def test_ls_F(env):
    if env.resource_type == "s3":
        pytest.skip("S3 cannot stat virtual directories")
    env.create_file("sub/a.txt", b"hi")
    result = env.mirage("ls -F /data")
    assert "sub/" in result


def test_ls_A(env):
    env.create_file("f.txt", b"hi")
    result = env.mirage("ls -A /data")
    assert "f.txt" in result


def test_ls_h(env):
    env.create_file("f.txt", b"x" * 1024)
    result = env.mirage("ls -l -h /data")
    assert "K" in result or "f.txt" in result


def test_ls_t(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.txt", b"b")
    result = env.mirage("ls -t /data")
    assert "a.txt" in result and "b.txt" in result


def test_ls_S(env):
    env.create_file("big.txt", b"x" * 100)
    env.create_file("small.txt", b"x")
    result = env.mirage("ls -S /data")
    lines = result.strip().splitlines()
    assert len(lines) >= 2


def test_ls_1(env):
    env.create_file("a.txt", b"a")
    env.create_file("b.txt", b"b")
    result = env.mirage("ls -1 /data")
    assert "\n" in result


def test_ls_1_overrides_l(env):
    env.create_file("a.txt", b"hello")
    env.create_file("b.txt", b"world")
    short = env.mirage("ls -1 /data").strip()
    one_overrides_long = env.mirage("ls -l -1 /data").strip()
    assert one_overrides_long == short


def test_ls_R(env):
    if env.resource_type == "s3":
        pytest.skip("not supported on S3")
    env.create_file("sub/a.txt", b"hi")
    result = env.mirage("ls -R /data")
    assert "sub" in result and "a.txt" in result


def test_ls_d(env):
    if env.resource_type == "s3":
        pytest.skip("not supported on S3")
    result = env.mirage("ls -d /data")
    assert len(result.strip()) > 0
