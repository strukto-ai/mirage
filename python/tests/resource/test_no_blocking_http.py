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

import ast
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "mirage"

# Blocking HTTP clients. `urlopen` was the last one in the package: it
# lived in core/github/_client.py because GitHubResource.__init__ had to
# fetch the repo tree and a constructor cannot await. The fetch moved to
# the async `BaseResource.build` factory, so nothing needs it any more.
# aiohttp / httpx.AsyncClient are the supported way to reach a network.
BLOCKING = {
    "urllib.request": {"urlopen", "urlretrieve"},
    "requests": {"get", "post", "put", "delete", "patch", "head", "request"},
}


def _imported_blocking_names(tree: ast.Module) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            banned = BLOCKING.get(node.module or "", set())
            found |= {
                a.asname or a.name
                for a in node.names if a.name in banned
            }
        elif isinstance(node, ast.Import):
            found |= {
                a.asname or a.name
                for a in node.names if a.name in BLOCKING
            }
    return found


def test_no_blocking_http_client_in_the_package() -> None:
    # A blocking call inside a resource constructor freezes whatever event
    # loop the caller is on — for the daemon, every other mount's in-flight
    # I/O and the FUSE queue. Async-native by default is a CLAUDE.md rule;
    # this is the gate for it.
    offenders: list[str] = []
    for path in sorted(SOURCE.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = _imported_blocking_names(tree)
        if names:
            rel = path.relative_to(SOURCE)
            offenders.append(f"{rel}: {', '.join(sorted(names))}")
    assert offenders == [], (
        "blocking HTTP client imported under mirage/; use aiohttp and do "
        "the call in an async factory (BaseResource.build) instead:\n  " +
        "\n  ".join(offenders))
