import asyncio
import os

from mirage import Workspace
from mirage.types import PathSpec
from mirage.vfs.box import BoxConfig, BoxVFS


async def main() -> None:
    vfs = BoxVFS(BoxConfig(access_token=os.environ["BOX_ACCESS_TOKEN"]))
    ws = Workspace({"/box": vfs})
    hook = vfs.delta_hook()
    root = PathSpec.from_str_path("/box", "")
    try:
        checkpoint = (await hook.pull(root, None)).checkpoint
        print("Watching /box; edit files in the service (Ctrl-C to stop)")
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
