from mirage.core.msgraph.types import parse_drive_item


def test_parse_drive_item_validates_json_fields():
    item = parse_drive_item({
        "id": 7,
        "name": "report.txt",
        "size": 12,
        "lastModifiedDateTime": None,
        "folder": {
            "childCount": 0
        },
        "file": "invalid",
    })

    assert item == {
        "name": "report.txt",
        "size": 12,
        "folder": {
            "childCount": 0
        },
    }
