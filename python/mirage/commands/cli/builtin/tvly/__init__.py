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

# The tvly program tree follows tvly 1.0.2's src/program.ts verb for
# verb (MIT; see licenses/third_party/tavily-cli.txt). Its setup verbs
# (`init`, `login`, `logout`, `setup mcp`, `set-default`, `update`) and
# the interactive shell change the machine tvly runs on, which a
# workspace has none of, so they are out of scope; the install carries
# the key. Install with a TavilyConfig.

from functools import partial

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.auth import auth
from mirage.commands.cli.builtin.tvly.extract import extract
from mirage.commands.cli.builtin.tvly.failure import guarded
from mirage.commands.cli.builtin.tvly.research import research
from mirage.commands.cli.builtin.tvly.search import (
    SEARCH_FLAGS,
    SearchFlag,
    search,
)
from mirage.commands.cli.builtin.tvly.site import crawl, map_site
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.core.tavily.config import TavilyConfig

JSON_FLAG = Argument(
    "--json",
    action="store_true",
    help="Output as JSON (for agents and scripts)",
)
OUTPUT = Argument(
    "-o",
    "--output",
    type="path",
    nargs="?",
    metavar="file",
    help="Save the full JSON response to this file. With no value, save "
    "it under .tavily/ with a generated name.",
)
CLIENT_NAME = Argument(
    "--client-name",
    metavar="name",
    env="TAVILY_CLIENT_NAME",
    help="Set optional client_name for request attribution.",
)
TIMEOUT = Argument(
    "--timeout",
    metavar="seconds",
    help="Max wait time in seconds (10-150).",
)
EXTRACT_DEPTH = Argument(
    "--extract-depth",
    metavar="depth",
    help="Extraction depth: basic or advanced.",
)
FORMAT = Argument(
    "--format", metavar="format", help="Output format: markdown or text."
)
INCLUDE_IMAGES = Argument(
    "--include-images", action="store_true", help="Include image URLs."
)


def _search_argument(flag: SearchFlag) -> Argument:
    if flag.kind == "switch":
        return Argument(flag.flag, action="store_true", help=flag.help)
    if flag.kind == "optional":
        return Argument(flag.flag, nargs="?", metavar="value", help=flag.help)
    metavar = {"list": "list", "integer": "n", "number": "n"}
    return Argument(
        flag.flag, metavar=metavar.get(flag.kind, "value"), help=flag.help
    )


def _site_arguments(verb: str, limit_help: str) -> tuple[Argument, ...]:
    guide = "the crawler" if verb == "crawl" else "URL discovery"
    return (
        Argument(
            "--max-depth",
            metavar="n",
            help=f"Levels deep to {verb} (1-5, default: 1).",
        ),
        Argument(
            "--max-breadth", metavar="n", help="Links per page (default: 20)."
        ),
        Argument("--limit", metavar="n", help=limit_help),
        Argument(
            "--instructions",
            metavar="text",
            help=f"Natural language guidance for {guide}.",
        ),
    )


SITE_FILTERS = (
    Argument(
        "--select-paths",
        metavar="patterns",
        help="Comma-separated regex patterns for paths to include.",
    ),
    Argument(
        "--exclude-paths",
        metavar="patterns",
        help="Comma-separated regex patterns for paths to exclude.",
    ),
    Argument(
        "--select-domains",
        metavar="patterns",
        help="Comma-separated regex patterns for domains to include.",
    ),
    Argument(
        "--exclude-domains",
        metavar="patterns",
        help="Comma-separated regex patterns for domains to exclude.",
    ),
    Argument(
        "--allow-external",
        action="store_true",
        help="Include external domain links.",
    ),
    Argument(
        "--no-external",
        action="store_true",
        help="Leave out external domain links.",
    ),
    TIMEOUT,
)

