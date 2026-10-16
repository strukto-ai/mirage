import asyncio
import json
import os
import re
import sys
from pathlib import Path

import aiofiles

from mirage import Workspace
from mirage.core.github.events import GitHubEventHook
from mirage.types import PathSpec
from mirage.vfs.github import GitHubConfig, GitHubVFS


async def main() -> None:
    async with aiofiles.open(Path(sys.argv[1])) as source:
        payload = json.loads(await source.read())
    owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
    vfs = GitHubVFS(
        GitHubConfig(
            token=os.environ["GITHUB_TOKEN"],
            owner=owner,
            repo=repo,
            ref=re.sub(
                r"^refs/(heads|tags)/",
                "",
                os.environ.get("GITHUB_REF", "main"),
            ),
        )
    )
    ws = Workspace({"/github": vfs})
    hook = GitHubEventHook(vfs.accessor)
    root = PathSpec.from_str_path("/github", "")
    try:
        for change in await hook.to_events(root, "push", payload):
            await ws.notify(change)
            print(f"{change.kind.value}: {change.path.virtual}")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
