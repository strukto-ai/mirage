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
from collections.abc import Iterator

import boto3
import pytest
from moto.server import ThreadedMotoServer

from mirage.types import MountMode
from mirage.vfs.s3.s3 import S3VFS, S3Config
from mirage.workspace import Workspace

CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")


@pytest.fixture()
def s3_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


def _s3_workspace(endpoint: str, bucket: str) -> Workspace:
    boto3.client("s3", endpoint_url=endpoint,
                 **CREDS).create_bucket(Bucket=bucket)
    s3 = S3VFS(
        S3Config(bucket=bucket,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    return Workspace({"/data": s3}, mode=MountMode.WRITE)


async def _exec(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    result = await ws.shell(cmd)
    out = await result.stdout_str()
    err = await result.stderr_str()
    return result.exit_code, out, err


async def _gzip_roundtrip_interleaved_ls(
        ws: Workspace) -> tuple[int, str, str]:
    cmd = ("echo two | tee /data/arch/h.txt > /dev/null"
           " && gzip /data/arch/h.txt"
           " && ls /data/arch"
           " && gunzip /data/arch/h.txt.gz"
           " && cat /data/arch/h.txt")
    return await _exec(ws, cmd)


def test_gzip_roundtrip_with_interleaved_ls(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-gzip-ls")
    code, out, err = asyncio.run(_gzip_roundtrip_interleaved_ls(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "two" in out


async def _overwrite_then_ls(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "echo one | tee /data/arch/a.txt > /dev/null"
        " && ls /data/arch")
    assert setup[0] == 0, setup
    code, out, err = await _exec(
        ws, "echo two | tee /data/arch/b.txt > /dev/null && ls /data/arch")
    return code, out, err


def test_ls_sees_file_created_after_listing(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-ls-create")
    code, out, err = asyncio.run(_overwrite_then_ls(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "b.txt" in out


async def _rm_then_stat(ws: Workspace) -> tuple[int, str, str]:
    # mkdir writes the "arch/" marker object, so the directory outlives its
    # last file. A directory that was only ever implicit has no marker and
    # is gone once its keys are, which is what the test below pins.
    setup = await _exec(
        ws, "mkdir -p /data/arch"
        " && echo gone | tee /data/arch/c.txt > /dev/null"
        " && echo stays | tee /data/arch/d.txt > /dev/null"
        " && ls /data/arch")
    assert setup[0] == 0, setup
    rm = await _exec(ws, "rm /data/arch/c.txt")
    assert rm[0] == 0, rm
    return await _exec(ws, "ls /data/arch")


def test_ls_does_not_show_removed_file(s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-rm-stat")
    code, out, err = asyncio.run(_rm_then_stat(ws))
    assert code == 0, f"exit {code}, stderr: {err!r}"
    assert "c.txt" not in out
    assert "d.txt" in out


async def _rm_last_key_then_ls(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "echo gone | tee /data/imp/e.txt > /dev/null && ls /data/imp")
    assert setup[0] == 0, setup
    rm = await _exec(ws, "rm /data/imp/e.txt")
    assert rm[0] == 0, rm
    return await _exec(ws, "ls /data/imp")


def test_ls_reports_enoent_for_an_emptied_implicit_directory(s3_endpoint):
    # "/data/imp" was never mkdir'd, so the bucket holds no marker for it
    # and removing its last key removes the directory too. stat has always
    # said ENOENT here; ls used to render an empty directory and exit 0.
    ws = _s3_workspace(s3_endpoint, "bucket-rm-implicit")
    code, out, err = asyncio.run(_rm_last_key_then_ls(ws))
    assert code == 2, f"exit {code}, stdout: {out!r}"
    assert err == ("ls: cannot access '/data/imp': "
                   "No such file or directory\n")


async def _rm_r_then_read_nested(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "mkdir -p /data/a/b"
        " && echo hi | tee /data/a/b/f.txt > /dev/null"
        " && ls /data/a/b")
    assert setup[0] == 0, setup
    rm = await _exec(ws, "rm -r /data/a")
    assert rm[0] == 0, rm
    return await _exec(ws, "cat /data/a/b/f.txt")


def test_cat_does_not_serve_a_file_from_a_removed_subtree(s3_endpoint):
    # `rm -r` removes directories the operand never named. The first ls
    # cached a listing for "/data/a/b" and the read cached its body, and
    # invalidating the operand plus its parent reaches neither: cat kept
    # printing "hi" for a key the bucket no longer had, without issuing a
    # single request.
    ws = _s3_workspace(s3_endpoint, "bucket-rm-r-subtree")
    code, out, err = asyncio.run(_rm_r_then_read_nested(ws))
    assert code == 1, f"exit {code}, stdout: {out!r}"
    assert out == ""
    assert err == "cat: /data/a/b/f.txt: No such file or directory\n"


async def _rm_r_then_ls_nested(ws: Workspace) -> tuple[int, str, str]:
    setup = await _exec(
        ws, "mkdir -p /data/x/y"
        " && echo hi | tee /data/x/y/f.txt > /dev/null"
        " && ls /data/x/y")
    assert setup[0] == 0, setup
    rm = await _exec(ws, "rm -r /data/x")
    assert rm[0] == 0, rm
    return await _exec(ws, "ls /data/x/y")


def test_ls_reports_enoent_for_a_directory_inside_a_removed_subtree(
        s3_endpoint):
    ws = _s3_workspace(s3_endpoint, "bucket-rm-r-listing")
    code, out, err = asyncio.run(_rm_r_then_ls_nested(ws))
    assert code == 2, f"exit {code}, stdout: {out!r}"
    assert err == ("ls: cannot access '/data/x/y': "
                   "No such file or directory\n")
