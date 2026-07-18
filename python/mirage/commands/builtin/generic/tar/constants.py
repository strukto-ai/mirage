from mirage.commands.builtin.generic.tar.types import (CompressionSuffix,
                                                       ReadMode, WriteMode)

WRITE_MODES: dict[CompressionSuffix, WriteMode] = {
    "": "w",
    ":gz": "w:gz",
    ":bz2": "w:bz2",
    ":xz": "w:xz",
}
READ_MODES: dict[CompressionSuffix, ReadMode] = {
    "": "r",
    ":gz": "r:gz",
    ":bz2": "r:bz2",
    ":xz": "r:xz",
}
