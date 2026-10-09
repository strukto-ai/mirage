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

from mirage.commands.cli.builtin.hf import auth as auth_commands
from mirage.commands.cli.builtin.hf import env as env_commands
from mirage.commands.cli.builtin.hf import files as files_commands
from mirage.commands.cli.builtin.hf import repo as repo_commands
from mirage.commands.cli.builtin.hf.download import download_cmd
from mirage.commands.cli.builtin.hf.upload import upload_cmd
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.hf_hub.config import HfConfig

# Upstream `hf` is argparse, not clap, so the default UsageStyle already
# words its refusals ("hf: error: argument ...: invalid choice: 'x'",
# exit 2). There is no dialect to add for this one.

REPO_TYPE = Argument(
    "--repo-type",
    choices=("model", "dataset", "space"),
    default="model",
    metavar="REPO_TYPE",
    help="Type of repo (defaults to 'model')",
)
REVISION = Argument(
    "--revision",
    metavar="REVISION",
    help="A branch name, a tag, or a commit hash",
)
INCLUDE = Argument(
    "--include",
    action="append",
    metavar="INCLUDE",
    help="Glob patterns to match files",
)
EXCLUDE = Argument(
    "--exclude",
    action="append",
    metavar="EXCLUDE",
    help="Glob patterns to exclude files",
)
COMMIT_MESSAGE = Argument(
    "--commit-message",
    metavar="COMMIT_MESSAGE",
    help="The summary of the generated commit",
)
COMMIT_DESCRIPTION = Argument(
    "--commit-description",
    metavar="COMMIT_DESCRIPTION",
    help="The description of the generated commit",
)
CREATE_PR = Argument(
    "--create-pr",
    action="store_true",
    help="Upload the content as a new Pull Request",
)
QUIET = Argument(
    "--quiet",
    action="store_true",
    help="Print only the path to the downloaded files",
)
PRIVATE = Argument(
    "--private",
    action="store_true",
    help="Create a private repo if it does not exist yet",
)

REPO_ID = Argument("REPO_ID")


def _auth() -> CommandSpec:
    return CommandSpec(
        name="auth",
        description="Manage authentication (login, logout, etc.).",
        subcommands=(
            CommandSpec(
                name="whoami",
                description="Find out which huggingface.co account you are "
                "logged in as.",
            ),
            CommandSpec(
                name="list", description="List all stored access tokens"
            ),
        ),
    )


# Upstream spells this one with an underscore, alone among hf's
# options. Mimicking a program means mimicking its typos.
SPACE_SDK = Argument(
    "--space_sdk",
    choices=("gradio", "streamlit", "docker", "static"),
    metavar="SPACE_SDK",
    help="The SDK a Space runs on; required for --repo-type space",
)

TAG = Argument("TAG")


