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


def normalize(raw: str | None) -> str:
    """Normalize a key prefix.

    The one rule every object-key backend applies, on both hosts:
    leading slashes go and one trailing slash is ensured. A prefix that
    is empty once its leading slashes are gone (``""``, ``"/"``) is no
    prefix at all, so a root-spelled prefix never puts a slash in front
    of every key.

    Args:
        raw (str | None): The raw prefix string, or None.

    Returns:
        str: ``""`` for no prefix, else the prefix with leading slashes
        stripped and a trailing slash ensured.
    """
    v = (raw or "").lstrip("/")
    if not v:
        return ""
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
    return key[len(prefix) :] if prefix and key.startswith(prefix) else key


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
        rest = virtual[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            return rest or "/"
    return virtual


def under_path(candidate: str, root: str) -> bool:
    """Whether ``candidate`` is ``root`` itself or sits below it.

    A boundary-aware prefix test, so a sibling that merely shares the
    string (``/data/xy`` against ``/data/x``) is not counted. Both sides
    are compared without a trailing slash, because a backend may have
    keyed a directory either way.

    Args:
        candidate (str): An absolute virtual path.
        root (str): The subtree root, absolute.

    Example::

        under_path("/data/x/y", "/data/x")   -> True
        under_path("/data/x", "/data/x/")    -> True
        under_path("/data/xy", "/data/x")    -> False
    """
    base = root.rstrip("/")
    if not base:
        return True
    stem = candidate.rstrip("/")
    return stem == base or candidate.startswith(base + "/")


def outermost(paths: list[PathSpec]) -> list[PathSpec]:
    """The paths no other path of the list sits below, in their order.

    Args:
        paths (list[PathSpec]): the paths.

    Example::

        outermost(["/d/s", "/d", "/e"])  -> ["/d", "/e"]
    """
    roots: list[str] = []
    for virtual in sorted(p.virtual.rstrip("/") + "/" for p in paths):
        if not roots or not virtual.startswith(roots[-1]):
            roots.append(virtual)
    kept = set(roots)
    return [path for path in paths if path.virtual.rstrip("/") + "/" in kept]


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


def mount_prefix_of(virtual: str, vfs_path: str) -> str:
    """Recover a mount prefix from a virtual path and its backend key.

    The inverse of stamping: given a path's virtual form and the key the
    mount stamped, return the mount prefix that was stripped off. Used by
    commands (e.g. ``find``) that must map backend keys back to virtual
    paths for display.

    Args:
        virtual (str): An absolute virtual path.
        vfs_path (str): Its backend key (mount-relative, slashless).

    Returns:
        The mount prefix without a trailing slash.

    Example::

        mount_prefix_of("/data/sub", "sub")   -> "/data"
        mount_prefix_of("/data", "")           -> "/data"
        mount_prefix_of("/x.txt", "x.txt")     -> ""
    """
    prefix_len = len(virtual.rstrip("/")) - len(vfs_path)
    return virtual[:prefix_len].rstrip("/")


def mounted_path(root: PathSpec, mount_path: str) -> PathSpec:
    """A PathSpec for a mount-local key, addressed like ``root``.

    Rebuilds the virtual path from the mount prefix ``root`` sits behind,
    so a backend holding only a key (an ancestor it walked to, say) can
    name it the way the user would see it. Mirrors TS ``mountedPath``.

    Args:
        root (PathSpec): Any operand on the same mount, read for its
            prefix.
        mount_path (str): The mount-local key to address.
    """
    prefix = mount_prefix_of(root.virtual, root.vfs_path)
    virtual = prefix + mount_path if prefix else mount_path
    return PathSpec.from_str_path(virtual, mount_path.strip("/"))


def key_path(root: PathSpec, key_prefix: str, key: str) -> PathSpec:
    """The path a backend key under ``key_prefix`` names, addressed like ``root``.

    Args:
        root (PathSpec): Any operand on the same mount, read for its
            prefix.
        key_prefix (str): The mount's backend key prefix.
        key (str): The backend key, prefix included.
    """
    return mounted_path(root, "/" + strip(key_prefix, key).lstrip("/"))


def child_spec(spec: PathSpec, name: str) -> PathSpec:
    """The path of ``name`` inside the directory ``spec``, on its mount.

    Args:
        spec (PathSpec): the directory.
        name (str): the child's bare name.
    """
    base = spec.virtual.rstrip("/")
    key = spec.vfs_path.rstrip("/")
    return PathSpec(
        virtual=f"{base}/{name}",
        directory=spec.virtual,
        vfs_path=f"{key}/{name}" if key else name,
    )
