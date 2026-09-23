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

import asyncio
import gzip
import io
import tarfile


def _tgz_bytes() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        folder = tarfile.TarInfo(name="./memory")
        folder.type = tarfile.DIRTYPE
        tf.addfile(folder)
        for name in ("./memory/memory.json", "./other.txt"):
            info = tarfile.TarInfo(name=name)
            data = f"content:{name}\n".encode()
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return gzip.compress(buf.getvalue())


def _seed_archive(env) -> None:
    env.mirage("tee /data/files.tar.gz", stdin=_tgz_bytes())


def test_tar_t_selector_lists_only_the_member(env):
    _seed_archive(env)
    out = env.mirage("tar -tzf /data/files.tar.gz ./memory/memory.json")
    assert out == "./memory/memory.json\n"


def test_tar_t_dir_selector_takes_the_subtree(env):
    _seed_archive(env)
    out = env.mirage("tar -tzf /data/files.tar.gz ./memory")
    assert out == "./memory/\n./memory/memory.json\n"


def test_tar_t_selector_matches_stored_spelling_only(env):
    _seed_archive(env)
    result = asyncio.run(
        env.ws.shell("tar -tzf /data/files.tar.gz memory/memory.json"))
    assert result.exit_code == 2
    stderr = result.stderr.decode()
    assert "tar: memory/memory.json: Not found in archive" in stderr
    assert "Exiting with failure status due to previous errors" in stderr


def test_tar_xO_streams_member_bytes_to_stdout(env):
    _seed_archive(env)
    out = env.mirage("tar -xOzf /data/files.tar.gz ./memory/memory.json")
    assert out == "content:./memory/memory.json\n"
    listing = env.mirage("find /data -name 'memory.json'")
    assert listing.strip() == ""


def test_tar_xvO_lists_names_on_stderr(env):
    _seed_archive(env)
    result = asyncio.run(
        env.ws.shell("tar -xvOzf /data/files.tar.gz ./memory/memory.json"))
    assert result.exit_code == 0
    assert result.stderr.decode() == "./memory/memory.json\n"


def test_tar_x_selector_extracts_only_the_member(env):
    _seed_archive(env)
    env.mirage("mkdir -p /data/out")
    env.mirage("tar -xzf /data/files.tar.gz -C /data/out ./other.txt")
    assert env.mirage("cat /data/out/other.txt") == "content:./other.txt\n"
    assert env.mirage("find /data/out -name 'memory.json'").strip() == ""


def test_tar_x_mixed_hit_and_miss_extracts_and_exits_2(env):
    _seed_archive(env)
    env.mirage("mkdir -p /data/out2")
    result = asyncio.run(
        env.ws.shell(
            "tar -xzf /data/files.tar.gz -C /data/out2 ./other.txt nope"))
    assert result.exit_code == 2
    assert "tar: nope: Not found in archive" in result.stderr.decode()
    assert env.mirage("cat /data/out2/other.txt") == "content:./other.txt\n"


def test_tar_x_extracts_into_cwd_with_dot_components_cleaned(env):
    _seed_archive(env)
    env.mirage("tar -xzf /data/files.tar.gz")
    assert env.mirage(
        "cat /data/memory/memory.json") == "content:./memory/memory.json\n"
    assert "/data/./memory" not in env.mirage("find /data")
