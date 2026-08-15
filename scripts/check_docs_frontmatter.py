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

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FENCE = "---"


def frontmatter(text: str) -> str | None:
    """The raw YAML between the opening and closing ``---`` fences.

    Args:
        text (str): Full contents of an ``.mdx`` page.

    Returns:
        str | None: The fence body, or None when the page opens with no
        fence or never closes the one it opened.
    """
    if not text.startswith(f"{FENCE}\n"):
        return None
    end = text.find(f"\n{FENCE}", len(FENCE))
    if end == -1:
        return None
    return text[len(FENCE) + 1:end]


def check(path: Path) -> str | None:
    """Parse one page's frontmatter the way the docs builder does.

    Args:
        path (Path): Absolute path to an ``.mdx`` page.

    Returns:
        str | None: A one-line reason the page would fail the build, or
        None when it parses as a mapping.
    """
    body = frontmatter(path.read_text())
    if body is None:
        return "no frontmatter block"
    try:
        parsed = yaml.safe_load(body)
    except yaml.YAMLError as exc:
        # An unquoted value holding ": " is the one that keeps recurring:
        # YAML reads it as a nested mapping key and the build stops.
        return str(exc).split("\n")[0].strip()
    if not isinstance(parsed, dict):
        return f"frontmatter is {type(parsed).__name__}, expected a mapping"
    return None


def main() -> int:
    pages = sorted(DOCS.rglob("*.mdx"))
    if not pages:
        print(f"docs frontmatter check FAILED\n\nno .mdx pages under {DOCS}")
        return 1

    failures = [(p, reason) for p in pages if (reason := check(p)) is not None]
    if failures:
        print("docs frontmatter check FAILED\n")
        for path, reason in failures:
            print(f"{path.relative_to(ROOT)}: {reason}")
        print(f"\n{len(failures)} page(s) the docs build cannot parse")
        return 1

    print(f"docs frontmatter OK: {len(pages)} pages parse")
    return 0


if __name__ == "__main__":
    sys.exit(main())
