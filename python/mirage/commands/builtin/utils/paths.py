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


def has_unresolved_glob(paths: list[PathSpec]) -> bool:
    """True when any operand still carries a glob to expand.

    Backend push-down branches read ``paths[0]`` directly to build SQL, so
    they must not run before glob expansion: a pattern segment would be
    taken for a literal entity name, and ``tables/*/rows.jsonl`` would
    query a relation actually called ``*``.

    Args:
        paths (list[PathSpec]): operands as parsed.
    """
    return any(p.pattern for p in paths)


def resolve_script(name: str, cwd: PathSpec | str | None) -> PathSpec:
    """Resolve a script operand to a fully-resolved PathSpec.

    Args:
        name (str): the script path as typed, absolute or cwd-relative.
        cwd (PathSpec | str | None): the session working directory as
            ``CommandOpts.cwd`` carries it; None resolves against the
            root.
    """
    base = cwd.virtual if isinstance(cwd, PathSpec) else (cwd or "/")
    path = resolve_path(name, base)
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(resource_path=path.strip("/"),
                    virtual=path,
                    directory=directory,
                    resolved=True)


def default_paths(paths: list[PathSpec],
                  cwd: PathSpec | str | None) -> list[PathSpec]:
    """Default a command's path operands the way the shell would.

    Args:
        paths (list[PathSpec]): operands as parsed; returned untouched
            when non-empty.
        cwd (PathSpec | str | None): the session working directory as
            ``CommandOpts.cwd`` carries it; a plain string names a
            root-mounted directory.
    """
    if paths:
        return paths
    if isinstance(cwd, PathSpec):
        return [cwd]
    if isinstance(cwd, str) and cwd:
        return [
            PathSpec(resource_path=cwd.strip("/"), virtual=cwd, directory=cwd)
        ]
    return [PathSpec(resource_path="", virtual="/", directory="/")]
