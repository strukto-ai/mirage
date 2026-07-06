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
import os
import shutil
import sys
import tempfile
from pathlib import Path

import asyncssh

sys.path.insert(0, str(Path(__file__).parent))

from cases import assert_real_mtime, run_cases  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.ssh import SSHConfig, SSHResource  # noqa: E402

ROOT_DIR = tempfile.mkdtemp(prefix="mirage-integ-ssh-")


class NoAuthServer(asyncssh.SSHServer):

    def begin_auth(self, username: str) -> bool:
        return False


class ChrootSFTPServer(asyncssh.SFTPServer):

    def __init__(self, chan: asyncssh.SSHServerChannel) -> None:
        super().__init__(chan, chroot=ROOT_DIR)


async def main() -> None:
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    server = await asyncssh.listen(
        "127.0.0.1",
        0,
        server_host_keys=[host_key],
        server_factory=NoAuthServer,
        sftp_factory=ChrootSFTPServer,
    )
    try:
        port = server.get_port()
        # Sibling subroots: /data must not see /data2's directory in
        # its own listings, so neither mount roots at the chroot root.
        os.makedirs(os.path.join(ROOT_DIR, "xm1"), exist_ok=True)
        os.makedirs(os.path.join(ROOT_DIR, "xm2"), exist_ok=True)
        resource = SSHResource(
            SSHConfig(host="127.0.0.1",
                      port=port,
                      username="integ",
                      root="/xm1"))
        resource2 = SSHResource(
            SSHConfig(host="127.0.0.1",
                      port=port,
                      username="integ",
                      root="/xm2"))
        ws = Workspace({
            "/data": resource,
            "/data2": resource2
        },
                       mode=MountMode.WRITE)
        await run_cases(ws)
        await assert_real_mtime(ws)
        await resource.accessor.close()
    finally:
        server.close()
        shutil.rmtree(ROOT_DIR, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
