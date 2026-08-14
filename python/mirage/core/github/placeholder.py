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

from mirage.core.github.config import GhConfig
from mirage.core.github.repo import parse_repo

PLACEHOLDER_RE = re.compile(r"\{(owner|repo|branch)\}")
EXPAND_ERROR = "unable to expand placeholder in path"


def _value(name: str, config: GhConfig) -> str:
    """One placeholder's expansion from the install.

    Args:
        name (str): the placeholder word, without braces.
        config (GhConfig): the install's configuration.

    Returns:
        str: what the placeholder stands for.

    Raises:
        ValueError: the install carries nothing to expand it to.
    """
    if name == "branch":
        if not config.branch:
            raise ValueError(f"{EXPAND_ERROR}: no `branch` on the install")
        return config.branch
    if not config.repo:
        raise ValueError(f"{EXPAND_ERROR}: no `repo` on the install")
    ref = parse_repo(config.repo)
    return ref.owner if name == "owner" else ref.repo


def expand(text: str, config: GhConfig) -> str:
    """Expand gh's repository placeholders in an endpoint or field value.

    Real gh fills `{owner}`, `{repo}` and `{branch}` from the repository of
    the current directory, which is what most of its own documented
    examples are written with (`gh api repos/{owner}/{repo}/releases`); an
    install's `repo`/`branch` are the workspace's stand-in for that. Any
    other brace pair is left exactly as typed and reaches the wire, which
    is gh's behavior too: it is a path segment, not a template error.

    Args:
        text (str): the endpoint path or field value as typed.
        config (GhConfig): the install's configuration.

    Returns:
        str: the text with the three known placeholders expanded.

    Raises:
        ValueError: a known placeholder has nothing to expand to.
    """
    if "{" not in text:
        return text
    return PLACEHOLDER_RE.sub(lambda m: _value(m.group(1), config), text)
