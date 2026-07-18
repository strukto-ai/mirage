from typing import Literal, TypeAlias

CompressionSuffix: TypeAlias = Literal["", ":gz", ":bz2", ":xz"]
WriteMode: TypeAlias = Literal["w", "w:gz", "w:bz2", "w:xz"]
ReadMode: TypeAlias = Literal["r", "r:gz", "r:bz2", "r:xz"]
