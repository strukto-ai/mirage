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

from mirage.types import HiddenPaths, HiddenVars
from mirage.utils.fnmatch import fnmatch


def _norm_abs(path: str) -> str:
    """One absolute spelling for a path, no trailing slash.

    Args:
        path (str): a virtual path or hidden-spec entry.
    """
    stripped = path.strip("/")
    return "/" + stripped if stripped else "/"


def path_hidden(hidden: HiddenPaths | None, virtual: str) -> bool:
    """Whether the session's spec hides this virtual path.

    The two planes of the spec, in the order they cost: an exact entry
    hides the path and its whole subtree (prefix containment, no
    globbing); a component pattern (no ``/``) hides any path carrying a
    matching name segment, which covers the subtree below a matching
    directory for free; an anchored pattern (contains ``/``) is tested
    against the path and each of its ancestors, so a directory the
    pattern hides keeps its descendants hidden too. Patterns match with
    the repo fnmatch dialect, ``*`` crossing slashes as GNU ``find
    -path`` does.

    Args:
        hidden (HiddenPaths | None): the session's spec, None means
            unrestricted.
        virtual (str): absolute virtual path to test.
    """
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return False
    norm = _norm_abs(virtual)
    for entry in hidden.paths:
        p = _norm_abs(entry)
        if norm == p or norm.startswith(p + "/") or p == "/":
            return True
    if not hidden.patterns:
        return False
    component_pats = [p for p in hidden.patterns if "/" not in p]
    anchored_pats = [_norm_abs(p) for p in hidden.patterns if "/" in p]
    parts = [seg for seg in norm.split("/") if seg]
    if component_pats:
        for seg in parts:
            for pat in component_pats:
                if fnmatch(seg, pat):
                    return True
    if anchored_pats:
        prefix = ""
        for seg in parts:
            prefix = f"{prefix}/{seg}"
            for pat in anchored_pats:
                if fnmatch(prefix, pat):
                    return True
    return False


def var_hidden(hidden: HiddenVars | None, name: str) -> bool:
    """Whether the session's spec hides this variable name.

    Args:
        hidden (HiddenVars | None): the session's spec, None means
            unrestricted.
        name (str): variable name to test.
    """
    if hidden is None:
        return False
    if name in hidden.names:
        return True
    for pat in hidden.patterns:
        if fnmatch(name, pat):
            return True
    return False
