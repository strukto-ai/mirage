import asyncio
import os

from mirage import Workspace
from mirage.types import PathSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS


async def main() -> None:
    vfs = GoogleDriveVFS(
        GoogleDriveConfig(
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
        )
    )
    ws = Workspace({"/gdrive": vfs})
    hook = vfs.delta_hook()
    root = PathSpec.from_str_path("/gdrive", "")
    try:
        checkpoint = (await hook.pull(root, None)).checkpoint
        print("Watching /gdrive; edit files in the service (Ctrl-C to stop)")
        while True:
            await asyncio.sleep(5)
            result = await hook.pull(root, checkpoint)
            for change in result.changes:
                await ws.notify(change)
                print(f"{change.kind.value}: {change.path.virtual}")
            checkpoint = result.checkpoint
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
