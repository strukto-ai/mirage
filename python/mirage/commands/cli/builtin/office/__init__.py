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

from mirage.commands.cli.builtin.office.run import run_command
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec

# Descriptions and argument help as OfficeCLI 1.0.161 (iOfficeAI,
# Apache-2.0) prints them; mirage serves its .xlsx commands and reads
# .docx and .pptx files.
FILE = Argument(
    "FILE",
    type="path",
    metavar="file",
    help="Office document path (required even with open/close mode)",
)

JSON_FLAG = Argument(
    "--json",
    action="store_true",
    help="Output as JSON (AI-friendly)",
)

OFFICE = CLI(
    spec=CommandSpec(
        name="office",
        description=(
            "office: AI-friendly CLI for Office documents "
            "(.docx, .xlsx, .pptx)"
        ),
        subcommands=(
            CommandSpec(
                name="create",
                description="Create a blank Office document",
                arguments=(
                    Argument(
                        "FILE",
                        type="path",
                        metavar="file",
                        help="Output file path (.docx, .xlsx, .pptx)",
                    ),
                    Argument(
                        "--force",
                        action="store_true",
                        help="Overwrite an existing file.",
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="get",
                description="Get a document node by path",
                arguments=(
                    FILE,
                    Argument(
                        "PATH",
                        nargs="?",
                        metavar="path",
                        help="DOM path [default: /]",
                    ),
                    Argument(
                        "--depth",
                        type="int",
                        metavar="depth",
                        help="Depth of child nodes to include [default: 1]",
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="query",
                description=(
                    "Query document elements with CSS-like selectors"
                ),
                arguments=(
                    FILE,
                    Argument(
                        "SELECTOR",
                        metavar="selector",
                        help=(
                            "CSS-like selector: element type, [attribute] "
                            "predicates with = != ~= > < >= <= and and/or, "
                            "'>' child combinator, ',' union, and a "
                            "positional [N]"
                        ),
                    ),
                    JSON_FLAG,
                    Argument(
                        "--find",
                        metavar="find",
                        help=(
                            "Filter results to elements containing this "
                            "text (case-insensitive substring)"
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="set",
                description="Modify a document node's properties",
                arguments=(
                    FILE,
                    Argument(
                        "PATH",
                        metavar="path",
                        help="DOM path to the element",
                    ),
                    Argument(
                        "--prop",
                        action="append",
                        metavar="prop",
                        help="Property to set (key=value)",
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="add",
                description="Add a new element to the document",
                arguments=(
                    FILE,
                    Argument(
                        "PARENT",
                        metavar="parent",
                        help=(
                            "Parent DOM path. Conventions per handler: docx "
                            "uses /body (or /body/p[N] for nested adds); "
                            "xlsx uses /Sheet1 (or any sheet name); pptx "
                            "slide uses '/' (slides hang off the "
                            "presentation root), pptx shape uses /slide[N]. "
                            "Wrap paths containing brackets in single "
                            "quotes for zsh: '/slide[1]'."
                        ),
                    ),
                    Argument(
                        "--type",
                        metavar="type",
                        help=(
                            "Element type to add (e.g. paragraph, run, "
                            "table, sheet, row, cell, slide, shape, "
                            "picture, diagram/flowchart, ole, video)"
                        ),
                    ),
                    Argument(
                        "--from",
                        metavar="from",
                        help=(
                            "Copy from an existing element path (e.g. "
                            "/slide[1]/shape[2])"
                        ),
                    ),
                    Argument(
                        "--index",
                        type="int",
                        metavar="index",
                        help=(
                            "Insert position (0-based). If omitted, "
                            "appends to end"
                        ),
                    ),
                    Argument(
                        "--after",
                        metavar="after",
                        help=(
                            "Insert after the element at this path (e.g. "
                            "p[@paraId=1A2B3C4D])"
                        ),
                    ),
                    Argument(
                        "--before",
                        metavar="before",
                        help="Insert before the element at this path",
                    ),
                    Argument(
                        "--prop",
                        action="append",
                        metavar="prop",
                        help=(
                            "Property to set (key=value, e.g. --prop "
                            "src=image.png --prop width=6in)"
                        ),
                    ),
                    JSON_FLAG,
                    Argument(
                        "--force",
                        action="store_true",
                        help="Force write even if document is protected",
                    ),
                ),
            ),
            CommandSpec(
                name="remove",
                description="Remove an element from the document",
                arguments=(
                    FILE,
                    Argument(
                        "PATH",
                        metavar="path",
                        help="DOM path of the element to remove",
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="move",
                description="Move an element to a new position or parent",
                arguments=(
                    FILE,
                    Argument(
                        "PATH",
                        metavar="path",
                        help="DOM path of the element to move",
                    ),
                    Argument(
                        "--to",
                        metavar="to",
                        help=(
                            "Target parent path. If omitted, reorders "
                            "within the current parent"
                        ),
                    ),
                    Argument(
                        "--index",
                        type="int",
                        metavar="index",
                        help=(
                            "Insert position (0-based) among the remaining "
                            "siblings after the element is detached — "
                            "moving p[1] to --index 2 in [P1,P2,P3,P4] "
                            "gives [P2,P3,P1,P4]. If omitted, appends to end"
                        ),
                    ),
                    Argument(
                        "--after",
                        metavar="after",
                        help="Move after the element at this path",
                    ),
                    Argument(
                        "--before",
                        metavar="before",
                        help="Move before the element at this path",
                    ),
                    Argument(
                        "--prop",
                        action="append",
                        metavar="prop",
                        help=(
                            "Property to set on the move (e.g. --prop "
                            "trackChange.author=Alice for tracked moves)"
                        ),
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="swap",
                description="Swap two elements in the document",
                arguments=(
                    Argument(
                        "FILE",
                        type="path",
                        metavar="file",
                        help="Office document path",
                    ),
                    Argument(
                        "PATH1",
                        metavar="path1",
                        help="DOM path of the first element",
                    ),
                    Argument(
                        "PATH2",
                        metavar="path2",
                        help="DOM path of the second element",
                    ),
                    JSON_FLAG,
                ),
            ),
            CommandSpec(
                name="batch",
                description=(
                    "Execute multiple commands from a JSON array in a "
                    "single pass"
                ),
                arguments=(
                    Argument(
                        "FILE",
                        type="path",
                        metavar="file",
                        help="Office document path",
                    ),
                    Argument(
                        "--input",
                        type="path",
                        metavar="input",
                        help=(
                            "JSON file containing batch commands. If "
                            "omitted, reads from stdin"
                        ),
                    ),
                    Argument(
                        "--commands",
                        metavar="commands",
                        help=(
                            "Inline JSON array of batch commands "
                            "(alternative to --input or stdin)"
                        ),
                    ),
                    Argument(
                        "--force",
                        action="store_true",
                        help=(
                            "Deprecated alias for the default "
                            "continue-on-error mode (kept for "
                            "compatibility)"
                        ),
                    ),
                    Argument(
                        "--stop-on-error",
                        action="store_true",
                        help=("Abort the batch as soon as any command fails"),
                    ),
                    Argument(
                        "--best-effort",
                        action="store_true",
                        help=(
                            "Apply the items that succeed even when others "
                            "fail. Default: any failure rolls back the "
                            "whole batch"
                        ),
                    ),
                    JSON_FLAG,
                ),
            ),
        ),
    ),
    handlers={
        "create": CLIHandler(fn=run_command, write=True),
        "get": CLIHandler(fn=run_command),
        "query": CLIHandler(fn=run_command),
        "set": CLIHandler(fn=run_command, write=True),
        "add": CLIHandler(fn=run_command, write=True),
        "remove": CLIHandler(fn=run_command, write=True),
        "move": CLIHandler(fn=run_command, write=True),
        "swap": CLIHandler(fn=run_command, write=True),
        "batch": CLIHandler(fn=run_command, write=True),
    },
)
