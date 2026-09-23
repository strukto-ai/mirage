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
import zipfile

import pytest

from mirage.types import MountMode
from mirage.vfs import RAMVFS
from mirage.workspace import Workspace


def _tgz_bytes() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name in ("./memory/memory.json", "./other.txt"):
            info = tarfile.TarInfo(name=name)
            data = f"content:{name}\n".encode()
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return gzip.compress(buf.getvalue())


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("memory/memory.json", "zipped\n")
    return buf.getvalue()


@pytest.fixture()
def ws() -> Workspace:
    work = RAMVFS()
    work._store.files["/files.tar.gz"] = _tgz_bytes()
    work._store.files["/files.zip"] = _zip_bytes()
    return Workspace(mounts={
        "/": (RAMVFS(), MountMode.WRITE),
        "/work/": (work, MountMode.WRITE),
    })


def _run(ws: Workspace, line: str):
    return asyncio.run(ws.shell(line))


def test_tar_selector_does_not_join_routing(ws):
    # cwd is /, the archive is on /work: the selector must not count as
    # a path operand or the line refuses as a cross-mount span.
    result = _run(ws, "tar -xOzf /work/files.tar.gz ./memory/memory.json")
    assert result.exit_code == 0
    assert result.stdout == b"content:./memory/memory.json\n"


def test_tar_extract_lands_in_cwd_across_mounts(ws):
    result = _run(ws, "tar -xzf /work/files.tar.gz")
    assert result.exit_code == 0
    out = _run(ws, "cat /memory/memory.json")
    assert out.stdout == b"content:./memory/memory.json\n"


def test_tar_extract_dash_C_into_another_mount(ws):
    result = _run(ws, "tar -xzf /work/files.tar.gz -C /dest")
    assert result.exit_code == 0
    out = _run(ws, "cat /dest/memory/memory.json")
    assert out.stdout == b"content:./memory/memory.json\n"


def _archive(ws: Workspace, path: str) -> bytes:
    return _run(ws, f"cat {path}").stdout


def test_tar_create_writes_the_archive_on_another_mount(ws):
    _run(ws, "mkdir -p /src && echo hi > /src/f.txt")
    result = _run(ws, "cd /src && tar -czf /work/backup.tgz .")
    assert result.exit_code == 0, result.stderr
    with tarfile.open(fileobj=io.BytesIO(_archive(ws, "/work/backup.tgz")),
                      mode="r:gz") as tf:
        assert tf.getnames() == [".", "./f.txt"]
        assert tf.extractfile("./f.txt").read() == b"hi\n"


def test_tar_create_gathers_operands_from_two_mounts(ws):
    _run(ws, "mkdir -p /src && echo hi > /src/f.txt")
    result = _run(ws,
                  "tar -cf /work/both.tar -C /src f.txt -C /work files.zip")
    assert result.exit_code == 0, result.stderr
    with tarfile.open(
            fileobj=io.BytesIO(_archive(ws, "/work/both.tar"))) as tf:
        assert tf.getnames() == ["f.txt", "files.zip"]


def test_zip_dot_lands_on_another_mount_without_dot_slash(ws):
    _run(ws, "mkdir -p /src/_rels && echo x > '/src/[Content_Types].xml'")
    _run(ws, "echo r > /src/_rels/.rels")
    result = _run(ws, "cd /src && zip -qr /work/doc.docx .")
    assert result.exit_code == 0, result.stderr
    with zipfile.ZipFile(io.BytesIO(_archive(ws, "/work/doc.docx"))) as zf:
        assert zf.namelist() == [
            "[Content_Types].xml", "_rels/", "_rels/.rels"
        ]
        assert zf.read("[Content_Types].xml") == b"x\n"


@pytest.fixture()
def nested() -> Workspace:
    ws = Workspace(
        mounts={
            "/data": (RAMVFS(), MountMode.WRITE),
            "/data/d/inner": (RAMVFS(), MountMode.WRITE),
            "/out": (RAMVFS(), MountMode.WRITE),
        })
    _run(
        ws, "mkdir -p /data/d/real && echo r > /data/d/real/r.txt"
        " && echo i > /data/d/inner/i.txt && ln -s real /data/d/lnk")
    return ws


@pytest.mark.parametrize("line", [
    "cd /data/d && zip -r {} .",
    "cd /data/d && zip -ry {} .",
    "cd /data/d && tar -cvf {} .",
    "cd /data/d && tar -chvf {} .",
])
def test_archive_on_another_mount_matches_one_on_the_same_mount(nested, line):
    kind = "zip" if "zip" in line else "tar"
    same = _run(nested, line.format(f"/data/out.{kind}"))
    _run(nested, f"rm /data/out.{kind}")
    cross = _run(nested, line.format(f"/out/out.{kind}"))
    assert (cross.exit_code, cross.stdout,
            cross.stderr) == (same.exit_code, same.stdout, same.stderr)
    assert b"file is on a different filesystem" in cross.stderr
    assert b"i.txt" not in cross.stdout


def test_unzip_extracts_into_cwd(ws):
    _run(ws, "cd /")
    result = _run(ws, "unzip -q /work/files.zip")
    assert result.exit_code == 0
    out = _run(ws, "cat /memory/memory.json")
    assert out.stdout == b"zipped\n"


def test_unzip_dash_d_into_another_mount(ws):
    result = _run(ws, "unzip -q -d /dest /work/files.zip")
    assert result.exit_code == 0
    out = _run(ws, "cat /dest/memory/memory.json")
    assert out.stdout == b"zipped\n"
