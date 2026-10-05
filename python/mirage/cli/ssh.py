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
from urllib.parse import quote

import typer

from mirage.cli.client import DaemonUnreachable, make_client
from mirage.cli.output import fail


def ssh_proxy_cmd(
    workspace_id: str = typer.Argument(
        ..., help="The workspace to log in to."
    ),
) -> None:
    """Carry SSH to a workspace over the server's HTTPS port, on stdio.

    For ``ssh -o ProxyCommand="mirage ssh-proxy %r" <id>@mirage``: the
    login is this CLI's token, so no SSH key and no SSH port are needed.
    """
    with make_client() as client:
        try:
            client.ensure_running()
        except DaemonUnreachable as e:
            fail(str(e))
        base = client.settings.url
        token = client.token()
    url = (
        "ws"
        + base.removeprefix("http")
        + (f"/v1/workspaces/{quote(workspace_id, safe='')}/ssh")
    )
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    from mirage.server.ssh.relay import TunnelRefused, relay_ssh

    try:
        asyncio.run(relay_ssh(url, headers))
    except TunnelRefused as e:
        fail(f"ssh-proxy: {e}")
