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
from contextlib import ExitStack

import pytest

from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.e2e.mounts import REDIS_URL, SSH_ROOT, MountState, build_mount
from tests.e2e.s3_mock import patch_s3_multi

# The key sits in a directory named like its mount; /m/k.txt is not virtual.
SCRIPT = [
    "echo x > /m/m/k.txt",
    "echo y >> /m/m/k.txt",
    "echo z | tee -a /m/m/k.txt",
    "touch /m/m/new.txt",
    "truncate -s 0 /m/m/new.txt",
    "cat /m/m/k.txt",
    "cp /m/m/k.txt /r/k.txt",
    "cp /m/m/k.txt /m/m/k2.txt",
    "mv /m/m/new.txt /m/m/moved.txt",
    "rm /m/m/moved.txt",
    "mkdir /m/m/e; rmdir /m/m/e",
    "mkdir /m/m/d; touch /m/m/d/f; rm -r /m/m/d",
    "gzip -k /m/m/k.txt",
    "gunzip -k -f /m/m/k.txt.gz",
    "split -l 1 /m/m/k.txt /m/m/x",
    "csplit -f /m/m/cs /m/m/k.txt 2",
]

# Namespace ops record at the entry point with the virtual path already, so
# they cannot tell the two behaviours apart; exempt by op name, not by source.
EXEMPT_OPS = {
    "setattr",
    "symlink",
    "readlink",
    "getxattr",
    "listxattr",
    "setxattr",
    "removexattr",
}

K = "/m/m/k.txt"
NEW = "/m/m/new.txt"
DF = "/m/m/d/f"
C = "/m/m/c.txt"
GZ = "/m/m/k.txt.gz"

# gzip, gunzip, split and csplit build their output spec from the operand's
# key; each output must still be recorded under its virtual path.
_GENERIC_OUT = [
    ("read", K),
    ("write", GZ),
    ("read", GZ),
    ("write", K),
    ("read", K),
    ("write", "/m/m/xaa"),
    ("write", "/m/m/xab"),
    ("write", "/m/m/xac"),
    ("read", K),
    ("write", "/m/m/cs00"),
    ("write", "/m/m/cs01"),
]

# Op sequences were measured by running SCRIPT on each backend; every path is
# predicted as the operand's virtual path, never copied from the measurement.
# Redirects open before echo runs: `>` records its empty open and output
# write. RAM and Redis skip recording an empty append; disk and SSH record it.
# ram, disk and redis record nothing for same-mount cp/mv/rm/rmdir/rm -r.
_NATIVE_APPEND = [
    ("write", K),
    ("write", K),
    ("append", K),
    ("append", K),
    ("write", NEW),
    ("truncate", NEW),
    ("read", K),
    ("read", K),
    ("write", DF),
    *_GENERIC_OUT,
    ("create", C),
    ("append", C),
]

# s3 has no native append (read + write), serves cat, the cp source and
# gzip's read from cache, and records its own copy, rename, unlink, rmdir
# and rm_r.
_S3 = [
    ("write", K),
    ("write", K),
    ("read", K),
    ("write", K),
    ("read", K),
    ("write", K),
    ("write", NEW),
    ("truncate", NEW),
    ("copy", "/m/m/k2.txt"),
    ("rename", NEW),
    ("rename", "/m/m/moved.txt"),
    ("unlink", "/m/m/moved.txt"),
    ("rmdir", "/m/m/e"),
    ("write", DF),
    ("rm_r", "/m/m/d"),
    *_GENERIC_OUT[1:],
    ("create", C),
    ("read", C),
    ("write", C),
]

# ssh records nothing for cat and gzip (cached), cp, mv, rm, rmdir, rm -r
# or split's streamed read.
_SSH = [
    ("write", K),
    ("write", K),
    ("append", K),
    ("append", K),
    ("append", K),
    ("write", NEW),
    ("truncate", NEW),
    ("write", DF),
    *_GENERIC_OUT[1:4],
    *_GENERIC_OUT[5:],
    ("create", C),
    ("append", C),
]

EXPECTED = {
    "ram": _NATIVE_APPEND,
    "disk": [*_NATIVE_APPEND[:2], ("append", K), *_NATIVE_APPEND[2:]],
    "redis": _NATIVE_APPEND,
    "s3": _S3,
    "ssh": _SSH,
}

S3_BUCKET = "test-bucket-1"


def _under_m(path: str) -> bool:
    return path == "/m" or path.startswith("/m/")


def _ledger(records) -> list[tuple[str, str]]:
    return [
        (r.op, r.path)
        for r in records
        if _under_m(r.path) and r.op not in EXEMPT_OPS
    ]


async def _prepare(ws: Workspace, state: MountState) -> None:
    if state.ptype == "ssh":
        state.sftp_dirs.add(f"{SSH_ROOT}/m")
    elif state.ptype != "s3":
        io = await ws.shell("mkdir -p /m/m")
        assert io.exit_code == 0


