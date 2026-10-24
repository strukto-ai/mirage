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

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import WALK_LIMIT


class SSHConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    host: str
    """Host name, IP address or `~/.ssh/config` alias of the remote."""
    hostname: str | None = None
    """Address to connect to instead of `host`."""
    port: int | None = None
    """SSH port; unset uses the client's default, `22` unless
    `~/.ssh/config` sets one for the host."""
    username: str | None = None
    """Login user; unset uses the local user name unless `~/.ssh/config`
    sets one for the host."""
    identity_file: str | None = None
    """Path to a private key; `~` is expanded. Unset tries the SSH agent
    and the default keys in `~/.ssh`."""
    password: SecretStr | None = None
    """Password for password authentication; prefer `identity_file`."""
    passphrase: SecretStr | None = None
    """Passphrase of an encrypted `identity_file`; ignored when
    `identity_file` is unset."""
    root: str = "/"
    """Path on the remote that becomes the mount root."""
    timeout: int = 30
    """Seconds to wait for the TCP connection, and again for
    authentication."""
    known_hosts: str | None = None
    """Path to a `known_hosts` file the server's host key is checked
    against; unset disables host-key checking."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
