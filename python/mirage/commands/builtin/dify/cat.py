from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.stat import stat as dify_stat
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def make_cat(ops: CommandIO):
    """Build dify ``cat`` over cache-aware readers.

    Args:
        ops (CommandIO): the dify IO adapter whose ``read_bytes`` /
            ``read_stream`` already serve cached bytes when warm.
    """

    @command("cat",
             resource="dify",
             spec=SPECS["cat"],
             provision=make_file_read_provision(dify_stat))
    async def cat(
        accessor,
        paths: list[PathSpec],
        *texts: str,
        n: bool = False,
        index: IndexCacheStore | None = None,
        **_extra: object,
    ) -> tuple[ByteSource | None, IOResult]:
        paths = await resolve_glob(accessor, paths, index)
        # dify is a remote (cacheable) backend. Single file: stream via a
        # cachable returned AS stdout so the tee fills the cache as the
        # consumer reads. Multiple files: per-file cachables plus a joined
        # stdout are different objects, so the cache-fill background drain
        # races the consumer on the same stream and poisons each file's cache
        # slot. Read each file to bytes: cache real bytes directly (no drain,
        # no race) and concatenate for stdout.
        if len(paths) == 1:
            p = paths[0]
            cachable = CachableAsyncIterator(
                ops.read_stream(accessor, p, index))
            io = IOResult(reads={p.mount_path: cachable}, cache=[p.mount_path])
            source: ByteSource = cachable
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                data = await ops.read_bytes(accessor, p, index)
                reads[p.mount_path] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        if n:
            return generic_cat(source, number_lines=True), io
        return source, io

    return cat
