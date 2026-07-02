import fnmatch
import logging
import posixpath

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.constants import SCOPE_ERROR
from mirage.core.chroma.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)


async def resolve_glob(
    accessor,
    paths: list,
    index: IndexCacheStore,
) -> list[PathSpec]:
    result: list[PathSpec] = []
    for p in paths:
        if isinstance(p, str):
            result.append(
                PathSpec(resource_path=(p).strip("/"),
                         virtual=p,
                         directory=posixpath.dirname(p)))
            continue
        if p.resolved:
            result.append(p)
        elif p.pattern:
            entries = await readdir(accessor, p.dir, index)
            matched = [
                PathSpec.from_str_path(e, rekey(p.virtual, p.resource_path, e))
                for e in entries
                if fnmatch.fnmatch(e.rsplit("/", 1)[-1], p.pattern)
            ]
            if len(matched) > SCOPE_ERROR:
                logger.warning(
                    "%s: %d matches exceeds limit (%d), truncating",
                    p.directory,
                    len(matched),
                    SCOPE_ERROR,
                )
                matched = matched[:SCOPE_ERROR]
            result.extend(matched)
        else:
            result.append(p)
    return result
