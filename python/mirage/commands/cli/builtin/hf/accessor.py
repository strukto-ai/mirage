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

from mirage.accessor.hf_hub import HfHubAccessor, HfRepoConfig
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import API_SEGMENTS, DEFAULT_REVISION
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

DEFAULT_REPO_TYPE = "model"


def repo_type_of(fl: FlagView) -> str:
    """The repo kind a line names, defaulting the way upstream does.

    Args:
        fl (FlagView): the invocation's flags.

    Returns:
        str: "model", "dataset" or "space".

    Raises:
        UsageError: the line named something that is not a repo kind.
    """
    value = fl.as_str("repo_type") or DEFAULT_REPO_TYPE
    if value not in API_SEGMENTS:
        raise UsageError(f"invalid repo type: {value}")
    return value


def hub_for(
    inv: CLIInvocation[HfConfig],
    repo_id: str,
    repo_type: str,
    revision: str | None = None,
) -> HfHubAccessor:
    """A Hub handle for the repository this line named.

    The CLI builds one per invocation rather than owning a second Hub
    client: an accessor is a value object here, holding the endpoint,
    the credential and which repository is being addressed, so `hf` gets
    the mount's tree walk and commit builder for free. It reaches no
    mount, which is what keeps this an account CLI.

    Args:
        inv (CLIInvocation[HfConfig]): the invocation.
        repo_id (str): "namespace/name".
        repo_type (str): "model", "dataset" or "space".
        revision (str | None): the revision to read or write.

    Returns:
        HfHubAccessor: the handle.
    """
    config = HfRepoConfig(
        repo_id=repo_id,
        token=inv.config.token,
        endpoint=inv.config.endpoint,
        revision=revision or DEFAULT_REVISION,
    )
    return HfHubAccessor(config, repo_type=repo_type)


def require_operands(inv: CLIInvocation[HfConfig], names: list[str]) -> None:
    """Refuse a line that left a required operand empty.

    ``Operand.required`` is inert outside the clap dialect on purpose:
    only clap names the empty slots, and under every other style the
    refusal "stays the leaf's own business, worded by the command"
    (``executor/command/cli.py``). hf is argparse, so each leaf that
    takes operands calls this, and it words the refusal the way argparse
    does rather than letting the line reach the Hub and come back as an
    authentication error.

    Args:
        inv (CLIInvocation[HfConfig]): the invocation.
        names (list[str]): the operand names, in declaration order.

    Raises:
        UsageError: the line supplied fewer operands than that.
    """
    missing = names[len(inv.texts):]
    if missing:
        raise UsageError("the following arguments are required: " +
                         ", ".join(missing))


def text_out(text: str) -> tuple[ByteSource | None, IOResult]:
    return yield_bytes(text.encode()), IOResult()


def require_token(inv: CLIInvocation[HfConfig], what: str) -> None:
    """Refuse a verb that cannot work anonymously, before it is tried.

    The Hub answers 401 "Invalid username or password." for an
    unauthenticated write, which reads as a wrong credential rather than
    as a missing one.

    Args:
        inv (CLIInvocation[HfConfig]): the invocation.
        what (str): what was being attempted, for the message.

    Raises:
        UsageError: the install carries no token.
    """
    if inv.config.token is None:
        raise UsageError(f"{what} requires a token; set `token` on the "
                         "`hf` install")
