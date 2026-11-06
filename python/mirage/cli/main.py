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

import typer

from mirage.cli import api as api_module
from mirage.cli import config as config_module
from mirage.cli import connections as connections_module
from mirage.cli import context as context_module
from mirage.cli import daemon as daemon_module
from mirage.cli import login as login_module
from mirage.cli import mcp as mcp_module
from mirage.cli import rpc as rpc_module
from mirage.cli import session as session_module
from mirage.cli import shell as shell_module
from mirage.cli import ssh as ssh_module
from mirage.cli import tools as tools_module
from mirage.cli import vfs as vfs_module
from mirage.cli import workspace as workspace_module
from mirage.cli.client import DaemonUnreachable
from mirage.cli.context import ContextError
from mirage.cli.credentials import LoginError
from mirage.cli.env import ENV_CONTEXT
from mirage.server.daemon_config import DaemonConfigError

app = typer.Typer(
    name="mirage",
    help="Mirage daemon CLI: manage workspaces and run shell lines.",
    no_args_is_help=True,
)


@app.callback()
def root(
    context: str | None = typer.Option(
        None,
        "--context",
        help="Run this one command in another context; "
        "$MIRAGE_CONTEXT does the same.",
    ),
) -> None:
    """Mirage daemon CLI: manage workspaces and run shell lines."""
    if context:
        os.environ[ENV_CONTEXT] = context


app.add_typer(workspace_module.app, name="workspace")
app.add_typer(session_module.app, name="session")
app.add_typer(shell_module.app, name="shell")
workspace_module.app.add_typer(vfs_module.app, name="vfs")
workspace_module.app.command("glob")(vfs_module.glob_cmd)
for kind_name, kind_app in connections_module.APPS.items():
    app.add_typer(kind_app, name=kind_name)
app.command(
    "api",
    context_settings={
        "allow_extra_args": True,
        "ignore_unknown_options": True,
    },
)(api_module.api_cmd)
app.add_typer(tools_module.app, name="tools")
daemon_module.app.add_typer(config_module.app, name="config")
app.add_typer(daemon_module.app, name="daemon")
app.add_typer(config_module.moved, name="config")
app.add_typer(context_module.app, name="context")
app.command("mcp")(mcp_module.mcp_cmd)
app.command("rpc")(rpc_module.rpc_cmd)
app.command("ssh-proxy")(ssh_module.ssh_proxy_cmd)
app.command("codex-exec")(ssh_module.codex_exec_cmd)
app.command("login")(login_module.login_cmd)
app.command("logout")(login_module.logout_cmd)
app.command("whoami")(login_module.whoami_cmd)


def main(argv: list[str] | None = None) -> None:
    """Entry point that turns config and context errors into clean
    exit-2 lines and
    an unreachable daemon or an ended login into a clean exit-1 line.

    Args:
        argv (list[str] | None): the arguments after the program name;
            the process's own when None.
    """
    try:
        app(args=argv)
    except (DaemonConfigError, ContextError) as e:
        typer.echo(str(e), err=True)
        raise SystemExit(2) from e
    except (DaemonUnreachable, LoginError) as e:
        typer.echo(str(e), err=True)
        raise SystemExit(1) from e


if __name__ == "__main__":
    main()
