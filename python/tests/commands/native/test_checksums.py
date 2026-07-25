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

import hashlib

import pytest

CHECKSUMS = [
    ("md5sum", hashlib.md5),
    ("sha1sum", hashlib.sha1),
    ("sha256sum", hashlib.sha256),
    ("sha384sum", hashlib.sha384),
    ("sha512sum", hashlib.sha512),
]


@pytest.mark.parametrize("cmd,factory", CHECKSUMS)
def test_checksum_digest_matches_hashlib(env, cmd, factory):
    payload = b"hello\nworld\n"
    env.create_file("f.txt", payload)
    out = env.mirage(f"{cmd} /data/f.txt")
    expected = factory(payload).hexdigest()
    assert out == f"{expected}  /data/f.txt\n"


@pytest.mark.parametrize("cmd,factory", CHECKSUMS)
def test_checksum_stdin(env, cmd, factory):
    payload = b"piped bytes\n"
    out = env.mirage(cmd, stdin=payload)
    expected = factory(payload).hexdigest()
    assert out == f"{expected}  -\n"


@pytest.mark.parametrize("cmd,factory", CHECKSUMS)
def test_checksum_check_roundtrip(env, cmd, factory):
    env.create_file("f.txt", b"hello\n")
    sums = env.mirage(f"{cmd} /data/f.txt")
    env.create_file("sums.txt", sums.encode())
    result = env.mirage(f"{cmd} -c /data/sums.txt")
    assert result == "/data/f.txt: OK\n"


@pytest.mark.parametrize("cmd,factory", CHECKSUMS)
def test_checksum_multiple_operands(env, cmd, factory):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    out = env.mirage(f"{cmd} /data/a.txt /data/b.txt")
    exp_a = factory(b"aaa\n").hexdigest()
    exp_b = factory(b"bbb\n").hexdigest()
    assert out == f"{exp_a}  /data/a.txt\n{exp_b}  /data/b.txt\n"
