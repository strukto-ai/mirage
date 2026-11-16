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

from mirage.commands.cli.builtin.pdf.run import run_pdfinfo, run_pdftotext
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec

FIRST = Argument("-f", metavar="int", help="First page to read (default: 1)")
LAST = Argument(
    "-l", metavar="int", help="Last page to read (default: the last)"
)
OWNER = Argument(
    "-opw", metavar="string", help="Owner password of an encrypted file"
)
USER = Argument(
    "-upw", metavar="string", help="User password of an encrypted file"
)
QUIET = Argument(
    "-q", action="store_true", help="Print no messages and no errors"
)
HELP = Argument(
    "-h",
    "-help",
    "--help",
    "-?",
    action="store_true",
    help="Show this help and exit",
)

PDFTOTEXT = CLI(
    spec=CommandSpec(
        name="pdftotext",
        description=(
            "Write the text of a PDF file to a text file, or to standard "
            "output when the text file is '-'. Pages end in a form feed."
        ),
        add_help=False,
        arguments=(
            FIRST,
            LAST,
            Argument(
                "-layout",
                action="store_true",
                help="Keep each page's columns and spacing",
            ),
            Argument(
                "-raw",
                action="store_true",
                help="Keep text in the order the page draws it",
            ),
            Argument(
                "-nodiag",
                action="store_true",
                help="Leave out text set at a slant",
            ),
            Argument(
                "-enc",
                metavar="string",
                help="Encoding of the text written; UTF-8 is the one served",
            ),
            Argument(
                "-eol",
                metavar="string",
                help="Line ending to write: unix, dos or mac",
            ),
            Argument(
                "-nopgbrk",
                action="store_true",
                help="Write no form feed after each page",
            ),
            OWNER,
            USER,
            QUIET,
            HELP,
            Argument(
                "FILE",
                type="path",
                nargs="*",
                metavar="PDF-file [text-file]",
                help="The PDF file, '-' for standard input; then the text file",
            ),
        ),
    ),
    handlers={"": CLIHandler(fn=run_pdftotext)},
)

PDFINFO = CLI(
    spec=CommandSpec(
        name="pdfinfo",
        description=(
            "Print a PDF file's document information: its metadata, page "
            "count, page size and PDF version."
        ),
        add_help=False,
        arguments=(
            Argument(
                "-f", metavar="int", help="First page whose size to list"
            ),
            Argument("-l", metavar="int", help="Last page whose size to list"),
            OWNER,
            USER,
            QUIET,
            HELP,
            Argument(
                "FILE",
                type="path",
                nargs="*",
                metavar="PDF-file",
                help="The PDF file, '-' for standard input",
            ),
        ),
    ),
    handlers={"": CLIHandler(fn=run_pdfinfo)},
)