TVLY = CLI(
    spec=CommandSpec(
        name="tvly",
        description="Tavily CLI: search, extract, crawl, map, and research "
        "from the command line.",
        usage_style=UsageStyle.COMMANDER,
        arguments=(JSON_FLAG,),
        subcommands=(
            CommandSpec(
                name="auth",
                description="Check authentication status.",
                arguments=(JSON_FLAG,),
            ),
            CommandSpec(
                name="search",
                description="Search the web using Tavily.",
                arguments=(
                    Argument(
                        "queries",
                        nargs="*",
                        help="One or more search queries (up to 5), run in "
                        "parallel with the same options. Use - to read a "
                        "single query from stdin.",
                    ),
                    *(_search_argument(flag) for flag in SEARCH_FLAGS),
                    Argument(
                        "--max-chars",
                        metavar="n",
                        help="Characters of each result's content to print "
                        "(default 600, shared across queries: 300 each for "
                        "2, 200 for 3); 0 prints it whole. --json and -o "
                        "files keep it whole.",
                    ),
                    OUTPUT,
                    CLIENT_NAME,
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="extract",
                description="Extract content from one or more URLs.",
                arguments=(
                    Argument(
                        "urls", nargs="*", help="URLs to extract (max 20)."
                    ),
                    Argument(
                        "--query",
                        metavar="query",
                        help="Rerank chunks by relevance to this query.",
                    ),
                    Argument(
                        "--chunks-per-source",
                        metavar="n",
                        help="Chunks per source (1-5, requires --query).",
                    ),
                    EXTRACT_DEPTH,
                    FORMAT,
                    INCLUDE_IMAGES,
                    Argument(
                        "--timeout",
                        metavar="seconds",
                        help="Max wait time in seconds (1-60).",
                    ),
                    OUTPUT,
                    CLIENT_NAME,
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="crawl",
                description="Crawl a website starting from URL.",
                arguments=(
                    Argument(
                        "url",
                        nargs="*",
                        help="Where to start; returns full content for each "
                        "discovered page.",
                    ),
                    *_site_arguments(
                        "crawl", "Total pages cap (default: 50)."
                    ),
                    Argument(
                        "--chunks-per-source",
                        metavar="n",
                        help="Chunks per page (1-5, requires --instructions).",
                    ),
                    EXTRACT_DEPTH,
                    FORMAT,
                    *SITE_FILTERS,
                    Argument(
                        "--include-images",
                        action="store_true",
                        help="Include images.",
                    ),
                    Argument(
                        "--output-dir",
                        type="path",
                        metavar="dir",
                        help="Save each page as a .md file in this directory.",
                    ),
                    OUTPUT,
                    CLIENT_NAME,
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="map",
                description="Discover all URLs on a website (no content "
                "extraction).",
                arguments=(
                    Argument(
                        "url",
                        nargs="*",
                        help="Where to start; returns the URLs found.",
                    ),
                    *_site_arguments(
                        "map", "Maximum URLs to discover (default: 50)."
                    ),
                    *SITE_FILTERS,
                    OUTPUT,
                    CLIENT_NAME,
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="research",
                description="Deep research: run a task, or check one with "
                "`research status <id>` or wait for it with `research poll "
                "<id>`.",
                arguments=(
                    Argument(
                        "words",
                        nargs="*",
                        metavar="query",
                        help='The research topic, or "status"/"poll" and a '
                        'request ID. Use "-" to read the topic from stdin.',
                    ),
                    Argument(
                        "--model",
                        metavar="model",
                        help="Research model: mini, pro or auto (default).",
                    ),
                    Argument(
                        "--no-wait",
                        action="store_true",
                        help="Return request_id immediately without waiting.",
                    ),
                    Argument(
                        "--stream",
                        action="store_true",
                        help="Stream results in real-time.",
                    ),
                    Argument(
                        "--output-schema",
                        type="path",
                        metavar="file",
                        help="Path to JSON schema file for structured output.",
                    ),
                    Argument(
                        "--citation-format",
                        metavar="format",
                        help="Citation format: numbered, mla, apa or chicago.",
                    ),
                    OUTPUT,
                    Argument(
                        "--poll-interval",
                        metavar="n",
                        help="Seconds between status checks (default: 10).",
                    ),
                    Argument(
                        "--timeout",
                        metavar="n",
                        help="Max seconds to wait (default: 600).",
                    ),
                    CLIENT_NAME,
                    JSON_FLAG,
                ),
            ),
        ),
    ),
    handlers={
        "auth": CLIHandler(fn=partial(guarded, auth)),
        "search": CLIHandler(
            fn=partial(guarded, search), write_when=("--output",)
        ),
        "extract": CLIHandler(
            fn=partial(guarded, extract), write_when=("--output",)
        ),
        "crawl": CLIHandler(
            fn=partial(guarded, crawl),
            write_when=("--output", "--output-dir"),
        ),
        "map": CLIHandler(
            fn=partial(guarded, map_site), write_when=("--output",)
        ),
        "research": CLIHandler(
            fn=partial(guarded, research), write_when=("--output",)
        ),
    },
    config_model=TavilyConfig,
    accessor=TavilyAccessor,
)
