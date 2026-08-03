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

import json
import os
import shutil
import subprocess
import sys
import tempfile

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.fuse.mount import mount_background
from mirage.policy import Policy
from mirage.policy.types import Deny, OpsContext, OpsResultContext
from mirage.resource.ram import RAMResource
from mirage.types import FileStat


class SizelessOps:
    """Ops proxy that strips stat sizes.

    Simulates API-backed resources (Linear, Slack, Trello, ...) whose byte
    size is unknown until the content is fetched: over FUSE such files must
    stat as 0 until first open and read fully afterwards.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str) -> FileStat:
        result = await self._inner.stat(path)
        return result.model_copy(update={"size": None})


API_CONTENT = b'{"messages": 2}\n'


class SealReadsPolicy(Policy):
    """pre_ops deny: a sealed path never reaches the backend."""

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if not ctx.write and ctx.path.virtual.endswith(".sealed"):
            return Deny(message="sealed\n")
        return None


class RedactReadsPolicy(Policy):
    """post_ops deny: refuse read results carrying a marker."""

    async def post_ops(self, ctx: OpsResultContext) -> Deny | None:
        data = ctx.result if isinstance(ctx.result,
                                        (bytes, bytearray)) else None
        if ctx.op == "read" and data is not None and b"TOPSECRET" in data:
            return Deny(message="redacted\n")
        return None


def run_policy_probe(result: dict[str, object]) -> None:
    """Record that op policies gate the kernel path too.

    FUSE serves the workspace's op door, so a pre_ops deny (sealed
    path) and a post_ops deny (redacted content) must both surface as
    EACCES to ordinary file APIs, while unguarded reads pass.

    Args:
        result (dict[str, object]): the probe result to extend.
    """
    res = RAMResource()
    res._store.dirs.add("/")
    res._store.files["/clean.txt"] = b"hello\n"
    res._store.files["/secret.txt"] = b"TOPSECRET plans\n"
    res._store.files["/x.sealed"] = b"nope\n"
    with Workspace(
        {
            "/guarded": Mount(
                res, mode=MountMode.READ, backend=MountBackend.FUSE)
        },
            policies=[SealReadsPolicy(),
                      RedactReadsPolicy()]) as ws:
        mp = ws.fuse_mountpoints["/guarded"]
        with open(f"{mp}/clean.txt", "rb") as fh:
            result["policy_clean_read"] = fh.read().decode().strip()
        # A denied path must fail with EACCES. Catch every OSError so an
        # odd errno (WinFsp reports EBADF here) records as a mismatch in
        # the advisory job instead of killing the whole probe.
        try:
            with open(f"{mp}/x.sealed", "rb") as fh:
                fh.read()
            result["policy_sealed_eacces"] = False
        except PermissionError:
            result["policy_sealed_eacces"] = True
        except OSError:
            result["policy_sealed_eacces"] = False
        try:
            with open(f"{mp}/secret.txt", "rb") as fh:
                fh.read()
            result["policy_redact_eacces"] = False
        except PermissionError:
            result["policy_redact_eacces"] = True
        except OSError:
            result["policy_redact_eacces"] = False


def run_sizeless_probe(result: dict[str, object]) -> None:
    """Record the size-unknown semantics into the shared result.

    Args:
        result (dict[str, object]): the probe result to extend.
    """
    api = RAMResource()
    api._store.dirs.add("/")
    api._store.files["/api.json"] = API_CONTENT
    ws = Workspace({"/api": Mount(api, mode=MountMode.READ)})
    mountpoint = tempfile.mkdtemp(prefix="mirage-fuse-api-")
    mount_background(SizelessOps(ws.ops), mountpoint)
    api_file = f"{mountpoint}/api/api.json"
    try:
        # Size-unknown semantics (see the CLAUDE.md FUSE section): stat 0
        # before open, full content on read, real size served after open.
        # Windows cannot query attributes without opening a handle, so
        # hydrate-on-open runs and even the pre-open stat sees the real size.
        pre = os.path.getsize(api_file)
        expected_pre = len(API_CONTENT) if sys.platform == "win32" else 0
        result["api_stat_preopen_ok"] = pre == expected_pre
        with open(api_file, "rb") as fh:
            result["api_cat"] = fh.read().decode().strip()
        result["api_size_postread"] = os.path.getsize(api_file)
    finally:
        if sys.platform == "darwin":
            subprocess.run(["diskutil", "unmount", "force", mountpoint],
                           capture_output=True)
        elif sys.platform != "win32":
            # win32 has no fusermount; WinFsp unmounts on process exit.
            subprocess.run(["fusermount", "-u", mountpoint],
                           capture_output=True)


def main() -> None:
    result: dict[str, object] = {}
    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/a.txt"] = b"alpha\n"
    logs = RAMResource()
    logs._store.dirs.add("/")
    logs._store.files["/b.txt"] = b"beta\n"

    pinned = os.path.join(tempfile.gettempdir(),
                          f"mirage-fuse-data-{os.getpid()}")
    shutil.rmtree(pinned, ignore_errors=True)
    # Mount via the public per-mount Mount spec (what examples/users write):
    # /data pins its mountpoint and overrides the workspace default to WRITE;
    # /logs gets a generated mountpoint and inherits the default READ.
    with Workspace({
            "/data":
            Mount(data,
                  mode=MountMode.WRITE,
                  backend=MountBackend.FUSE,
                  mountpoint=pinned),
            "/logs":
            Mount(logs, backend=MountBackend.FUSE),
    }) as ws:
        data_mp = ws.fuse_mountpoints["/data"]
        logs_mp = ws.fuse_mountpoints["/logs"]

        with open(f"{data_mp}/a.txt", "rb") as fh:
            result["data_cat_a"] = fh.read().decode().strip()
        with open(f"{logs_mp}/b.txt", "rb") as fh:
            result["logs_cat_b"] = fh.read().decode().strip()
        result["logs_size_b"] = os.path.getsize(f"{logs_mp}/b.txt")
        result["data_pinned"] = data_mp == pinned
        result["distinct_mounts"] = data_mp != logs_mp

        result["data_mode_is_write"] = ws.mount(
            "/data").mode == MountMode.WRITE
        result["logs_mode_is_read"] = ws.mount("/logs").mode == MountMode.READ

        try:
            _ = ws.fuse_mountpoint
            singular = False
        except RuntimeError:
            singular = True
        result["singular_raises_multi"] = singular

        try:
            ws.add_fuse_mount("/collide", pinned)
            collision = False
        except ValueError:
            collision = True
        result["collision_rejected"] = collision

    run_sizeless_probe(result)
    run_policy_probe(result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
