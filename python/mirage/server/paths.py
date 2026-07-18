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
import re
from pathlib import Path

from mirage.server.env import ENV_HOME

_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _absolute(value: str | Path) -> Path:
    return Path(os.path.abspath(value))


def mirage_home() -> Path:
    """Resolve the base directory backing the ``.mirage`` data tree.

    Priority: ``$MIRAGE_HOME`` if set, else ``~/.mirage``. A relative
    override is absolutized against the current working directory so
    the daemon and later CLI invocations agree on one location.

    Returns:
        Path: absolute base directory for the pid file, log file,
            auth token, config, repos, and snapshots.
    """
    override = os.environ.get(ENV_HOME)
    return _absolute(override) if override else Path.home() / ".mirage"


def pid_file_path(explicit: str | Path | None = None) -> Path:
    """Resolve the daemon pid file location.

    Priority: ``explicit`` argument, then ``daemon.pid`` under
    :func:`mirage_home`. There is deliberately no per-path env or
    config key: like docker's ``data-root`` and git's ``GIT_DIR``, the
    home is the single configurable root and its layout is fixed.

    Args:
        explicit (str | Path | None): caller-supplied override.

    Returns:
        Path: the resolved absolute pid file path.
    """
    if explicit is not None:
        return _absolute(explicit)
    return mirage_home() / "daemon.pid"


def version_root_path(explicit: str | Path | None = None) -> Path:
    """Resolve the git repos root.

    Priority: ``explicit`` argument, then ``repos`` under
    :func:`mirage_home`.

    Args:
        explicit (str | Path | None): caller-supplied override.

    Returns:
        Path: the resolved absolute repos root.
    """
    if explicit is not None:
        return _absolute(explicit)
    return mirage_home() / "repos"


def state_root_path(explicit: str | Path | None = None) -> Path:
    """Resolve the live-state (disk store) root.

    Priority: ``explicit`` argument, then ``state`` under
    :func:`mirage_home`.

    Args:
        explicit (str | Path | None): caller-supplied override.

    Returns:
        Path: the resolved absolute state root.
    """
    if explicit is not None:
        return _absolute(explicit)
    return mirage_home() / "state"


def snapshot_root_path(explicit: str | Path | None = None) -> Path:
    """Resolve the snapshot root.

    Priority: ``explicit`` argument, then ``snapshots`` under
    :func:`mirage_home`.

    Args:
        explicit (str | Path | None): caller-supplied override.

    Returns:
        Path: the resolved absolute snapshot root.
    """
    if explicit is not None:
        return _absolute(explicit)
    return mirage_home() / "snapshots"


class PathOutsideRootError(Exception):
    pass


def resolve_within_root(root: str | Path, user_path: str) -> Path:
    """Resolve user_path against root and assert it stays within root.

    Args:
        root (str | Path): the trusted directory paths are confined to.
        user_path (str): a request-supplied path, relative or absolute.

    Returns:
        Path: the resolved absolute path, guaranteed to be root itself
            or a descendant of root.
    """
    resolved_root = os.path.realpath(str(root))
    joined = os.path.join(resolved_root, user_path)
    # Normalize with a trailing separator so one plain startswith covers
    # both the root itself and descendants: a bare `x.startswith(prefix)`
    # on the normalized value is the guard shape static analyzers
    # recognize as a path-injection barrier (compound conditions and
    # commonpath are not).
    resolved = os.path.realpath(joined) + os.sep
    if not resolved.startswith(resolved_root + os.sep):
        raise PathOutsideRootError(
            f"path escapes the configured root: {user_path}")
    return Path(resolved.rstrip(os.sep) or os.sep)


def validate_path_segment(segment: str) -> str:
    """Assert segment is a single safe path component.

    Args:
        segment (str): a request-supplied identifier used as one path
            component (no separators, not . or ..).

    Returns:
        str: the validated segment.
    """
    if segment in (".", "..") or _SAFE_SEGMENT_RE.match(segment) is None:
        raise PathOutsideRootError(f"invalid path segment: {segment}")
    return segment
