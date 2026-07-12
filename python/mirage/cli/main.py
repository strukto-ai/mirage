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
from mirage.cli import execute as execute_module
from mirage.cli import job as job_module
from mirage.cli import provision as provision_module
from mirage.cli import session as session_module
from mirage.cli import workspace as workspace_module
from mirage.server.daemon_config import DaemonConfigError

app = typer.Typer(
    name="mirage",
    help="Mirage daemon CLI: manage workspaces and execute commands.",
    no_args_is_help=True,
)
app.add_typer(workspace_module.app, name="workspace")
app.add_typer(session_module.app, name="session")
app.add_typer(job_module.app, name="job")
app.add_typer(execute_module.app, name="execute")
app.add_typer(provision_module.app, name="provision")
app.add_typer(daemon_module.app, name="daemon")
app.add_typer(config_module.app, name="config")


def main() -> None:
    """Entry point that turns config errors into clean exit-2 lines."""
    try:
        app()
    except DaemonConfigError as e:
        typer.echo(str(e), err=True)
        raise SystemExit(2) from e


if __name__ == "__main__":
    main()
