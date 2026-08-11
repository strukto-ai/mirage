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
    'curl':
    CommandSpec(
        description="Transfer data from or to a server.",
        options=(
            Option(short="-H",
                   type="str",
                   description="Add a custom header to the request."),
            Option(short="-A",
                   type="str",
                   description="Set the User-Agent header."),
            Option(short="-X",
                   type="str",
                   description="Specify the HTTP request method."),
            Option(short="-d",
                   type="str",
                   description="Send the given data as the request body."),
            Option(short="-F",
                   type="str",
                   description="Submit a multipart/form-data field."),
            Option(short="-o",
                   type="path",
                   description="Write response body to the given file."),
            Option(short="-L", description="Follow HTTP redirects."),
            Option(short="-f",
                   long="--fail",
                   description="Fail with exit 22 on an HTTP error status."),
            Option(short="-s",
                   description="Run silently with no progress or messages."),
            Option(short="-S", description="Show errors even when silent."),
        ),
        rest=Operand(type="str"),
    ),
    'wget':
    CommandSpec(
        description="Retrieve files from the web.",
        options=(
            Option(
                short="-O",
                type="path",
                description="Write the downloaded content to the given file."),
            Option(short="-q", description="Run quietly with no output."),
            Option(
                long="--spider",
                description="Check that the URL exists without downloading it."
            ),
        ),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
    ),
}
