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

from mirage.commands.cli.builtin.gh.api import api
from mirage.commands.cli.builtin.gh.repo import fork, rename, view
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.core.github.config import GhConfig
from mirage.types import ResourceName

# The GitHub CLI, spelled as cli.github.com spells it. The `github` mount is
# the read half -- a repository is a tree, so listing and reading it is `ls`
# and `cat` -- and this is the write half plus the account-level operations a
# filesystem has no shape for: forking, renaming, and `api` for everything
# else. Install with a GhConfig; `repo` supplies the default repository that
# real gh reads off the current git remote.
GH = CLISpec(
    name="gh",
    description="GitHub CLI",
    config_model=GhConfig,
    # A write here lands on the same repository a `github` mount reads, and
    # it lands by name rather than by any vfs path, so the mount cannot
    # invalidate itself: without this, `gh api -X PUT .../contents/f`
    # followed by `cat /repo/f` serves the pre-write bytes.
    serves=(ResourceName.GITHUB, ),
    subcommands=(
        CLISpec(
            name="repo",
            description="Manage repositories",
            subcommands=(
                CLISpec(
                    name="view",
                    description="View a repository",
                    fn=view,
                    positional=(Operand(type="str", name="REPOSITORY"), ),
                ),
                CLISpec(
                    name="fork",
                    description="Create a fork of a repository",
                    fn=fork,
                    write=True,
                    positional=(Operand(type="str", name="REPOSITORY"), ),
                    options=(Option(
                        long="--fork-name",
                        type="str",
                        description="Rename the forked repository",
                    ), ),
                ),
                CLISpec(
                    name="rename",
                    description="Rename a repository",
                    fn=rename,
                    write=True,
                    positional=(Operand(
                        type="str",
                        name="NEW-NAME",
                        required=True,
                    ), ),
                    options=(Option(
                        short="-R",
                        long="--repo",
                        type="str",
                        description=
                        "Select another repository, as [HOST/]OWNER/REPO",
                    ), ),
                ),
            ),
        ),
        CLISpec(
            name="api",
            description="Make an authenticated GitHub API request",
            fn=api,
            write=True,
            positional=(Operand(type="str", name="ENDPOINT",
                                required=True), ),
            options=(
                Option(
                    short="-X",
                    long="--method",
                    type="str",
                    description="The HTTP method for the request",
                ),
                Option(
                    short="-f",
                    long="--raw-field",
                    type="str",
                    multiple=True,
                    description="Add a string parameter in key=value format",
                ),
                Option(
                    short="-F",
                    long="--field",
                    type="str",
                    multiple=True,
                    description="Add a typed parameter in key=value format",
                ),
            ),
        ),
    ),
)
