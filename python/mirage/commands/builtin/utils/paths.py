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

from mirage.types import PathSpec
from mirage.utils.path import resolve_path


def resolve_script(name: str, cwd: PathSpec | None) -> PathSpec:
    """Resolve a script operand to a fully-resolved PathSpec.

    Args:
        name (str): the script path as typed, absolute or cwd-relative.
        cwd (PathSpec | None): the session working directory injected by
            the dispatcher; None resolves against the root.
    """
    path = resolve_path(name, cwd.virtual if cwd is not None else "/")
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(resource_path=path.strip("/"),
                    virtual=path,
                    directory=directory,
                    resolved=True)


def default_paths(paths: list[PathSpec],
                  cwd: PathSpec | None) -> list[PathSpec]:
    """Default a command's path operands the way the shell would.

    Args:
        paths (list[PathSpec]): operands as parsed; returned untouched
            when non-empty.
        cwd (PathSpec | None): the session working directory injected by
            the dispatcher, used when no operand was given.
    """
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(resource_path="", virtual="/", directory="/")]
