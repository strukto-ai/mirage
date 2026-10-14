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

from pathlib import Path
from typing import Any


def connect_options(
    host: str,
    hostname: str | None,
    port: int | None,
    username: str | None,
    identity_file: str | None,
    timeout: int,
) -> dict[str, Any]:
    """Shared SSH connection and authentication options.

    Args:
        host (str): host name or SSH configuration alias.
        hostname (str | None): explicit address overriding the alias.
        port (int | None): SSH port, otherwise the client's default.
        username (str | None): login user, otherwise the client's default.
        identity_file (str | None): explicit private key path.
        timeout (int): bound on TCP connection and authentication in seconds.
    """
    options: dict[str, Any] = {
        "host": hostname or host,
        "connect_timeout": timeout,
        "login_timeout": timeout,
    }
    if port is not None:
        options["port"] = port
    if username is not None:
        options["username"] = username
    if identity_file is not None:
        options["client_keys"] = [str(Path(identity_file).expanduser())]
    return options
