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

import os
import uuid

from mirage.vfs.disk import DiskVFS
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.redis import RedisVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.ssh import SSHVFS, SSHConfig
from tests.fixtures.google_account import GoogleAccount
from tests.fixtures.kit_fake import LoopThread
from tests.fixtures.ssh_run import sftp_only_connection
from tests.vfs.ssh.test_ssh_commands import MockSFTPClient

REDIS_URL = os.environ.get("REDIS_URL", "")

SSH_ROOT = "/data"


class MountState:
    def __init__(self, ptype: str, mount_path: str, idx: int) -> None:
        self.ptype = ptype
        self.mount_path = mount_path
        self.idx = idx
        self.disk_root = None
        self.s3_bucket: str | None = None
        self.gdrive: GoogleAccount | None = None
        self.thread: LoopThread | None = None
        self.redis_prefix: str | None = None
        self.sftp_files: dict[str, bytes] | None = None
        self.sftp_dirs: set[str] | None = None
        self.vfs = None
        self.accessor = None


def _make_s3_vfs(bucket: str) -> S3VFS:
    config = S3Config(
        bucket=bucket,
        region="us-east-1",
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    return S3VFS(config)


def _make_redis_vfs(prefix: str) -> RedisVFS:
    return RedisVFS(url=REDIS_URL, key_prefix=prefix)


async def _account(origin: str) -> GoogleAccount:
    """An account made on the running loop, which its session belongs to.

    Args:
        origin (str): the Google Workspace fake's origin.
    """
    return GoogleAccount(origin)


def _make_ssh_vfs(state: MountState) -> SSHVFS:
    vfs = SSHVFS(SSHConfig(host="mock", root=SSH_ROOT, known_hosts=None))
    state.sftp_files = {}
    state.sftp_dirs = {SSH_ROOT}
    vfs.accessor._sftp = MockSFTPClient(state.sftp_files, state.sftp_dirs)
    vfs.accessor._conn = sftp_only_connection()
    return vfs


def build_mount(
    ptype: str,
    mount_path: str,
    tmp_path,
    idx: int,
    gws_origin: str | None = None,
) -> MountState:
    state = MountState(ptype, mount_path, idx)
    if ptype == "ram":
        state.vfs = RAMVFS()
        state.accessor = state.vfs.accessor
    elif ptype == "disk":
        root = tmp_path / f"disk{idx}"
        root.mkdir()
        state.disk_root = root
        state.vfs = DiskVFS(root=str(root))
    elif ptype == "redis":
        prefix = f"mirage:test:{uuid.uuid4().hex}:{idx}:"
        state.redis_prefix = prefix
        state.vfs = _make_redis_vfs(prefix)
    elif ptype == "s3":
        state.s3_bucket = f"test-bucket-{idx}"
        state.vfs = _make_s3_vfs(state.s3_bucket)
    elif ptype == "gdrive":
        # An account of its own on the fake, run on a loop of its own: the
        # matrix runs each command under asyncio.run.
        assert gws_origin is not None
        state.thread = LoopThread()
        state.gdrive = state.thread.run(_account(gws_origin))
        state.vfs = GoogleDriveVFS(state.gdrive.config(GoogleDriveConfig))
    elif ptype == "ssh":
        state.vfs = _make_ssh_vfs(state)
    else:
        raise ValueError(f"unknown VFS: {ptype}")
    return state


def close_mount(state: MountState) -> None:
    """Drop the account a Drive mount's state holds on the fake.

    Args:
        state (MountState): the mount's state.
    """
    if state.gdrive is not None and state.thread is not None:
        state.thread.run(state.gdrive.run.close())
        state.thread.close()
