from typing import Any, TypeGuard


def is_record(value: Any) -> TypeGuard[dict[str, Any]]:
    """Whether a decoded value is a JSON object.

    Args:
        value (Any): the decoded value.
    """
    return isinstance(value, dict)


def is_plain_object(value: Any) -> TypeGuard[dict[str, Any]]:
    """Whether a value is a document mapping.

    Args:
        value (Any): the candidate mapping.
    """
    return type(value) is dict


def as_object(value: Any) -> dict[str, Any]:
    """Read an object, defaulting a missing or mistyped value to empty.

    Args:
        value (Any): the decoded field.
    """
    return value if is_record(value) else {}


def as_array(value: Any) -> list[Any]:
    """Read an array, defaulting a missing or mistyped value to empty.

    Args:
        value (Any): the decoded field.
    """
    return value if isinstance(value, list) else []


def records(value: Any) -> list[dict[str, Any]]:
    """Keep the object entries of a decoded array.

    Args:
        value (Any): the decoded collection.
    """
    return [item for item in as_array(value) if is_record(item)]


def pick_string(record: dict[str, Any], *keys: str) -> str | None:
    """Read the first string field, including an explicitly empty one.

    Args:
        record (dict[str, Any]): the decoded record.
        keys (str): candidate fields in precedence order.
    """
    for key in keys:
        value = record.get(key)
        if isinstance(value, str):
            return value
    return None


def string_of(record: dict[str, Any], key: str) -> str:
    """Read a string field, defaulting to empty.

    Args:
        record (dict[str, Any]): the decoded record.
        key (str): the field name.
    """
    return pick_string(record, key) or ""


def first_text(record: dict[str, Any], *keys: str) -> str:
    """Read the first nonempty string, for display labels.

    Args:
        record (dict[str, Any]): the decoded record.
        keys (str): candidate fields in precedence order.
    """
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def pick_bool_or_none(record: dict[str, Any], key: str) -> bool | None:
    """Read a boolean without coercing strings or numbers.

    Args:
        record (dict[str, Any]): the decoded record.
        key (str): the field name.
    """
    value = record.get(key)
    return value if isinstance(value, bool) else None


def pick_number_or_none(
    record: dict[str, Any], key: str
) -> int | float | None:
    """Read a number; a Python bool is not a JSON number.

    Args:
        record (dict[str, Any]): the decoded record.
        key (str): the field name.
    """
    value = record.get(key)
    return value if type(value) in (int, float) else None


def pick_string_array(record: dict[str, Any], key: str) -> list[str]:
    """Keep the strings of an array field.

    Args:
        record (dict[str, Any]): the decoded record.
        key (str): the field name.
    """
    return [
        value for value in as_array(record.get(key)) if isinstance(value, str)
    ]


def require_id(record: dict[str, Any]) -> str:
    """Read a required nonempty resource id.

    Args:
        record (dict[str, Any]): the decoded record.
    """
    value = first_text(record, "id")
    if not value:
        raise ValueError("record missing id")
    return value
