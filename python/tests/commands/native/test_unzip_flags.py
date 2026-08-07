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
import io
import zipfile

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def test_unzip_q(env):
    env.create_file("a.txt", b"hello")
    env.mirage("zip /data/out.zip /data/a.txt")
    result = env.mirage("unzip -q -d /data/ext /data/out.zip")
    assert result.strip() == "" or "inflating" not in result


def test_unzip_t(env):
    env.create_file("a.txt", b"hello")
    env.mirage("zip /data/out.zip /data/a.txt")
    result = env.mirage("unzip -t /data/out.zip")
    assert "OK" in result or "ok" in result.lower() or "No errors" in result


def test_unzip_l(env):
    env.create_file("a.txt", b"hello")
    env.mirage("zip /data/out.zip /data/a.txt")
    result = env.mirage("unzip -l /data/out.zip")
    assert "a.txt" in result


def test_unzip_p(env):
    env.create_file("a.txt", b"hello")
    env.mirage("zip /data/out.zip /data/a.txt")
    result = env.mirage("unzip -p /data/out.zip")
    assert "hello" in result


def test_unzip_o(env):
    env.create_file("a.txt", b"hello")
    env.mirage("zip /data/out.zip /data/a.txt")
    env.mirage("unzip -o /data/out.zip")
    result = env.mirage("ls /data")
    assert "a.txt" in result


def _bytes_of(src) -> bytes:
    if src is None:
        return b""
    if isinstance(src, bytes):
        return src

    async def drain() -> bytes:
        out = b""
        async for chunk in src:
            out += chunk
        return out

    return asyncio.run(drain())


def test_unzip_p_member_selects_only_that_member(env):
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    env.mirage("zip /data/out.zip /data/a.txt /data/b.txt")
    result = env.mirage("unzip -p /data/out.zip data/a.txt")
    assert result == "hello\n"


def test_unzip_p_missing_member_exits_11(env):
    env.create_file("a.txt", b"hello\n")
    env.mirage("zip /data/out.zip /data/a.txt")
    env.ws._cwd = "/data"
    io = asyncio.run(env.ws.execute("unzip -p /data/out.zip NOSUCHFILE.xml"))
    assert io.exit_code == 11
    assert _bytes_of(io.stdout) == b""
    assert _bytes_of(io.stderr).decode() == (
        "caution: filename not matched:  NOSUCHFILE.xml\n")


def test_unzip_extract_member_writes_only_that_member(env):
    env.create_file("a.txt", b"hello\n")
    env.create_file("b.txt", b"world\n")
    env.mirage("zip /data/out.zip /data/a.txt /data/b.txt")
    env.mirage("unzip -q /data/out.zip data/a.txt -d /data/ext")
    listing = env.mirage("ls /data/ext/data")
    assert "a.txt" in listing
    assert "b.txt" not in listing


def test_unzip_p_member_is_not_resolved_as_a_path():
    ws = Workspace(
        {
            "/": (RAMResource(), MountMode.WRITE),
            "/work": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("xl/workbook.xml", b"WORKBOOK-CONTENT\n")
        zf.writestr("docProps/app.xml", b"APPXML-CONTENT\n")
    asyncio.run(ws.execute("tee /work/book.zip", stdin=buf.getvalue()))
    ws._cwd = "/"
    result = asyncio.run(ws.execute("unzip -p /work/book.zip xl/workbook.xml"))
    assert result.exit_code == 0
    assert _bytes_of(result.stdout) == b"WORKBOOK-CONTENT\n"
    result = asyncio.run(ws.execute("unzip -p /work/book.zip NOSUCHFILE.xml"))
    assert result.exit_code == 11
    assert _bytes_of(result.stdout) == b""
