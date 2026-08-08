_POWERS = {
    "K": 1,
    "M": 2,
    "G": 3,
    "T": 4,
    "P": 5,
    "E": 6,
    "Z": 7,
    "Y": 8,
    "R": 9,
    "Q": 10,
}


def size_suffixes(letters: str) -> dict[str, int]:
    """GNU xstrtol suffix table restricted to a command's accepted letters.

    Letter ``L`` maps to ``1024**n``, ``LB`` to ``1000**n`` and ``LiB`` to
    ``1024**n``; the special letter ``b`` is 512 with no B/iB forms. The
    accepted letters differ per coreutil (truncate takes ``g``/``t`` where
    split does not; od stops at ``E``), so each caller passes the exact
    set pinned against GNU 9.7.

    Args:
        letters (str): the accepted suffix letters, e.g. ``bkKmMGTPE``.
    """
    table: dict[str, int] = {}
    for letter in letters:
        if letter == "b":
            table["b"] = 512
            continue
        power = _POWERS[letter.upper()]
        table[letter] = 1024**power
        table[letter + "B"] = 1000**power
        table[letter + "iB"] = 1024**power
    return table


__all__ = ["size_suffixes"]
