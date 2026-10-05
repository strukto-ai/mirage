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

from mirage.commands.spec.types import CommandSpec, Operand, Option

SPECS: dict[str, CommandSpec] = {
    "curl": CommandSpec(
        description="Transfer data from or to a server.",
        options=(
            Option(
                short="-H",
                long="--header",
                type="str",
                multiple=True,
                description="Add a custom header to the request.",
            ),
            Option(
                short="-A",
                long="--user-agent",
                type="str",
                description="Set the User-Agent header.",
            ),
            Option(
                short="-X",
                long="--request",
                type="str",
                description="Specify the HTTP request method.",
            ),
            Option(
                short="-d",
                long="--data",
                type="str",
                multiple=True,
                description="Send the given data as the request body.",
            ),
            Option(
                long="--data-binary",
                type="str",
                multiple=True,
                description="Send the data exactly as given, a file "
                "unchanged.",
            ),
            Option(
                long="--data-raw",
                type="str",
                multiple=True,
                description="Send the data with no special meaning for @.",
            ),
            Option(
                long="--data-urlencode",
                type="str",
                multiple=True,
                description="Send the data URL-encoded.",
            ),
            Option(
                long="--json",
                type="str",
                multiple=True,
                description="Send the data as JSON.",
            ),
            Option(
                short="-u",
                long="--user",
                type="str",
                description="Send the user and password for basic auth.",
            ),
            Option(
                short="-F",
                long="--form",
                type="str",
                description="Submit a multipart/form-data field.",
            ),
            Option(
                short="-o",
                long="--output",
                type="path",
                description="Write response body to the given file.",
            ),
            Option(
                short="-D",
                long="--dump-header",
                type="path",
                description="Write the received headers to the given "
                "file, - for stdout.",
            ),
            Option(
                short="-L",
                long="--location",
                description="Follow HTTP redirects.",
            ),
            Option(
                short="-f",
                long="--fail",
                description="Fail with exit 22 on an HTTP error status.",
            ),
            Option(
                short="-s",
                long="--silent",
                description="Run silently with no progress or messages.",
            ),
            Option(
                short="-S",
                long="--show-error",
                description="Show errors even when silent.",
            ),
            Option(
                short="-v",
                long="--verbose",
                description="Dump the request and response headers on stderr.",
            ),
            Option(
                short="-i",
                long="--include",
                description="Include the response headers in the output.",
            ),
            Option(
                short="-I",
                long="--head",
                description="Fetch the headers only.",
            ),
            Option(
                short="-4",
                long="--ipv4",
                description=(
                    "Accept IPv4 preference "
                    "(transport selects the address family)."
                ),
            ),
            Option(
                short="-6",
                long="--ipv6",
                description=(
                    "Accept IPv6 preference "
                    "(transport selects the address family)."
                ),
            ),
            Option(
                short="-w",
                long="--write-out",
                type="str",
                description="Print transfer information after completion.",
            ),
            Option(
                short="-m",
                long="--max-time",
                type="float",
                description="Give up after this many seconds.",
            ),
            Option(
                short="-k",
                long="--insecure",
                description="Skip verification of the server certificate.",
            ),
        ),
        # A URL slot, not a free-text rest: a textual rest makes the parser
        # keep unknown dash words as operands (the echo/git-log shape), and
        # `curl -sv URL` then fetched "-sv" (#1065).
        positional=(Operand(type="str"),),
    ),
    "wget": CommandSpec(
        description="Retrieve files from the web.",
        options=(
            Option(
                short="-O",
                type="path",
                description="Write the downloaded content to the given file.",
            ),
            Option(short="-q", description="Run quietly with no output."),
            Option(
                short="-T",
                long="--timeout",
                type="float",
                description="Set the network timeout in seconds (zero disables it).",
            ),
            Option(
                long="--spider",
                description="Check that the URL exists without downloading it.",
            ),
        ),
        positional=(Operand(type="str"),),
        rest=Operand(type="path"),
    ),
}
