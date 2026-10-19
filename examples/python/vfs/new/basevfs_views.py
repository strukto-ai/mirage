import asyncio
import re

from mirage import (
    CLI,
    Accessor,
    Argument,
    BaseVFS,
    CLIHandler,
    CommandSpec,
    ContentType,
    Context,
    FileStat,
    FileType,
    IOResult,
    MountMode,
    PathSpec,
    Workspace,
)
from mirage.runtime.files import RuntimeFiles


class NotesAccessor(Accessor):
    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = dict(pages)
        self.read_calls = 0
        self.search_calls = 0


def page_bytes(accessor: NotesAccessor, path: PathSpec) -> bytes:
    key = path.vfs_path.strip("/")
    if not key:
        raise IsADirectoryError(path.virtual)
    if "/" in key and key.split("/", 1)[0] in accessor.pages:
        raise NotADirectoryError(path.virtual)
    page = accessor.pages.get(key)
    if page is None:
        raise FileNotFoundError(path.virtual)
    return page.encode("utf-8")


class NotesVFS(BaseVFS):
    """A flat, read-only collection of UTF-8 pages."""

    accessor: NotesAccessor

    def __init__(self, pages: dict[str, str]) -> None:
        super().__init__(
            name="notes",
            accessor=NotesAccessor(pages),
            prompt="Read-only notes rendered as UTF-8 text files.",
            sizes_always_known=True,
        )

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        if path.vfs_path.strip("/"):
            page_bytes(self.accessor, path)
            raise NotADirectoryError(path.virtual)
        return [
            FileStat(
                name=name,
                type=FileType.FILE,
                content=ContentType.TEXT,
                size=len(page.encode("utf-8")),
            )
            for name, page in sorted(self.accessor.pages.items())
        ]

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        self.accessor.read_calls += 1
        return page_bytes(self.accessor, path)

    async def stat(self, path: PathSpec) -> FileStat:
        name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
        if not path.vfs_path.strip("/"):
            return FileStat(name=name, type=FileType.DIRECTORY, size=None)
        return FileStat(
            name=name,
            type=FileType.FILE,
            content=ContentType.TEXT,
            size=len(page_bytes(self.accessor, path)),
        )

    async def lines_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        ignore_case: bool,
    ) -> bytes | None:
        """The lines of one page holding ``text``, so grep and rg skip the read.

        Declines (None) under -i, or for a page holding a NUL byte, which
        grep reports as binary; grep and rg then read the page.

        Args:
            path (PathSpec): the page grep or rg would read.
            text (str): plain text every match holds.
            ignore_case (bool): whether case folds.
        """
        self.accessor.search_calls += 1
        page = page_bytes(self.accessor, path)
        if ignore_case or b"\0" in page:
            return None
        lines = re.split(rb"(?<=\n)", page)
        return b"".join(line for line in lines if text.encode() in line)


async def note_info(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes, IOResult]:
    vfs, session = ctx.vfs, ctx.session
    if vfs is None or session is None:
        raise RuntimeError("note-info needs workspace entry points")
    path = paths[0]
    data = await vfs.read(path)
    target, rest = "/", path.virtual.split("/")
    while rest:
        step = PathSpec.from_str_path(rest.pop(0), cwd=target).virtual
        if (await vfs.stat(step, nofollow=True)).type is not FileType.SYMLINK:
            target = step
            continue
        link = await vfs.readlink(step)
        rest[:0] = link.split("/")
        target = "/" if link.startswith("/") else target
    mount = vfs.mount_of(target)
    reader = session.get("READER") or "anonymous"
    header = f"mount={mount} reader={reader} bytes={len(data)}\n"
    return header.encode() + data, IOResult()


async def show(ws: Workspace, line: str) -> None:
    result = await ws.shell(line)
    if result.exit_code != 0:
        raise RuntimeError(f"{line}: {await result.stderr_str()}")
    print(f"$ {line}\n{await result.stdout_str()}", end="")


async def show_search(ws: Workspace, notes: NotesVFS) -> None:
    for command in ("grep", "rg"):
        for flags, pattern, calls in (
            ("-F", "BaseVFS", (1, 0)),
            ("-nF", "BaseVFS", (1, 1)),
            ("-e", "Base.*adapter", (1, 0)),
            ("-iF", "ADAPTER", (1, 1)),
        ):
            before = (notes.accessor.search_calls, notes.accessor.read_calls)
            await show(ws, f"{command} {flags} '{pattern}' /notes/todo.txt")
            assert (
                notes.accessor.search_calls - before[0],
                notes.accessor.read_calls - before[1],
            ) == calls
        reads_before = notes.accessor.read_calls
        missing = await ws.shell(f"{command} -F absent /notes/todo.txt")
        assert (
            missing.exit_code,
            await missing.stdout_str(),
            await missing.stderr_str(),
        ) == (1, "", "")
        assert notes.accessor.read_calls == reads_before
    print("Native search and scan fallbacks verified for grep and rg.")


async def main() -> None:
    notes = NotesVFS(
        {
            "welcome.txt": "Hello, café.\n",
            "todo.txt": "Review the BaseVFS adapter.\n",
        }
    )
    ws = Workspace(
        {
            "/notes": notes,
            "/notes/status": NotesVFS({"health.txt": "ok\n"}),
        },
        mode=MountMode.WRITE,
    )
    try:
        ws.register_cli(
            "note-info",
            CLI(
                spec=CommandSpec(
                    name="note-info",
                    arguments=(Argument("path", type="path"),),
                ),
                handlers={"": CLIHandler(fn=note_info)},
            ),
        )
        for line in (
            "ln -s /notes/welcome.txt /latest",
            "ls -1 /notes",
            "cat /latest",
            "grep BaseVFS /notes/todo.txt",
            "export READER=demo; note-info /latest",
            "note-info /notes/status/health.txt",
            "ln -s /notes /n; ln -s /n/status /alias",
            "note-info /alias/health.txt",
        ):
            await show(ws, line)
        await show_search(ws, notes)

        expected = "Hello, café.\n".encode()
        assert await ws.vfs.read("/latest") == expected
        assert (await ws.vfs.stat("/latest")).size == len(expected)
        reader = await ws.session("reader", {"/notes": MountMode.READ})
        assert await reader.vfs.read("/latest") == expected

        runtime = RuntimeFiles(ws.dispatch, asyncio.get_running_loop())
        assert await asyncio.to_thread(runtime.read, "/latest") == expected
        assert not (await asyncio.to_thread(runtime.stat, "/latest")).is_dir
        refused = await ws.shell("echo changed > /notes/welcome.txt")
        assert refused.exit_code != 0
        assert await ws.vfs.read("/latest") == expected
        print(
            "Filesystem, session and runtime views agree; writes are refused."
        )
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
