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
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.core.hf_hub.config import HfConfig

# Upstream `hf` is argparse, not clap, so the default UsageStyle already
# words its refusals ("hf: error: argument ...: invalid choice: 'x'",
# exit 2). There is no dialect to add for this one.

REPO_TYPE = Option(long="--repo-type",
                   type="str",
                   choices=("model", "dataset", "space"),
                   default="model",
                   metavar="REPO_TYPE",
                   description="Type of repo (defaults to 'model')")
REVISION = Option(long="--revision",
                  type="str",
                  metavar="REVISION",
                  description="A branch name, a tag, or a commit hash")
INCLUDE = Option(long="--include",
                 type="str",
                 multiple=True,
                 metavar="INCLUDE",
                 description="Glob patterns to match files")
EXCLUDE = Option(long="--exclude",
                 type="str",
                 multiple=True,
                 metavar="EXCLUDE",
                 description="Glob patterns to exclude files")
COMMIT_MESSAGE = Option(long="--commit-message",
                        type="str",
                        metavar="COMMIT_MESSAGE",
                        description="The summary of the generated commit")
COMMIT_DESCRIPTION = Option(
    long="--commit-description",
    type="str",
    metavar="COMMIT_DESCRIPTION",
    description="The description of the generated commit")
CREATE_PR = Option(long="--create-pr",
                   description="Upload the content as a new Pull Request")
QUIET = Option(long="--quiet",
               description="Print only the path to the downloaded files")
PRIVATE = Option(long="--private",
                 description="Create a private repo if it does not exist yet")

REPO_ID = Operand(type="str", name="REPO_ID", required=True)


def _auth() -> CLISpec:
    return CLISpec(
        name="auth",
        description="Manage authentication (login, logout, etc.).",
        subcommands=(
            CLISpec(
                name="whoami",
                description=("Find out which huggingface.co account you are "
                             "logged in as."),
                fn=auth_commands.whoami_cmd),
            CLISpec(name="list",
                    description="List all stored access tokens",
                    fn=auth_commands.list_cmd),
        ))


# Upstream spells this one with an underscore, alone among hf's
# options. Mimicking a program means mimicking its typos.
SPACE_SDK = Option(long="--space_sdk",
                   type="str",
                   choices=("gradio", "streamlit", "docker", "static"),
                   metavar="SPACE_SDK",
                   description=("The SDK a Space runs on; required for "
                                "--repo-type space"))

TAG = Operand(type="str", name="TAG", required=True)


def _repo_tag() -> CLISpec:
    return CLISpec(
        name="tag",
        description="Manage tags for a repo on the Hub.",
        subcommands=(
            CLISpec(name="create",
                    description="Create a tag for a repo.",
                    fn=repo_commands.tag_create_cmd,
                    write=True,
                    positional=(REPO_ID, TAG),
                    options=(Option(
                        short="-m",
                        long="--message",
                        type="str",
                        metavar="MESSAGE",
                        description=("The description of the tag to "
                                     "create")), REVISION, REPO_TYPE)),
            CLISpec(name="list",
                    description="List tags for a repo.",
                    fn=repo_commands.tag_list_cmd,
                    positional=(REPO_ID, ),
                    options=(REPO_TYPE, )),
            CLISpec(name="delete",
                    description="Delete a tag from a repo.",
                    fn=repo_commands.tag_delete_cmd,
                    write=True,
                    positional=(REPO_ID, TAG),
                    options=(Option(short="-y",
                                    long="--yes",
                                    description=("Answer Yes to prompts "
                                                 "automatically")),
                             REPO_TYPE)),
        ))


def _repo() -> CLISpec:
    return CLISpec(
        name="repo",
        description="Manage repos on the Hub.",
        subcommands=(
            CLISpec(
                name="create",
                description="Create a new repo on huggingface.co",
                fn=repo_commands.create_cmd,
                write=True,
                positional=(REPO_ID, ),
                options=(REPO_TYPE, PRIVATE, SPACE_SDK,
                         Option(long="--exist-ok",
                                description=("Do not raise an error if "
                                             "repo already exists")),
                         Option(
                             long="--resource-group-id",
                             type="str",
                             metavar="RESOURCE_GROUP_ID",
                             description=("Resource group in which to create "
                                          "the repo. Resource groups is only "
                                          "available for Enterprise Hub "
                                          "organizations.")))),
            _repo_tag(),
        ))


def _repo_files() -> CLISpec:
    return CLISpec(name="repo-files",
                   description="Manage files in a repo on the Hub.",
                   subcommands=(CLISpec(
                       name="delete",
                       description="Delete files from a repo on the Hub",
                       fn=files_commands.delete_cmd,
                       write=True,
                       positional=(REPO_ID,
                                   Operand(type="str",
                                           name="PATTERNS",
                                           required=True,
                                           remainder=True)),
                       options=(REPO_TYPE, REVISION, COMMIT_MESSAGE,
                                COMMIT_DESCRIPTION, CREATE_PR)), ))


HF = CLISpec(
    name="hf",
    description="hf command helpers",
    config_model=HfConfig,
    subcommands=(
        _auth(),
        _repo(),
        _repo_files(),
        CLISpec(
            name="download",
            description="Download files from the Hub",
            fn=download_cmd,
            write=True,
            positional=(REPO_ID,
                        Operand(type="str", name="FILENAMES", remainder=True)),
            options=(
                REPO_TYPE, REVISION, INCLUDE, EXCLUDE,
                Option(long="--cache-dir",
                       type="str",
                       metavar="CACHE_DIR",
                       description=("Workspace directory to hold the cache; "
                                    "defaults to HF_HUB_CACHE or HF_HOME/hub "
                                    "from the session")),
                Option(long="--force-download",
                       description=("Download even when the cache "
                                    "already holds the file")),
                Option(long="--local-dir",
                       type="str",
                       metavar="LOCAL_DIR",
                       description=("Download straight into this directory, "
                                    "with no cache in between")),
                Option(long="--max-workers",
                       type="int",
                       metavar="MAX_WORKERS",
                       description=("Maximum number of workers to use for "
                                    "downloading files. Default is 8.")),
                QUIET)),
        CLISpec(
            name="upload",
            description=("Upload a file or a folder to the Hub. "
                         "Recommended for single-commit uploads."),
            fn=upload_cmd,
            write=True,
            positional=(REPO_ID, Operand(type="str", name="LOCAL_PATH"),
                        Operand(type="str", name="PATH_IN_REPO")),
            options=(REPO_TYPE, REVISION, PRIVATE, INCLUDE, EXCLUDE,
                     Option(long="--delete",
                            type="str",
                            multiple=True,
                            metavar="DELETE",
                            description=("Glob patterns for files to delete "
                                         "from the repo while committing")),
                     COMMIT_MESSAGE, COMMIT_DESCRIPTION, CREATE_PR, QUIET)),
        CLISpec(name="env",
                description="Print information about the environment.",
                fn=env_commands.env_cmd),
        CLISpec(name="version",
                description="Print information about the hf version.",
                fn=env_commands.version_cmd),
    ),
)
