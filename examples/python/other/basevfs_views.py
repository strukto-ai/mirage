import asyncio

from mirage import (
    NULL_INDEX,
    Accessor,
    BaseVFS,
    CLIInvocation,
    CLISpec,
    ContentType,
    FileStat,
    FileType,
    IndexCacheStore,
    IOResult,
    MountMode,
    Operand,
    PathSpec,
    ReadOps,
    SearchOps,
    SearchQuery,
    VFSAdapter,
    Workspace,
)
from mirage.commands.builtin.grep_pushdown import grep_search_options
from mirage.commands.builtin.utils.lines import split_lines
from mirage.runtime.vfs import RuntimeVFS


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


async def readdir(
    accessor: NotesAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    if path.vfs_path.strip("/"):
        page_bytes(accessor, path)
        raise NotADirectoryError(path.virtual)
    parent = path.virtual.rstrip("/")
    return [f"{parent}/{name}" for name in sorted(accessor.pages)]


async def read_bytes(
    accessor: NotesAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    accessor.read_calls += 1
    return page_bytes(accessor, path)


async def stat(
    accessor: NotesAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if not path.vfs_path.strip("/"):
        return FileStat(name=name, type=FileType.DIRECTORY, size=None)
    return FileStat(
        name=name,
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=len(page_bytes(accessor, path)),
    )


async def search(
    accessor: NotesAccessor,
    path: PathSpec,
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[tuple[PathSpec, str]] | None:
    """Search one page literally, declining requests that need a scan.

    Args:
        accessor (NotesAccessor): the notes service.
        path (PathSpec): the page to search.
        query (SearchQuery): text and grep integration options.
        index (IndexCacheStore): the mount's metadata view.
    """
    accessor.search_calls += 1
    options = grep_search_options(query)
    if (
        not path.vfs_path.strip("/")
        or options.ignore_case
        or options.whole_word
    ):
        return None
    text = page_bytes(accessor, path).decode("utf-8")
    if "\0" in text:
        return None
    return [(path, line) for line in split_lines(text) if query.query in line]


class NotesVFS(BaseVFS):
    """A flat, read-only collection of UTF-8 pages."""

    accessor: NotesAccessor

    def __init__(self, pages: dict[str, str]) -> None:
        super().__init__(
            name="notes",
            accessor=NotesAccessor(pages),
            io=VFSAdapter(
                read=ReadOps(
                    readdir=readdir, read_bytes=read_bytes, stat=stat
                ),
                search=SearchOps(
                    search=search, meta={"grep": {"mode": "literal"}}
                ),
            ),
            prompt="Read-only notes rendered as UTF-8 text files.",
            sizes_always_known=True,
        )


async def note_info(inv: CLIInvocation[None]) -> tuple[bytes, IOResult]:
    doors = inv.doors
    if (
        doors is None
        or doors.dispatch is None
        or doors.ns is None
        or doors.ns.mounts is None
        or doors.session_view is None
    ):
        raise RuntimeError("note-info needs workspace doors")
    path = inv.paths[0]
    target = (
        doors.ns.links.resolve(path.virtual)
        if doors.ns.links is not None
        else path.virtual
    )
    data, result = await doors.dispatch("read", path)
    if result.exit_code != 0:
        return b"", result
    if not isinstance(data, bytes):
        raise TypeError("expected file bytes")
    mount = doors.ns.mounts.root_of(target)
    reader = doors.session_view.get("READER") or "anonymous"
    header = f"mount={mount} reader={reader} bytes={len(data)}\n"
    return header.encode() + data, result


async def show(ws: Workspace, line: str) -> None:
    result = await ws.shell(line)
    if result.exit_code != 0:
        raise RuntimeError(f"{line}: {await result.stderr_str()}")
    print(f"$ {line}\n{await result.stdout_str()}", end="")


async def show_search(ws: Workspace, notes: NotesVFS) -> None:
    for command in ("grep", "rg"):
        for flags, pattern, calls in (
            ("-F", "BaseVFS", (1, 0)),
            ("-nF", "BaseVFS", (0, 1)),
            ("-e", "Base.*adapter", (0, 1)),
            ("-iF", "basevfs", (1, 1)),
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
            CLISpec(
                name="note-info",
                positional=(Operand(name="path", type="path", required=True),),
                fn=note_info,
            ),
        )
        for line in (
            "ln -s /notes/welcome.txt /latest",
            "ls -1 /notes",
            "cat /latest",
            "grep BaseVFS /notes/todo.txt",
            "export READER=demo; note-info /latest",
            "note-info /notes/status/health.txt",
        ):
            await show(ws, line)
        await show_search(ws, notes)

        expected = "Hello, café.\n".encode()
        assert await ws.vfs.read("/latest") == expected
        assert (await ws.vfs.stat("/latest")).size == len(expected)
        reader = await ws.session("reader", {"/notes": MountMode.READ})
        assert await reader.vfs.read("/latest") == expected

        runtime = RuntimeVFS(ws.dispatch, asyncio.get_running_loop())
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
