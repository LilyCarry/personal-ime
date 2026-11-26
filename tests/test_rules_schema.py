"""profiler.rules_schema 模块单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from profiler.rules_schema import (
    RULE_CATEGORIES,
    RULES_BY_ID,
    RULES_CATALOG,
    build_prompt_catalog_text,
    export_catalog,
    export_rime_algebra,
    get_rime_algebra_lines,
    get_rule,
    is_valid_rule,
    list_rules,
    normalize_rule_id,
    normalize_rules,
    validate_rules,
)

REQUIRED_CORE_RULE_IDS = {
    "ong=on",
    "in=ing",
    "en=eng",
    "an=ang",
    "z=zh",
    "c=ch",
    "s=sh",
    "l=n",
    "l=r",
    "f=h",
    "ian=iang",
    "uan=uang",
}


def test_catalog_covers_required_rules_and_metadata() -> None:
    assert REQUIRED_CORE_RULE_IDS.issubset(RULES_BY_ID.keys())

    seen_ids: set[str] = set()
    categories_present: set[str] = set()
    for rule in RULES_CATALOG:
        assert rule.id not in seen_ids
        seen_ids.add(rule.id)
        assert rule.label.strip()
        assert rule.category in RULE_CATEGORIES
        categories_present.add(rule.category)
        assert rule.description.strip()
        assert len(rule.algebra) >= 1
        assert all(expr.startswith(("derive/", "xform/", "erase/", "abbrev/")) for expr in rule.algebra)

    assert categories_present == set(RULE_CATEGORIES)


def test_normalize_rule_id_aliases_and_separators() -> None:
    assert normalize_rule_id("ong=on") == "ong=on"
    assert normalize_rule_id("on=ong") == "ong=on"
    assert normalize_rule_id("  ONG = ON  ") == "ong=on"
    assert normalize_rule_id("zh=z") == "z=zh"
    assert normalize_rule_id("Z_ZH") == "z=zh"
    assert normalize_rule_id("l<->r") == "l=r"
    assert normalize_rule_id("r->l") == "l=r"
    assert normalize_rule_id("iang/ian") == "ian=iang"
    assert normalize_rule_id("u=v") == "ju=jv"
    assert is_valid_rule("in=ing") is True
    assert get_rule("zh=z") == RULES_BY_ID["z=zh"]


def test_normalize_and_validate_filters_illegal_and_deduplicates() -> None:
    raw = [
        "ong=on",
        "on=ong",
        "hallucinated_rule",
        "",
        "   ",
        None,
        123,
        "z_zh",
        "l=r",
        "r=l",
        "an=xyz",
        "in=ing",
    ]
    result = validate_rules(raw)

    assert result.valid == ["ong=on", "z=zh", "l=r", "in=ing"]
    assert result.rejected == ["hallucinated_rule", "", "   ", None, 123, "an=xyz"]
    assert result.alias_mapped["on=ong"] == "ong=on"
    assert result.alias_mapped["z_zh"] == "z=zh"
    assert result.alias_mapped["r=l"] == "l=r"

    assert normalize_rules(raw) == ["ong=on", "z=zh", "l=r", "in=ing"]
    assert is_valid_rule("non_existent") is False
    assert get_rule("non_existent") is None
    # 传入单个字符串时不应被拆分成单字符逐个校验
    assert normalize_rules("ong=on") == ["ong=on"]


def test_export_rime_algebra_valid_yaml_patch() -> None:
    yaml_text = export_rime_algebra(["ong=on", "zh=z", "invalid_rule", "ong=on", "l=r"])

    assert "patch:" in yaml_text
    assert "speller/algebra/+:" in yaml_text

    parsed = yaml.safe_load(yaml_text)
    assert isinstance(parsed, dict)
    assert "patch" in parsed
    assert "speller/algebra/+" in parsed["patch"]

    algebra_items = parsed["patch"]["speller/algebra/+"]
    assert algebra_items == [
        "derive/ong$/on/",
        "derive/^zh/z/",
        "derive/^z([^h])/zh$1/",
        "derive/^l/r/",
        "derive/^r/l/",
    ]
    assert get_rime_algebra_lines(["ong=on", "zh=z", "l=r"]) == algebra_items


def test_export_rime_algebra_without_comments_and_empty_input() -> None:
    no_comment_yaml = export_rime_algebra(["in=ing"], include_comments=False)
    assert "#" not in no_comment_yaml
    parsed = yaml.safe_load(no_comment_yaml)
    assert parsed == {
        "patch": {
            "speller/algebra/+": [
                "derive/in$/ing/",
                "derive/ing$/in/",
            ]
        }
    }

    empty_yaml = export_rime_algebra(["bad_1", "bad_2"])
    assert yaml.safe_load(empty_yaml) == {"patch": {"speller/algebra/+": []}}
    assert export_rime_algebra([]) == empty_yaml


def test_catalog_helpers() -> None:
    assert len(list_rules("声母")) >= 6
    assert len(list_rules("韵母")) >= 6
    assert len(list_rules("容错")) >= 4

    serialized = export_catalog()
    assert len(serialized) == len(RULES_CATALOG)
    assert serialized[0]["id"] == RULES_CATALOG[0].id
    assert isinstance(serialized[0]["algebra"], list)

    prompt_text = build_prompt_catalog_text()
    assert "ong=on" in prompt_text
    assert "l=r" in prompt_text
