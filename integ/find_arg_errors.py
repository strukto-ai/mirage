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

from mirage.resource.databricks_volume.config import DatabricksVolumeConfig
from mirage.resource.databricks_volume.databricks_volume import \
    DatabricksVolumeResource
from mirage.resource.discord.config import DiscordConfig
from mirage.resource.discord.discord import DiscordResource
from mirage.resource.email.config import EmailConfig
from mirage.resource.email.email import EmailResource
from mirage.resource.gdocs.config import GDocsConfig
from mirage.resource.gdocs.gdocs import GDocsResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.gdrive.gdrive import GoogleDriveResource
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.resource.github_ci.github_ci import GitHubCIResource
from mirage.resource.gmail.config import GmailConfig
from mirage.resource.gmail.gmail import GmailResource
from mirage.resource.gsheets.config import GSheetsConfig
from mirage.resource.gsheets.gsheets import GSheetsResource
from mirage.resource.gslides.config import GSlidesConfig
from mirage.resource.gslides.gslides import GSlidesResource
from mirage.resource.langfuse.config import LangfuseConfig
from mirage.resource.langfuse.langfuse import LangfuseResource
from mirage.resource.linear.config import LinearConfig
from mirage.resource.linear.linear import LinearResource
from mirage.resource.mem0.config import Mem0Config
from mirage.resource.mem0.mem0 import Mem0Resource
from mirage.resource.onedrive import OneDriveConfig, OneDriveResource
from mirage.resource.sharepoint import SharePointConfig, SharePointResource
from mirage.resource.slack.config import SlackConfig
from mirage.resource.slack.slack import SlackResource
from mirage.resource.trello.config import TrelloConfig
from mirage.resource.trello.trello import TrelloResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _resources() -> list[tuple[str, str, object]]:
    return [
        ("databricks", "/databricks",
         DatabricksVolumeResource(
             DatabricksVolumeConfig(host="h",
                                    token="t",
                                    catalog="c",
                                    schema="s",
                                    volume="v"))),
        ("discord", "/discord", DiscordResource(DiscordConfig(token="x"))),
        ("email", "/email",
         EmailResource(
             EmailConfig(imap_host="h",
                         smtp_host="h",
                         username="u",
                         password="p"))),
        ("gdocs", "/gdocs",
         GDocsResource(GDocsConfig(client_id="c", refresh_token="r"))),
        ("gdrive", "/gdrive",
         GoogleDriveResource(
             GoogleDriveConfig(client_id="c", refresh_token="r"))),
        ("github_ci", "/github_ci",
         GitHubCIResource(GitHubCIConfig(token="t", owner="o", repo="r"))),
        ("gmail", "/gmail",
         GmailResource(GmailConfig(client_id="c", refresh_token="r"))),
        ("gsheets", "/gsheets",
         GSheetsResource(GSheetsConfig(client_id="c", refresh_token="r"))),
        ("gslides", "/gslides",
         GSlidesResource(GSlidesConfig(client_id="c", refresh_token="r"))),
        ("langfuse", "/langfuse",
         LangfuseResource(LangfuseConfig(public_key="p", secret_key="s"))),
        ("linear", "/linear", LinearResource(LinearConfig(api_key="k"))),
        ("mem0", "/mem0", Mem0Resource(Mem0Config(api_key="k", user_id="u"))),
        ("onedrive", "/onedrive",
         OneDriveResource(OneDriveConfig(access_token="t"))),
        ("sharepoint", "/sharepoint",
         SharePointResource(SharePointConfig(access_token="t"))),
        ("slack", "/slack", SlackResource(SlackConfig(token="x"))),
        ("trello", "/trello",
         TrelloResource(TrelloConfig(api_key="k", api_token="t"))),
    ]


# Invalid -maxdepth/-mindepth/-size/-mtime must be rejected during flag
# parsing, before any network call, identically on every backend.
# Cross-checked py vs ts. (github needs a live repo at construct, notion needs
# an OAuth provider and hf_buckets validates the bucket id, so those are
# excluded from this cred-free cross-language suite.)
ARG_ERROR_CASES = [
    ("maxdepth", "-maxdepth abc"),
    ("mindepth", "-mindepth xx"),
    ("size", "-size abc"),
    ("mtime", "-mtime abc"),
]


async def main() -> None:
    for name, mount, resource in _resources():
        ws = Workspace({mount: resource}, mode=MountMode.READ)
        ws.create_session("s")
        for case, expr in ARG_ERROR_CASES:
            result = await ws.execute(f"find {mount} {expr}", session_id="s")
            err = (await result.stderr_str()).strip()
            print(f"=== {name}:{case} ===")
            print(f"exit={result.exit_code}")
            if err:
                print(err)


if __name__ == "__main__":
    asyncio.run(main())
