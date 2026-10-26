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

import re

from mirage.rs.glob import Glob, glob_matcher

QUOTED_CHARS = {chr(0xFDD0 + i): ch for i, ch in enumerate("*?[@+!()|")}
EXTGLOB_RE = re.compile(r"[@?*+!]\(")


def pattern_shape(pattern: str) -> str:
    """Replace extended groups with wildcards for word classification.

    Args:
        pattern (str): shell word with quoting sentinels intact.
    """
    if not EXTGLOB_RE.search(pattern):
        return pattern
    glob = Glob(pattern, True)
    try:
        return glob.shape()
    finally:
        glob.close()


def pattern_parts(pattern: str) -> list[str]:
    """Split a pathname around slashes outside extended groups.

    Args:
        pattern (str): pathname with quoting sentinels intact.
    """
    if not EXTGLOB_RE.search(pattern):
        return pattern.split("/")
    glob = Glob(pattern, True)
    try:
        return glob.parts()
    finally:
        glob.close()


def fnmatch(
    name: str, pattern: str, *, extglob: bool = False, period: bool = False
) -> bool:
    """Match a case-sensitive shell pattern.

    Args:
        name (str): subject text.
        pattern (str): shell pattern with quoting sentinels intact.
        extglob (bool): recognize extended pattern groups.
        period (bool): require an explicit initial pathname dot.
    """
    return glob_matcher(pattern, extglob, period).matches(name)


def fnmatchcase(name: str, pattern: str) -> bool:
    """Match Python's fnmatchcase dialect, including literal class carets.

    Args:
        name (str): subject text.
        pattern (str): Python fnmatchcase pattern.
    """
    return glob_matcher(pattern, dialect="python").matches(name)
