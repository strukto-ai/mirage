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

import asyncio
import sys
from pathlib import Path

from mcp_to_cli import check_names, fetch_tools, fill, parser, server_from_args

# Turns any MCP server into a Mirage virtual CLI: the same commands and
# JSON input as the real CLI mcp_to_cli.py writes, as a module exporting
# a `CLI` a workspace installs:
#
#   python mcp_to_mirage.py --name grafana --out grafana_cli.py \
#       -- docker run --rm -i -e GRAFANA_URL mcp/grafana -t stdio
#   ws.register_cli("grafana", GRAFANA, {"env": {"GRAFANA_URL": "..."}})
#
# or, from workspace YAML:
#
#   clis:
#     grafana:
#       cli: ./grafana_cli.py:GRAFANA
#       config:
#         env: {GRAFANA_URL: "${GRAFANA_URL}"}

TEMPLATE = Path(__file__).with_name("mirage_cli.py.tmpl").read_text()


def main() -> None:
    args = parser(
        "mcp_to_mirage", "Generate a Mirage CLI from an MCP server."
    ).parse_args()
    server = server_from_args(args)
    tools = asyncio.run(fetch_tools(server))
    check_names(tools)
    Path(args.out).write_text(fill(TEMPLATE, args.name, server, tools))
    print(f"wrote {args.out} with {len(tools)} commands", file=sys.stderr)


if __name__ == "__main__":
    main()