async def _run_records(
    state: MountState, script: list[str], seed: list[str]
) -> tuple[Workspace, list]:
    ws = Workspace(
        {
            "/m": (state.vfs, MountMode.WRITE),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    await _prepare(ws, state)
    for line in seed:
        io = await ws.shell(line)
        await io.stdout_str()
        assert io.exit_code == 0, (line, await io.stderr_str())
    ws._files.records.clear()
    for line in script:
        io = await ws.shell(line)
        await io.stdout_str()
        # A loud failure trips the exit code; a silent no-op, the exact ledger.
        assert io.exit_code == 0, (line, await io.stderr_str())
    records = list(ws._files.records)
    # touch records write, so only the dispatcher reaches create.
    scope = RecordingScope()
    try:
        path = PathSpec.from_str_path(C)
        await ws.dispatch("create", path)
        await ws.dispatch("append", path, data=b"q")
    finally:
        scope.close()
    records.extend(scope.records)
    return ws, records


async def _close(ws: Workspace, state: MountState) -> None:
    if state.ptype == "redis":
        await state.vfs._store.clear()
    await ws.close()


async def _run_row(state: MountState) -> list[tuple[str, str]]:
    ws, records = await _run_records(state, SCRIPT, [])
    try:
        return _ledger(records)
    finally:
        await _close(ws, state)


def _row_marks(ptype: str):
    if ptype == "redis" and not REDIS_URL:
        return [pytest.mark.skip(reason="REDIS_URL not set")]
    return []


@pytest.mark.parametrize(
    "ptype", [pytest.param(p, id=p, marks=_row_marks(p)) for p in EXPECTED]
)
def test_record_paths_are_virtual(ptype, tmp_path):
    state = build_mount(ptype, "/m", tmp_path, 1)
    with ExitStack() as stack:
        if ptype == "s3":
            stack.enter_context(patch_s3_multi({S3_BUCKET: {}}))
        # One loop per row: FakeRedis and pooled clients break across loops.
        ledger = asyncio.run(_run_row(state))
    assert ledger == EXPECTED[ptype]


# A mount-root key: a site that records the mount-relative "/k2.txt" names a
# path the root mount owns, so the invariant catches it where the key named
# like its mount (/m/m/k.txt) cannot. Reads and writes both touch it, and a
# stdin split and csplit, with no operand to name their outputs from, write
# beside it.
SWEEP = SCRIPT + [
    "cat /m/k2.txt",
    "head -c 1 /m/k2.txt",
    "grep x /m/k2.txt",
    "wc -c /m/k2.txt",
    "tail -c 1 /m/k2.txt",
    "ls /m/m",
    "echo y >> /m/k2.txt",
    "echo z | tee -a /m/k2.txt",
    "truncate -s 1 /m/k2.txt",
    "touch /m/k3.txt",
    "gzip -k /m/k2.txt",
    "cd /m && printf 'a\\nb\\n' | split -l 1",
    "cd /m && printf 'a\\nb\\n' | csplit - 2",
]


async def _run_invariant(state: MountState) -> list[tuple[str, str, str]]:
    ws, records = await _run_records(state, SWEEP, ["echo x > /m/k2.txt"])
    try:
        checked = [
            r
            for r in records
            if r.mount_id is not None and r.op not in EXEMPT_OPS
        ]
        assert checked
        mismatched = []
        for r in checked:
            owner = ws._registry.try_mount_for(r.path)
            if owner is None or owner.mount_id != r.mount_id:
                mismatched.append((r.op, r.path, r.mount_id))
        return mismatched
    finally:
        await _close(ws, state)


@pytest.mark.parametrize(
    "ptype", [pytest.param(p, id=p, marks=_row_marks(p)) for p in EXPECTED]
)
def test_every_record_resolves_to_its_mount(ptype, tmp_path):
    state = build_mount(ptype, "/m", tmp_path, 1)
    with ExitStack() as stack:
        if ptype == "s3":
            stack.enter_context(patch_s3_multi({S3_BUCKET: {}}))
        mismatched = asyncio.run(_run_invariant(state))
    assert mismatched == []


async def _cat_mount_ids() -> tuple[list[str | None], str | None]:
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    try:
        io = await ws.shell("mkdir -p /m/m && echo x > /m/m/k.txt")
        assert io.exit_code == 0
        ws._files.records.clear()
        io = await ws.shell("cat /m/m/k.txt")
        assert await io.stdout_str() == "x\n"
        ids = [
            r.mount_id
            for r in ws._files.records
            if (r.op, r.path) == ("read", K)
        ]
        return ids, ws.mount("/m").mount_id
    finally:
        await ws.close()


def test_cat_record_carries_the_mount_id():
    ids, mount_id = asyncio.run(_cat_mount_ids())
    assert mount_id is not None
    assert ids == [mount_id]
