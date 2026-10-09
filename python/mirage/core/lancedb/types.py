from collections.abc import Callable
from typing import Any

LanceRow = dict[str, Any]
ValueTest = Callable[[str], bool]
