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

from mirage.resource.history import HISTORY_PREFIX

# Virtual mounts the workspace synthesizes; the sandbox has its own.
SYSTEM_MOUNTS: frozenset[str] = frozenset({"/dev", HISTORY_PREFIX})

# The in-sandbox `mirage mount add` reads its spec from this variable;
# the spec travels in the exec environment, never on disk or argv.
MOUNT_SPEC_ENV = "MIRAGE_MOUNT_SPEC"

# Where the workspace lands when neither the caller nor the provider
# resolves a root.
DEFAULT_WORKSPACE_ROOT = "/workspace"

# Providers whose exec API has no stdin stream (Daytona, e2b) upload
# piped bytes here and redirect them into the line.
STDIN_PATH = "/tmp/.mirage_stdin"

# Docker boots this when no image is configured.
DOCKER_DEFAULT_IMAGE = "python:3.12-slim"

DOCKER_CLI_HINT = ("the docker runtime needs the docker CLI on PATH "
                   "(Docker Desktop, colima, or a podman alias)")


def sdk_install_hint(name: str) -> str:
    """The message shown when a provider SDK extra is missing.

    Args:
        name (str): the runtime name, which is also its pip extra
            (daytona, e2b).
    """
    return (f"the {name} runtime needs the {name} SDK; install with: "
            f"pip install mirage-ai[{name}]")
