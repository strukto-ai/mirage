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

from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)

SPECS: dict[str, CommandSpec] = {
    'curl':
    CommandSpec(
        description="Transfer data from or to a server.",
        options=(
            Option(short="-H",
                   value_kind=OperandKind.TEXT,
                   description="Add a header to the request."),
            Option(short="-A",
                   value_kind=OperandKind.TEXT,
                   description="Set the User-Agent header."),
            Option(short="-X",
                   value_kind=OperandKind.TEXT,
                   description="Specify the HTTP request method."),
            Option(short="-d",
                   value_kind=OperandKind.TEXT,
                   description="Send the given body as POST data."),
            Option(short="-F",
                   value_kind=OperandKind.TEXT,
                   description="Submit a multipart/form-data field."),
            Option(short="-o",
                   value_kind=OperandKind.PATH,
                   description="Write output to the given file."),
            Option(short="-L", description="Follow HTTP redirects."),
            Option(short="-s",
                   description="Run silently without progress output."),
            Option(short="-S", description="Show errors even when silent."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'wget':
    CommandSpec(
        description="Retrieve files from the web.",
        options=(
            Option(
                short="-O",
                value_kind=OperandKind.PATH,
                description="Write the downloaded content to the given file."),
            Option(short="-q", description="Run quietly with no output."),
            Option(
                long="--spider",
                description="Check that the URL exists without downloading it."
            ),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