def _repo_tag() -> CommandSpec:
    return CommandSpec(
        name="tag",
        description="Manage tags for a repo on the Hub.",
        subcommands=(
            CommandSpec(
                name="create",
                description="Create a tag for a repo.",
                arguments=(
                    REPO_ID,
                    TAG,
                    Argument(
                        "-m",
                        "--message",
                        metavar="MESSAGE",
                        help="The description of the tag to create",
                    ),
                    REVISION,
                    REPO_TYPE,
                ),
            ),
            CommandSpec(
                name="list",
                description="List tags for a repo.",
                arguments=(
                    REPO_ID,
                    REPO_TYPE,
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a tag from a repo.",
                arguments=(
                    REPO_ID,
                    TAG,
                    Argument(
                        "-y",
                        "--yes",
                        action="store_true",
                        help="Answer Yes to prompts automatically",
                    ),
                    REPO_TYPE,
                ),
            ),
        ),
    )


def _repo() -> CommandSpec:
    return CommandSpec(
        name="repo",
        description="Manage repos on the Hub.",
        subcommands=(
            CommandSpec(
                name="create",
                description="Create a new repo on huggingface.co",
                arguments=(
                    REPO_ID,
                    REPO_TYPE,
                    PRIVATE,
                    SPACE_SDK,
                    Argument(
                        "--exist-ok",
                        action="store_true",
                        help="Do not raise an error if repo already exists",
                    ),
                    Argument(
                        "--resource-group-id",
                        metavar="RESOURCE_GROUP_ID",
                        help="Resource group in which to create "
                        "the repo. Resource groups is only "
                        "available for Enterprise Hub "
                        "organizations.",
                    ),
                ),
            ),
            _repo_tag(),
        ),
    )


def _repo_files() -> CommandSpec:
    return CommandSpec(
        name="repo-files",
        description="Manage files in a repo on the Hub.",
        subcommands=(
            CommandSpec(
                name="delete",
                description="Delete files from a repo on the Hub",
                arguments=(
                    REPO_ID,
                    Argument("PATTERNS", nargs="+"),
                    REPO_TYPE,
                    REVISION,
                    COMMIT_MESSAGE,
                    COMMIT_DESCRIPTION,
                    CREATE_PR,
                ),
            ),
        ),
    )


HF = CLI(
    spec=CommandSpec(
        name="hf",
        description="hf command helpers",
        subcommands=(
            _auth(),
            _repo(),
            _repo_files(),
            CommandSpec(
                name="download",
                description="Download files from the Hub",
                arguments=(
                    REPO_ID,
                    Argument("FILENAMES", nargs="*"),
                    REPO_TYPE,
                    REVISION,
                    INCLUDE,
                    EXCLUDE,
                    Argument(
                        "--cache-dir",
                        type="path",
                        metavar="CACHE_DIR",
                        help="Workspace directory to hold the cache; "
                        "defaults to HF_HUB_CACHE or HF_HOME/hub "
                        "from the session",
                    ),
                    Argument(
                        "--force-download",
                        action="store_true",
                        help="Download even when the cache already holds the file",
                    ),
                    Argument(
                        "--local-dir",
                        type="path",
                        metavar="LOCAL_DIR",
                        help="Download straight into this directory, "
                        "with no cache in between",
                    ),
                    Argument(
                        "--max-workers",
                        type="int",
                        metavar="MAX_WORKERS",
                        help="Maximum number of workers to use for "
                        "downloading files. Default is 8.",
                    ),
                    QUIET,
                ),
            ),
            CommandSpec(
                name="upload",
                description="Upload a file or a folder to the Hub. "
                "Recommended for single-commit uploads.",
                arguments=(
                    REPO_ID,
                    Argument("LOCAL_PATH", type="path", nargs="?"),
                    Argument("PATH_IN_REPO", nargs="?"),
                    REPO_TYPE,
                    REVISION,
                    PRIVATE,
                    INCLUDE,
                    EXCLUDE,
                    Argument(
                        "--delete",
                        action="append",
                        metavar="DELETE",
                        help="Glob patterns for files to delete "
                        "from the repo while committing",
                    ),
                    COMMIT_MESSAGE,
                    COMMIT_DESCRIPTION,
                    CREATE_PR,
                    QUIET,
                ),
            ),
            CommandSpec(
                name="env",
                description="Print information about the environment.",
            ),
            CommandSpec(
                name="version",
                description="Print information about the hf version.",
            ),
        ),
    ),
    handlers={
        "auth whoami": CLIHandler(fn=auth_commands.whoami_cmd),
        "auth list": CLIHandler(fn=auth_commands.list_cmd),
        "repo create": CLIHandler(fn=repo_commands.create_cmd, write=True),
        "repo tag create": CLIHandler(
            fn=repo_commands.tag_create_cmd, write=True
        ),
        "repo tag list": CLIHandler(fn=repo_commands.tag_list_cmd),
        "repo tag delete": CLIHandler(
            fn=repo_commands.tag_delete_cmd, write=True
        ),
        "repo-files delete": CLIHandler(
            fn=files_commands.delete_cmd, write=True
        ),
        "download": CLIHandler(fn=download_cmd, write=True),
        "upload": CLIHandler(fn=upload_cmd, write=True),
        "env": CLIHandler(fn=env_commands.env_cmd),
        "version": CLIHandler(fn=env_commands.version_cmd),
    },
    config_model=HfConfig,
)
