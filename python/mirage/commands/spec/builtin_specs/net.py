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

from mirage.commands.spec.types import Argument, CommandSpec

SPECS: dict[str, CommandSpec] = {
    "curl": CommandSpec(
        description="Transfer data from or to a server.",
        arguments=(
            Argument(
                "-H",
                "--header",
                action="append",
                help="Add a custom header to the request.",
            ),
            Argument(
                "-A",
                "--user-agent",
                help="Set the User-Agent header.",
            ),
            Argument(
                "-X",
                "--request",
                help="Specify the HTTP request method.",
            ),
            Argument(
                "-d",
                "--data",
                action="append",
                help="Send the given data as the request body.",
            ),
            Argument(
                "--data-binary",
                action="append",
                help="Send the data exactly as given, a file unchanged.",
            ),
            Argument(
                "--data-raw",
                action="append",
                help="Send the data with no special meaning for @.",
            ),
            Argument(
                "--data-urlencode",
                action="append",
                help="Send the data URL-encoded.",
            ),
            Argument(
                "--json",
                action="append",
                help="Send the data as JSON.",
            ),
            Argument(
                "-u",
                "--user",
                help="Send the user and password for basic auth.",
            ),
            Argument(
                "-F",
                "--form",
                help="Submit a multipart/form-data field.",
            ),
            Argument(
                "-o",
                "--output",
                type="path",
                help="Write response body to the given file.",
            ),
            Argument(
                "-D",
                "--dump-header",
                type="path",
                help="Write the received headers to the given "
                "file, - for stdout.",
            ),
            Argument(
                "-L",
                "--location",
                action="store_true",
                help="Follow HTTP redirects.",
            ),
            Argument(
                "-f",
                "--fail",
                action="store_true",
                help="Fail with exit 22 on an HTTP error status.",
            ),
            Argument(
                "-s",
                "--silent",
                action="store_true",
                help="Run silently with no progress or messages.",
            ),
            Argument(
                "-S",
                "--show-error",
                action="store_true",
                help="Show errors even when silent.",
            ),
            Argument(
                "-v",
                "--verbose",
                action="store_true",
                help="Dump the request and response headers on stderr.",
            ),
            Argument(
                "-i",
                "--include",
                action="store_true",
                help="Include the response headers in the output.",
            ),
            Argument(
                "-I",
                "--head",
                action="store_true",
                help="Fetch the headers only.",
            ),
            Argument(
                "-4",
                "--ipv4",
                action="store_true",
                help="Accept IPv4 preference "
                "(transport selects the address family).",
            ),
            Argument(
                "-6",
                "--ipv6",
                action="store_true",
                help="Accept IPv6 preference "
                "(transport selects the address family).",
            ),
            Argument(
                "-w",
                "--write-out",
                help="Print transfer information after completion.",
            ),
            Argument(
                "-m",
                "--max-time",
                type="float",
                help="Give up after this many seconds.",
            ),
            Argument(
                "-k",
                "--insecure",
                action="store_true",
                help="Skip verification of the server certificate.",
            ),
            # A URL slot, not a free-text rest: a textual rest makes the parser
            # keep unknown dash words as operands (the echo/git-log shape), and
            # `curl -sv URL` then fetched "-sv" (#1065).
            Argument("text", nargs="?", metavar=""),
        ),
    ),
    "wget": CommandSpec(
        description="Retrieve files from the web.",
        arguments=(
            Argument(
                "-O",
                type="path",
                help="Write the downloaded content to the given file.",
            ),
            Argument(
                "-q", action="store_true", help="Run quietly with no output."
            ),
            Argument(
                "-T",
                "--timeout",
                type="float",
                help="Set the network timeout in seconds (zero disables it).",
            ),
            Argument(
                "--spider",
                action="store_true",
                help="Check that the URL exists without downloading it.",
            ),
            Argument("text", nargs="?", metavar=""),
            Argument("paths", type="path", nargs="*", metavar=""),
        ),
    ),
}
