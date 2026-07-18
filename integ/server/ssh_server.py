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

import argparse
import asyncio
import functools
import tempfile

import asyncssh


class NoAuthServer(asyncssh.SSHServer):

    def begin_auth(self, username: str) -> bool:
        return False


class ChrootSFTPServer(asyncssh.SFTPServer):

    def __init__(self, root: str, chan: asyncssh.SSHServerChannel) -> None:
        super().__init__(chan, chroot=root)


async def start_server(root: str, port: int = 0) -> asyncssh.SSHAcceptor:
    """Start a no-auth SFTP-only server chrooted to root.

    Args:
        root (str): Local directory served as the SFTP root.
        port (int): Port to listen on; 0 picks a free port.
    """
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    return await asyncssh.listen(
        "127.0.0.1",
        port,
        server_host_keys=[host_key],
        server_factory=NoAuthServer,
        sftp_factory=functools.partial(ChrootSFTPServer, root),
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--root", default=None)
    args = parser.parse_args()
    root = args.root or tempfile.mkdtemp(prefix="mirage-integ-ssh-")
    server = await start_server(root, args.port)
    print(f"SSH_HOST=127.0.0.1 SSH_PORT={server.get_port()} ROOT={root}",
          flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
