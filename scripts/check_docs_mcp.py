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
import argparse
import json
import sys
import urllib.error
import urllib.request

DOCS_CONFIG = "docs/docs.json"
ENDPOINT = "https://docs.mirage.strukto.ai/mcp"
KNOWN_PAGE = "/home/install.mdx"
KNOWN_PAGE_HEADING = "# Installation"
KNOWN_PAGE_URL = "https://docs.mirage.strukto.ai/home/install"


def call_tool(name: str, arguments: dict) -> dict:
    """POST a tools/call request and return the parsed MCP result.

    Args:
        name (str): MCP tool name.
        arguments (dict): tool arguments.

    Returns:
        dict: the JSON-RPC "result" object.
    """
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments
        },
    }).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode()
    for line in raw.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].strip())["result"]
    return json.loads(raw)["result"]


def main() -> int:
    """Run the retrieval and search checks against the live endpoint.

    Returns:
        int: process exit code.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-only", action="store_true")
    args = parser.parse_args()

    if args.config_only:
        with open(DOCS_CONFIG, encoding="utf-8") as config_file:
            config = json.load(config_file)
        options = config.get("contextual", {}).get("options", [])
        if "mcp" not in options:
            print(f"FAIL: {DOCS_CONFIG} does not enable contextual MCP",
                  file=sys.stderr)
            return 1
        print(f"OK: {DOCS_CONFIG} enables contextual MCP")
        return 0

    try:
        retrieval = call_tool(
            "query_docs_filesystem_mirage",
            {"command": f"head -3 {KNOWN_PAGE}"},
        )
    except urllib.error.URLError as exc:
        print(f"FAIL: could not reach {ENDPOINT}: {exc}", file=sys.stderr)
        return 1

    retrieved_text = retrieval["content"][0]["text"]
    if KNOWN_PAGE_HEADING not in retrieved_text:
        print(f"FAIL: {KNOWN_PAGE} missing {KNOWN_PAGE_HEADING!r}:",
              file=sys.stderr)
        print(retrieved_text, file=sys.stderr)
        return 1

    search = call_tool("search_mirage", {"query": "install mirage"})
    search_text = "\n".join(block["text"] for block in search["content"])
    if KNOWN_PAGE_URL not in search_text:
        print(f"FAIL: search missing link {KNOWN_PAGE_URL}:", file=sys.stderr)
        print(search_text, file=sys.stderr)
        return 1

    print(f"OK: retrieved {KNOWN_PAGE} and search found {KNOWN_PAGE_URL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
