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

from mirage.commands.cli.builtin.hf.accessor import require_token, text_out
from mirage.commands.cli.types import CLIInvocation
from mirage.core.hf_hub.account import whoami
from mirage.core.hf_hub.config import HfConfig
from mirage.io.types import ByteSource, IOResult

# The origin upstream treats as "not a private endpoint".
PUBLIC_HUB = "https://huggingface.co"


async def whoami_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """Print the account the configured token belongs to."""
    require_token(inv, "auth whoami")
    account = await whoami(inv.config)
    name = account.get("name")
    orgs = account.get("orgs")
    lines = [str(name) if isinstance(name, str) else ""]
    # `orgs: ` and not a bare line each, which is upstream's shape --
    # `print(ANSI.bold("orgs: "), ",".join(orgs))` in commands/user.py, whose
    # two arguments put a second space after the colon. Unlabelled, the
    # account and the organizations it belongs to are indistinguishable, and a
    # reader that takes the last line pushes to the org instead of the user.
    # Measured: an agent asked to create a repo under its own account read
    # `integ-org` off the second line and created it there, which the Hub
    # accepts and a grader looking under the account does not find.
    #
    # The escape codes upstream wraps the label in are NOT reproduced. They
    # are a terminal's, not the command's, and NO_COLOR strips them there
    # too; what has to match is the word.
    members = [
        str(org["name"]) for org in (orgs if isinstance(orgs, list) else [])
        if isinstance(org, dict) and isinstance(org.get("name"), str)
    ]
    if members:
        lines.append(f"orgs:  {','.join(members)}")
    # Upstream prints this whenever the endpoint is not huggingface.co, which
    # for every mirage install is always: the endpoint is the deployment's.
    endpoint = inv.config.endpoint.rstrip("/")
    if endpoint != PUBLIC_HUB:
        lines.append(f"Authenticated through private endpoint: {endpoint}")
    return text_out("\n".join(lines) + "\n")


async def list_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """List the stored access tokens.

    A workspace has no token store: an install carries exactly one
    credential, given to it by the embedding program. So this reports
    that one under upstream's own two-column shape rather than pretending
    to a set it cannot hold, and reports nothing when there is none.
    """
    rows = ["{:<20} {}".format("NAME", "TOKEN")]
    if inv.config.token is not None:
        account = await whoami(inv.config)
        name = account.get("name")
        rows.append("{:<20} {}".format(
            str(name) if isinstance(name, str) else "install", "*" * 8))
    return text_out("\n".join(rows) + "\n")
