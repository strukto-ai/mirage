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


def normalize(raw: str | None) -> str:
    """Normalize a key prefix.

    Args:
        raw: The raw prefix string, or None.

    Returns:
        Empty string if input was None/empty; otherwise the prefix with
        leading slashes stripped and a trailing slash ensured.
    """
    if not raw:
        return ""
    v = raw.lstrip("/")
    return v if v.endswith("/") else v + "/"


def apply(prefix: str, path: str) -> str:
    """Prepend a normalized prefix to a virtual path.

    Args:
        prefix: A normalized prefix (use ``normalize()`` first if unsure).
        path: The virtual path to scope.

    Returns:
        The backend key: ``prefix + path`` with the leading slash of
        ``path`` stripped.
    """
    return prefix + path.lstrip("/")


def apply_dir(prefix: str, path: str) -> str:
    """Same as ``apply()`` but guarantees a trailing slash for LIST-style ops.

    Args:
        prefix: A normalized prefix.
        path: The virtual path to scope.

    Returns:
        The backend key with a trailing slash, suitable for use as a LIST
        ``Prefix`` argument.
    """
    key = apply(prefix, path)
    return key if not key or key.endswith("/") else key + "/"


def strip(prefix: str, key: str) -> str:
    """Strip a normalized prefix from a backend-returned key.

    Args:
        prefix: A normalized prefix.
        key: The backend-returned key.

    Returns:
        The key with the prefix removed if present; otherwise unchanged.
    """
    return key[len(prefix):] if prefix and key.startswith(prefix) else key


def strip_mount(virtual: str, prefix: str) -> str:
    """Remove a mount prefix from a virtual path at a path boundary.

    A sibling that only shares the prefix as a string (``/database`` vs a
    ``/data`` prefix) is left untouched.

    Args:
        virtual (str): An absolute virtual path.
        prefix (str): The mount prefix (e.g. ``/data``), without a trailing
            slash.

    Returns:
        The mount-relative path with its leading slash kept.

    Example::

        strip_mount("/data/sub/x.txt", "/data")   -> "/sub/x.txt"
        strip_mount("/database/x.txt", "/data")    -> "/database/x.txt"
        strip_mount("/data", "/data")              -> "/"
        strip_mount("/x.txt", "")                  -> "/x.txt"
    """
    if prefix and virtual.startswith(prefix):
        rest = virtual[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            return rest or "/"
    return virtual


def mount_key(virtual: str, prefix: str) -> str:
    """Backend key for a virtual path under a mount prefix.

    Args:
        virtual (str): An absolute virtual path.
        prefix (str): The mount prefix.

    Returns:
        The mount-relative path with surrounding slashes stripped.

    Example::

        mount_key("/data/sub/x.txt", "/data")   -> "sub/x.txt"
        mount_key("/data", "/data")             -> ""
        mount_key("/x.txt", "")                 -> "x.txt"
    """
    return strip_mount(virtual, prefix).strip("/")


def rekey(parent_original: str, parent_key: str, child: str) -> str:
    """Backend key for a child virtual path, derived from its parent.

    A child shares the parent's mount prefix, so its key is the child
    virtual path with the same prefix removed. The prefix length is
    recovered from the parent's ``original``/``key`` pair, so no mount
    context is needed.

    Args:
        parent_original (str): The parent's absolute virtual path.
        parent_key (str): The parent's backend key.
        child (str): The child's absolute virtual path.

    Returns:
        The child's backend key (surrounding slashes stripped).

    Example::

        rekey("/data/sub", "sub", "/data/sub/x.txt")   -> "sub/x.txt"
        rekey("/data", "", "/data/x.txt")              -> "x.txt"
    """
    prefix_len = len(parent_original.rstrip("/")) - len(parent_key)
    return child[prefix_len:].strip("/")


def mount_prefix_of(virtual: str, resource_path: str) -> str:
    """Recover a mount prefix from a virtual path and its backend key.

    The inverse of stamping: given a path's virtual form and the key the
    mount stamped, return the mount prefix that was stripped off. Used by
    commands (e.g. ``find``) that must map backend keys back to virtual
    paths for display.

    Args:
        virtual (str): An absolute virtual path.
        resource_path (str): Its backend key (mount-relative, slashless).

    Returns:
        The mount prefix without a trailing slash.

    Example::

        mount_prefix_of("/data/sub", "sub")   -> "/data"
        mount_prefix_of("/data", "")           -> "/data"
        mount_prefix_of("/x.txt", "x.txt")     -> ""
    """
    prefix_len = len(virtual.rstrip("/")) - len(resource_path)
    return virtual[:prefix_len].rstrip("/")
