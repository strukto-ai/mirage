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

from dataclasses import dataclass

from mirage.runtime.sandbox.config import SandboxConfig


@dataclass(frozen=True, slots=True, kw_only=True)
class SSHRuntimeConfig(SandboxConfig):
    """How to reach the machine that runs captured lines.

    The same knobs as the ssh VFS's config minus ``root`` (a
    runtime has no mount root) and password auth (an exec surface
    holds keys, never a password). ``host`` doubles as the address
    unless ``hostname`` overrides it, mirroring OpenSSH's Host /
    HostName split.

    Args:
        host (str): the machine to reach; also the address unless
            hostname is set.
        hostname (str | None): the real address when host is a label.
        port (int | None): sshd port; None means 22.
        username (str | None): login user; None lets the client pick.
        identity_file (str | None): private key path (``~`` expands);
            None uses the running agent and default keys.
        timeout (int): connect timeout in seconds.
    """

    host: str
    hostname: str | None = None
    port: int | None = None
    username: str | None = None
    identity_file: str | None = None
    timeout: int = 30
