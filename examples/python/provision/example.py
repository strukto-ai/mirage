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
import os
import traceback

from dotenv import load_dotenv

from mirage import MountMode, Workspace

load_dotenv(".env.development")

# Live provision probes for the API backends that have no integ suite.
# For each mountable backend this walks to a real file and asks for cost
# estimates (execute(..., provision=True)) for one read, one search, and
# one listing, mirroring integ's run_provision_probe. Expected shapes:
# chat/KB reads charge index-hit ops with zero network bytes, metadata
# commands are zero-cost, and rendered files without a backend size
# print UNKNOWN with a read-op floor instead of claiming a free read.


def build(backend: str):
    if backend == "discord":
        from mirage.resource.discord import DiscordConfig, DiscordResource
        return DiscordResource(config=DiscordConfig(
            token=os.environ["DISCORD_BOT_TOKEN"]))
    if backend == "slack":
        from mirage.resource.slack import SlackConfig, SlackResource
        return SlackResource(config=SlackConfig(
            token=os.environ["SLACK_BOT_TOKEN"],
            search_token=os.environ.get("SLACK_USER_TOKEN")))
    if backend == "linear":
        from mirage.resource.linear import LinearConfig, LinearResource
        return LinearResource(config=LinearConfig(
            api_key=os.environ["LINEAR_API_KEY"]))
    if backend == "trello":
        from mirage.resource.trello import TrelloConfig, TrelloResource
        return TrelloResource(
            config=TrelloConfig(api_key=os.environ["TRELLO_API_KEY"],
                                api_token=os.environ["TRELLO_API_TOKEN"]))
    if backend == "langfuse":
        from mirage.resource.langfuse import LangfuseConfig, LangfuseResource
        return LangfuseResource(
            config=LangfuseConfig(public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
                                  secret_key=os.environ["LANGFUSE_SECRET_KEY"],
                                  host=os.environ["LANGFUSE_HOST"],
                                  default_trace_limit=5))
    if backend == "email":
        from mirage.resource.email import EmailConfig, EmailResource
        return EmailResource(
            config=EmailConfig(imap_host=os.environ["IMAP_HOST"],
                               smtp_host=os.environ["SMTP_HOST"],
                               username=os.environ["EMAIL_USERNAME"],
                               password=os.environ["EMAIL_PASSWORD"],
                               max_messages=5))
    if backend == "github_ci":
        from mirage.resource.github_ci import GitHubCIConfig, GitHubCIResource
        return GitHubCIResource(
            config=GitHubCIConfig(token=os.environ["GITHUB_TOKEN"],
                                  owner="strukto-ai",
                                  repo="mirage",
                                  max_runs=20))
    if backend == "gdocs":
        from mirage.resource.gdocs import GDocsConfig, GDocsResource
        return GDocsResource(config=GDocsConfig(
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"]))
    if backend == "gmail":
        from mirage.resource.gmail import GmailConfig, GmailResource
        return GmailResource(config=GmailConfig(
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"]))
    raise ValueError(f"unknown backend {backend!r}")


BACKENDS = [
    "discord",
    "slack",
    "linear",
    "trello",
    "langfuse",
    "email",
    "github_ci",
    "gdocs",
    "gmail",
]


def provision_line(result) -> str:
    return (f"net={result.network_read} write={result.network_write} "
            f"cache={result.cache_read} ops={result.read_ops} "
            f"hits={result.cache_hits} precision={result.precision.value}")


async def list_dir(ws: Workspace, path: str) -> list[str]:
    result = await ws.execute(f'ls "{path}"')
    base = path.rstrip("/")
    return [
        f"{base}/{entry.rstrip('/')}"
        for entry in (result.stdout or b"").decode().splitlines() if entry
    ]


async def first_file(ws: Workspace, mount: str) -> str | None:
    """Breadth-first readdir walk to the first extension-bearing file."""
    frontier = [mount]
    for _depth in range(7):
        next_frontier: list[str] = []
        for directory in frontier[:8]:
            for child in await list_dir(ws, directory):
                if "." in child.rsplit("/", 1)[-1]:
                    return child
                next_frontier.append(child)
        if not next_frontier:
            return None
        frontier = next_frontier
    return None


async def probe(backend: str) -> None:
    ws = Workspace({f"/{backend}": build(backend)}, mode=MountMode.READ)
    try:
        root = await ws.execute(f"ls /{backend}")
        if root.exit_code != 0:
            err = (root.stderr or b"").decode().strip()
            print(f"{backend}: mount unreachable: {err}")
            return
        target = await first_file(ws, f"/{backend}")
        if target is None:
            print(f"{backend}: no files reachable")
            return
        parent = target.rsplit("/", 1)[0]
        for name, cmd in ((f"{backend} prov_cat", f'cat "{target}"'),
                          (f"{backend} prov_grep", f'grep x "{target}"'),
                          (f"{backend} prov_ls", f'ls "{parent}"')):
            result = await ws.execute(cmd, provision=True)
            print(f"{name}: {provision_line(result)}")
    finally:
        await ws.close()


async def main() -> None:
    for backend in BACKENDS:
        print(f"=== {backend} ===")
        try:
            await probe(backend)
        except KeyError as exc:
            print(f"{backend}: skipped, missing credential {exc}")
        except Exception:
            print(f"{backend}: failed")
            traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
