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
    out, _, _ = await run(ws, f"rg aaa {src} {copied}")
    check(f"{label}: rg prefixes", f"{src}:aaa" in out
          and f"{copied}:aaa" in out)
    # A non-numeric -n is rejected by the shared head/tail generic, exit 1.
    _, err, code = await run(ws, f"head -n abc {src} {copied}")
    check(f"{label}: head invalid -n", code == 1 and "abc" in err)
    _, err, code = await run(ws, f"tail -n abc {src} {copied}")
    check(f"{label}: tail invalid -n", code == 1 and "abc" in err)


async def check_compare(ws: Workspace, dst: str, label: str) -> None:
    # diff/cmp two files that live on different mounts: identical operands
    # exit 0 with no output, differing operands exit 1 and report the change.
    same = f"{dst}/copied/a.txt"
    other = f"{dst}/copied/sub/b.txt"
    src = "/ram/dir/a.txt"
    out, _, code = await run(ws, f"diff {src} {same}")
    check(f"{label}: diff identical", code == 0 and out == "")
    out, _, code = await run(ws, f"diff {src} {other}")
    check(f"{label}: diff differing", code == 1 and "aaa" in out
          and "bbb" in out)
    _, _, code = await run(ws, f"cmp {src} {same}")
    check(f"{label}: cmp identical", code == 0)
    out, _, code = await run(ws, f"cmp {src} {other}")
    check(f"{label}: cmp differing", code == 1 and "differ" in out)


async def check_move(ws: Workspace, dst: str, label: str) -> None:
    # mv a directory across mounts: destination gets the tree, source is gone.
    await run(ws, "mkdir -p /ram/movedir/sub")
    await run(ws, "printf 'm\\n' > /ram/movedir/sub/c.txt")
    await run(ws, f"mv /ram/movedir {dst}/moved")
    out, _, _ = await run(ws, f"cat {dst}/moved/sub/c.txt")
    check(f"{label}: mv tree to dest", out == "m\n")
    _, _, code = await run(ws, "cat /ram/movedir/sub/c.txt")
    check(f"{label}: mv removes source", code != 0)


async def check_cross_mount_cache(ws: Workspace, s3_client,
                                  label: str) -> None:
    # A cross-mount read relays through the dispatcher; that relayed path must
    # serve warm bytes from the file cache, not re-fetch the backend. Warm the
    # S3 object with a single-mount cat, mutate it out-of-band via boto3, then
    # exercise the whole read family with the cached operand on /s3 and a live
    # operand on /ram. Under LAZY the cached v1 (keepme/mid/last) must win for
    # every command; a relayed path that skipped the cache would fetch v2
    # (nomatch) and these checks would fail. wc discriminates on line count
    # (cached 3 vs v2's 1) and grep on a v1-only token.
    s3_client.put_object(Bucket=S3_BUCKET,
                         Key="cache/x.txt",
                         Body=b"keepme\nmid\nlast\n")
    out, _, _ = await run(ws, "cat /s3/cache/x.txt")
    check(f"{label}: warm read caches v1", out == "keepme\nmid\nlast\n")
    s3_client.put_object(Bucket=S3_BUCKET,
                         Key="cache/x.txt",
                         Body=b"nomatch\n")
    src = "/ram/dir/a.txt"
    x = "/s3/cache/x.txt"
    out, _, _ = await run(ws, f"cat {src} {x}")
    check(f"{label}: cross cat serves cached",
          out == "aaa\nkeepme\nmid\nlast\n")
    out, _, _ = await run(ws, f"head -n 1 {src} {x}")
    check(f"{label}: cross head serves cached", "keepme" in out
          and "nomatch" not in out)
    out, _, _ = await run(ws, f"tail -n 1 {src} {x}")
    check(f"{label}: cross tail serves cached", "last" in out
          and "nomatch" not in out)
    out, _, _ = await run(ws, f"wc -l {src} {x}")
    check(f"{label}: cross wc serves cached", "4 total" in out)
    out, _, _ = await run(ws, f"grep keepme {src} {x}")
    check(f"{label}: cross grep serves cached", f"{x}:keepme" in out)


async def check_glob_cache(ws: Workspace, s3_client, label: str) -> None:
    # Glob multi-file warm serving on a single remote mount: warm every file
    # under glob/, mutate one out-of-band, then run the read family over
    # glob/*.txt. The glob expands to both files; each must serve its cached
    # bytes (a.txt's stale v1, not v2). a.txt's v2 grows to two lines so wc and
    # the line-shape commands discriminate cache from backend; grep keys on a
    # v1-only token.
    s3_client.put_object(Bucket=S3_BUCKET,
                         Key="glob/a.txt",
                         Body=b"alpha-v1\n")
    s3_client.put_object(Bucket=S3_BUCKET,
                         Key="glob/b.txt",
                         Body=b"bravo-v1\n")
    await run(ws, "cat /s3/glob/a.txt /s3/glob/b.txt")
    s3_client.put_object(Bucket=S3_BUCKET,
                         Key="glob/a.txt",
                         Body=b"alpha-v2\nEXTRA\n")
    g = "/s3/glob/*.txt"
    out, _, _ = await run(ws, f"head -n 1 {g}")
    check(f"{label}: glob head serves cached", "alpha-v1" in out
          and "alpha-v2" not in out)
    out, _, _ = await run(ws, f"tail -n 1 {g}")
    check(f"{label}: glob tail serves cached", "alpha-v1" in out
          and "EXTRA" not in out)
    out, _, _ = await run(ws, f"wc -l {g}")
    check(f"{label}: glob wc serves cached", "2 total" in out
          and "3 total" not in out)
    out, _, _ = await run(ws, f"grep alpha-v1 {g}")
    check(f"{label}: glob grep serves cached", "/s3/glob/a.txt:alpha-v1"
          in out)


async def exercise(ws: Workspace, dst: str, label: str,
                   expect_dirs: bool) -> None:
    print(f"===== ram -> {label} =====")
    await check_recursive(ws, dst, label, expect_dirs)
    await check_read_family(ws, dst, label)
    await check_compare(ws, dst, label)
    await check_no_clobber(ws, dst, label)
    await check_omit_directory(ws, dst, label)
    await check_move(ws, dst, label)


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    s3_client = boto3.client("s3", endpoint_url=endpoint, **CREDS)
    s3_client.create_bucket(Bucket=S3_BUCKET)

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
        await check_cross_mount_cache(ws, s3_client, "s3")
        await check_glob_cache(ws, s3_client, "s3")
    finally:
        server.stop()

    if _fail:
        print(f"\ncross commands FAILED ({_fail} checks)")
        sys.exit(1)
    print("\ncross commands OK")


if __name__ == "__main__":
    asyncio.run(main())
