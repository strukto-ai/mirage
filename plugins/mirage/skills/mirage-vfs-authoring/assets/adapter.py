import asyncio

from mirage import (
    NULL_INDEX,
    Accessor,
    BaseVFS,
    FileStat,
    FileType,
    IndexCacheStore,
    PathSpec,
    ReadFixture,
    Workspace,
    check_read_contract,
)


class ResourceClient(Accessor):
    def __init__(self) -> None:
        self.files = {"hello.txt": b"Hello from my resource!\n"}


class ResourceVFS(BaseVFS):
    accessor: ResourceClient

    def __init__(self, client: ResourceClient) -> None:
        super().__init__(name="resource", accessor=client)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        key = path.vfs_path.strip("/")
        if not key:
            raise IsADirectoryError(path.virtual)
        if key not in self.accessor.files:
            raise FileNotFoundError(path.virtual)
        return self.accessor.files[key]

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        if path.vfs_path.strip("/"):
            await self.read(path, index)
            raise NotADirectoryError(path.virtual)
        return [path.child(name) for name in sorted(self.accessor.files)]

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
        if not path.vfs_path.strip("/"):
            return FileStat(name=name, type=FileType.DIRECTORY)
        data = await self.read(path, index)
        return FileStat(name=name, type=FileType.FILE, size=len(data))


async def main() -> None:
    vfs = ResourceVFS(ResourceClient())
    fixture = ReadFixture(
        file=PathSpec(
            virtual="/resource/hello.txt",
            directory="/resource",
            vfs_path="hello.txt",
        ),
        directory=PathSpec(virtual="/resource", directory="/", vfs_path=""),
        missing=PathSpec(
            virtual="/resource/missing",
            directory="/resource",
            vfs_path="missing",
        ),
        content=vfs.accessor.files["hello.txt"],
    )
    await check_read_contract(vfs, fixture)
    ws = Workspace({"/resource": vfs})
    try:
        result = await ws.shell("cat /resource/hello.txt")
        assert result.exit_code == 0
        assert await result.stdout_str() == fixture.content.decode()
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
