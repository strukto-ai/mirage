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
    from mirage.server.ssh.relay import (  # noqa: PLC0415 - cold start
        TunnelRefused,
        relay_ssh,
    )

    try:
        asyncio.run(relay_ssh(url, headers))
    except TunnelRefused as e:
        fail(f"ssh-proxy: {e}")


def codex_exec_cmd(
    workspace_id: str = typer.Argument(..., help="The workspace to serve."),
    listen: str = typer.Option(
        "127.0.0.1:0",
        "--listen",
        help="HOST:PORT to accept codex exec-server forward on.",
    ),
) -> None:
    """Serve a workspace to ``codex exec-server forward`` on a local port.

    For ``codex exec-server forward --connect ws://HOST:PORT``: each
    connection is relayed to the server's codex-exec route with this
    CLI's token, which forward cannot send itself. Keep it on loopback.
    """
    host, sep, port = listen.rpartition(":")
    if not sep or not host or not port.isdigit():
        fail("codex-exec: --listen takes HOST:PORT")
    with make_client() as client:
        try:
            client.ensure_running()
        except DaemonUnreachable as e:
            fail(str(e))
        base = client.settings.url
        token = client.token
    url = (
        "ws"
        + base.removeprefix("http")
        + (f"/v1/workspaces/{quote(workspace_id, safe='')}/codex-exec")
    )
    # Keep websocket support out of unrelated CLI commands.
    from mirage.server.ssh.relay import relay_codex  # noqa: PLC0415

    asyncio.run(relay_codex(host.strip("[]"), int(port), url, token))
