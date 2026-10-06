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

import typer

from mirage.cli import config as config_module
from mirage.cli import daemon as daemon_module
from mirage.cli import job as job_module
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
from mirage.cli.credentials import LoginError
from mirage.server.daemon_config import DaemonConfigError

app = typer.Typer(
    name="mirage",
    help="Mirage daemon CLI: manage workspaces and run shell lines.",
    no_args_is_help=True,
)
app.add_typer(workspace_module.app, name="workspace")
app.add_typer(session_module.app, name="session")
app.add_typer(job_module.app, name="job")
app.add_typer(shell_module.app, name="shell")
app.add_typer(vfs_module.app, name="vfs")
app.command("glob")(vfs_module.glob_cmd)
app.add_typer(tools_module.app, name="tools")
app.add_typer(daemon_module.app, name="daemon")
app.add_typer(config_module.app, name="config")
app.command("mcp")(mcp_module.mcp_cmd)
app.command("rpc")(rpc_module.rpc_cmd)
app.command("ssh-proxy")(ssh_module.ssh_proxy_cmd)
app.command("login")(login_module.login_cmd)
app.command("logout")(login_module.logout_cmd)
app.command("whoami")(login_module.whoami_cmd)


def main() -> None:
    """Entry point that turns config errors into clean exit-2 lines and
    an unreachable daemon or an ended login into a clean exit-1 line."""
    try:
        app()
    except DaemonConfigError as e:
        typer.echo(str(e), err=True)
        raise SystemExit(2) from e
    except (DaemonUnreachable, LoginError) as e:
        typer.echo(str(e), err=True)
        raise SystemExit(1) from e


if __name__ == "__main__":
    main()
