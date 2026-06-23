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
import logging
import os
import sys
import uuid

import boto3
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource

S3_BUCKET = "mirage-integ-cross"
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")

_fail = 0


def check(label: str, cond: bool) -> None:
    global _fail
    if cond:
        print(f"OK   {label}")
    else:
        print(f"FAIL {label}")
        _fail += 1


async def run(ws: Workspace, cmd: str) -> tuple[str, str, int]:
    io = await ws.execute(cmd)
    return await io.stdout_str(), await io.stderr_str(), io.exit_code


async def seed_tree(ws: Workspace, base: str) -> None:
    await run(ws, f"mkdir -p {base}/dir/sub")
    await run(ws, f"mkdir -p {base}/dir/empty")
    await run(ws, f"printf 'aaa\\n' > {base}/dir/a.txt")
    await run(ws, f"printf 'bbb\\n' > {base}/dir/sub/b.txt")


async def check_recursive(ws: Workspace, dst: str, label: str,
                          expect_dirs: bool) -> None:
    # cp -r the whole tree across mounts and verify the files (and, for
    # backends with real directories, the empty subdirectory) landed.
    await run(ws, f"cp -r /ram/dir {dst}/copied")
    out, _, _ = await run(ws, f"cat {dst}/copied/a.txt")
    check(f"{label}: cp -r a.txt", out == "aaa\n")
    out, _, _ = await run(ws, f"cat {dst}/copied/sub/b.txt")
    check(f"{label}: cp -r sub/b.txt", out == "bbb\n")
    if expect_dirs:
        out, _, _ = await run(ws, f"ls {dst}/copied")
        check(f"{label}: cp -r preserves empty dir", "empty" in out)


async def check_no_clobber(ws: Workspace, dst: str, label: str) -> None:
    # cp -rn into an existing mapped tree: an existing file is kept, a new
    # file is still copied (GNU per-file no-clobber).
    await run(ws, f"mkdir -p {dst}/nc/dir")
    await run(ws, f"printf 'keep\\n' > {dst}/nc/dir/a.txt")
    await run(ws, f"cp -rn /ram/dir {dst}/nc")
    out, _, _ = await run(ws, f"cat {dst}/nc/dir/a.txt")
    check(f"{label}: cp -rn keeps existing file", out == "keep\n")
    out, _, _ = await run(ws, f"cat {dst}/nc/dir/sub/b.txt")
    check(f"{label}: cp -rn copies new file", out == "bbb\n")


async def check_omit_directory(ws: Workspace, dst: str, label: str) -> None:
    # cp without -r on a directory is an error (GNU), not a silent copy.
    _, err, code = await run(ws, f"cp /ram/dir {dst}/nope")
    check(f"{label}: cp dir without -r fails", code == 1
          and "omitting directory" in err)


async def check_read_family(ws: Workspace, dst: str, label: str) -> None:
    # Multi-file reads whose operands span two mounts must aggregate exactly
    # like the single-mount commands (GNU): cat concatenates, head/tail emit
    # ==> path <== banners, wc prints a total, grep prefixes each match.
    src = "/ram/dir/a.txt"
    other = f"{dst}/copied/sub/b.txt"
    copied = f"{dst}/copied/a.txt"
    out, _, _ = await run(ws, f"cat {src} {other}")
    check(f"{label}: cat aggregates", out == "aaa\nbbb\n")
    out, _, _ = await run(ws, f"head -n 1 {src} {copied}")
    check(f"{label}: head banners", f"==> {src} <==" in out
          and f"==> {copied} <==" in out)
    out, _, _ = await run(ws, f"tail -n 1 {src} {other}")
    check(f"{label}: tail banners", f"==> {src} <==" in out and "bbb" in out)
    out, _, _ = await run(ws, f"wc -l {src} {copied}")
    check(f"{label}: wc total", "total" in out)
    out, _, _ = await run(ws, f"grep aaa {src} {copied}")
    check(f"{label}: grep prefixes", f"{src}:aaa" in out
          and f"{copied}:aaa" in out)


async def check_move(ws: Workspace, dst: str, label: str) -> None:
    # mv a directory across mounts: destination gets the tree, source is gone.
    await run(ws, "mkdir -p /ram/movedir/sub")
    await run(ws, "printf 'm\\n' > /ram/movedir/sub/c.txt")
    await run(ws, f"mv /ram/movedir {dst}/moved")
    out, _, _ = await run(ws, f"cat {dst}/moved/sub/c.txt")
    check(f"{label}: mv tree to dest", out == "m\n")
    _, _, code = await run(ws, "cat /ram/movedir/sub/c.txt")
    check(f"{label}: mv removes source", code != 0)


async def exercise(ws: Workspace, dst: str, label: str,
                   expect_dirs: bool) -> None:
    print(f"===== ram -> {label} =====")
    await check_recursive(ws, dst, label, expect_dirs)
    await check_read_family(ws, dst, label)
    await check_no_clobber(ws, dst, label)
    await check_omit_directory(ws, dst, label)
    await check_move(ws, dst, label)


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    boto3.client("s3", endpoint_url=endpoint,
                 **CREDS).create_bucket(Bucket=S3_BUCKET)

    mounts = {"/ram": RAMResource(), "/ram2": RAMResource()}
    mounts["/s3"] = S3Resource(
        S3Config(bucket=S3_BUCKET,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        prefix = f"mirage-integ-cross-{uuid.uuid4().hex[:8]}/"
        mounts["/redis"] = RedisResource(url=redis_url, key_prefix=prefix)

    ws = Workspace(mounts, mode=MountMode.WRITE)
    try:
        await seed_tree(ws, "/ram")
        await exercise(ws, "/ram2", "ram", expect_dirs=True)
        if redis_url:
            await exercise(ws, "/redis", "redis", expect_dirs=True)
        else:
            print("SKIP redis (REDIS_URL unset)")
        await exercise(ws, "/s3", "s3", expect_dirs=False)
    finally:
        server.stop()

    if _fail:
        print(f"\ncross cp -r FAILED ({_fail} checks)")
        sys.exit(1)
    print("\ncross cp -r OK")


if __name__ == "__main__":
    asyncio.run(main())
