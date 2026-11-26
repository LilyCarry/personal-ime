"""
标准可量化拼音规则词表与 Rime speller/algebra 导出模块。

为 DeepSeek 风格分析校验、前端规则开关面板、Rime 补丁生成与滑动窗口自动校准
提供统一的规则定义、别名映射、合法性校验和 YAML 导出接口。
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

RuleCategory = Literal["声母", "韵母", "容错"]

RULE_CATEGORIES: tuple[RuleCategory, ...] = ("声母", "韵母", "容错")

_SEP_RE = re.compile(r"\s*(?:<->|<=>|↔|->|=>|=|/|:|_|-)\s*")


@dataclass(frozen=True, slots=True)
class PinyinRule:
    """单条可量化拼音规则定义。"""

    id: str
    label: str
    category: RuleCategory
    description: str
    algebra: tuple[str, ...]
    examples: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        """转换为可 JSON 序列化的字典结构。"""
        return {
            "id": self.id,
            "label": self.label,
            "category": self.category,
            "description": self.description,
            "algebra": list(self.algebra),
            "examples": list(self.examples),
        }


@dataclass(frozen=True, slots=True)
class RuleValidationResult:
    """规则列表校验结果。"""

    valid: list[str]
    rejected: list[Any]
    alias_mapped: dict[str, str]


RULES_CATALOG: tuple[PinyinRule, ...] = (
    # --- 声母规则 ---
    PinyinRule(
        id="z=zh",
        label="平翘舌 z / zh 互通",
        category="声母",
        description="允许 z 与 zh 声母互相模糊匹配，缓解平翘舌混淆。",
        algebra=(
            "derive/^zh/z/",
            "derive/^z([^h])/zh$1/",
        ),
        examples=("zi -> zhi", "zhao -> zao"),
    ),
    PinyinRule(
        id="c=ch",
        label="平翘舌 c / ch 互通",
        category="声母",
        description="允许 c 与 ch 声母互相模糊匹配，缓解平翘舌混淆。",
        algebra=(
            "derive/^ch/c/",
            "derive/^c([^h])/ch$1/",
        ),
        examples=("ci -> chi", "chang -> cang"),
    ),
    PinyinRule(
        id="s=sh",
        label="平翘舌 s / sh 互通",
        category="声母",
        description="允许 s 与 sh 声母互相模糊匹配，缓解平翘舌混淆。",
        algebra=(
            "derive/^sh/s/",
            "derive/^s([^h])/sh$1/",
        ),
        examples=("si -> shi", "shuo -> suo"),
    ),
    PinyinRule(
        id="l=n",
        label="边鼻音 l / n 互通",
        category="声母",
        description="允许声母 l 与 n 互相派生，适配南北方言或连打易混场景。",
        algebra=(
            "derive/^l/n/",
            "derive/^n/l/",
        ),
        examples=("lai -> nai", "nan -> lan"),
    ),
    PinyinRule(
        id="l=r",
        label="声母 l / r 互通",
        category="声母",
        description="允许声母 l 与 r 互相派生，兼容 l/r 混淆输入习惯。",
        algebra=(
            "derive/^l/r/",
            "derive/^r/l/",
        ),
        examples=("ren -> len", "lu -> ru"),
    ),
    PinyinRule(
        id="f=h",
        label="声母 f / h 互通",
        category="声母",
        description="允许声母 f 与 h 互相派生，覆盖常见 f/h 混淆发音。",
        algebra=(
            "derive/^f/h/",
            "derive/^h/f/",
        ),
        examples=("fei -> hei", "hua -> fa"),
    ),
    PinyinRule(
        id="g=k",
        label="声母 g / k 互通",
        category="声母",
        description="允许声母 g 与 k 互相派生，减少相近清浊音误触。",
        algebra=(
            "derive/^g/k/",
            "derive/^k/g/",
        ),
        examples=("gao -> kao", "kai -> gai"),
    ),
    # --- 韵母规则 ---
    PinyinRule(
        id="ong=on",
        label="后鼻音省尾 ong / on",
        category="韵母",
        description="允许将后鼻音 ong 简写为 on，贴合快速敲击时省去末尾 g 的习惯。",
        algebra=(
            "derive/ong$/on/",
        ),
        examples=("dong -> don", "zhong -> zhon"),
    ),
    PinyinRule(
        id="in=ing",
        label="前后鼻音 in / ing 互通",
        category="韵母",
        description="允许前鼻音 in 与后鼻音 ing 互相模糊匹配。",
        algebra=(
            "derive/in$/ing/",
            "derive/ing$/in/",
        ),
        examples=("jin -> jing", "ming -> min"),
    ),
    PinyinRule(
        id="en=eng",
        label="前后鼻音 en / eng 互通",
        category="韵母",
        description="允许前鼻音 en 与后鼻音 eng 互相模糊匹配。",
        algebra=(
            "derive/en$/eng/",
            "derive/eng$/en/",
        ),
        examples=("fen -> feng", "cheng -> chen"),
    ),
    PinyinRule(
        id="an=ang",
        label="前后鼻音 an / ang 互通",
        category="韵母",
        description="允许前鼻音 an 与后鼻音 ang 互相模糊匹配。",
        algebra=(
            "derive/an$/ang/",
            "derive/ang$/an/",
        ),
        examples=("ban -> bang", "zhang -> zhan"),
    ),
    PinyinRule(
        id="ian=iang",
        label="前后鼻音 ian / iang 互通",
        category="韵母",
        description="允许韵母 ian 与 iang 互相模糊匹配。",
        algebra=(
            "derive/ian$/iang/",
            "derive/iang$/ian/",
        ),
        examples=("jian -> jiang", "xiang -> xian"),
    ),
    PinyinRule(
        id="uan=uang",
        label="前后鼻音 uan / uang 互通",
        category="韵母",
        description="允许韵母 uan 与 uang 互相模糊匹配。",
        algebra=(
            "derive/uan$/uang/",
            "derive/uang$/uan/",
        ),
        examples=("huan -> huang", "guang -> guan"),
    ),
    PinyinRule(
        id="ong=eng",
        label="韵母 ong / eng 互通",
        category="韵母",
        description="允许韵母 ong 与 eng 互相派生，兼容部分方言韵母混淆。",
        algebra=(
            "derive/ong$/eng/",
            "derive/eng$/ong/",
        ),
        examples=("feng -> fong", "dong -> deng"),
    ),
    PinyinRule(
        id="ong=un",
        label="韵母 ong / un 互通",
        category="韵母",
        description="允许韵母 ong 与 un 互相派生。",
        algebra=(
            "derive/ong$/un/",
            "derive/un$/ong/",
        ),
        examples=("lun -> long", "zong -> zun"),
    ),
    # --- 容错规则 ---
    PinyinRule(
        id="ue=ve",
        label="拼写容错 ue / ve 互通",
        category="容错",
        description="允许 n/l 后的 ue 与 ve 互相转换（如 nue 与 nve）。",
        algebra=(
            "derive/^([nl])ve$/$1ue/",
            "derive/^([nl])ue$/$1ve/",
        ),
        examples=("nue -> nve", "lve -> lue"),
    ),
    PinyinRule(
        id="ju=jv",
        label="拼写容错 jqxy 后 u / v 互通",
        category="容错",
        description="允许 j/q/x/y 后的 u 与 v 互相转换（如 qv 匹配 qu）。",
        algebra=(
            "derive/^([jqxy])u/$1v/",
            "derive/^([jqxy])v/$1u/",
        ),
        examples=("qv -> qu", "xue -> xve"),
    ),
    PinyinRule(
        id="an=na",
        label="击键换序容错 an / na",
        category="容错",
        description="纠正高速连打时末尾 an 误按成 na 的邻键换序错误。",
        algebra=(
            "derive/([wrtypsdfghklzcbnm])an$/$1na/",
        ),
        examples=("dna -> dan", "bna -> ban"),
    ),
    PinyinRule(
        id="en=ne",
        label="击键换序容错 en / ne",
        category="容错",
        description="纠正高速连打时末尾 en 误按成 ne 的邻键换序错误。",
        algebra=(
            "derive/([wrpsdfghklzcbnm])en$/$1ne/",
        ),
        examples=("rne -> ren", "mne -> men"),
    ),
    PinyinRule(
        id="in=ni",
        label="击键换序容错 in / ni",
        category="容错",
        description="纠正高速连打时末尾 in 误按成 ni 的邻键换序错误。",
        algebra=(
            "derive/([qypjlxbnm])in$/$1ni/",
        ),
        examples=("qni -> qin", "xni -> xin"),
    ),
    PinyinRule(
        id="un=nu",
        label="击键换序容错 un / nu",
        category="容错",
        description="纠正高速连打时末尾 un 误按成 nu 的邻键换序错误。",
        algebra=(
            "derive/([qrtysdghjklzxc])un$/$1nu/",
        ),
        examples=("qnu -> qun", "xnu -> xun"),
    ),
    PinyinRule(
        id="ai=ia",
        label="韵母换序容错 ai / ia",
        category="容错",
        description="纠正 w/g/h/k 后 ai 误打成 ia 的换序错误。",
        algebra=(
            "derive/^([wghk])ai$/$1ia/",
        ),
        examples=("wia -> wai", "kia -> kai"),
    ),
    PinyinRule(
        id="ei=ie",
        label="韵母换序容错 ei / ie",
        category="容错",
        description="纠正 w/f/g/h/k/z 后 ei 误打成 ie 的换序错误。",
        algebra=(
            "derive/([wfghkz])ei$/$1ie/",
        ),
        examples=("wie -> wei", "fie -> fei"),
    ),
    PinyinRule(
        id="zh=hz",
        label="翘舌换序容错 zh/ch/sh",
        category="容错",
        description="纠正高速敲击时 zh/ch/sh 与元音之间的先后键位倒置。",
        algebra=(
            "derive/([zcs])h(a|e|i|u|ai|ei|an|en|ou|uo|ua|un|ui|uan|uai|uang|ang|eng|ong)$/h$1$2/",
            "derive/([zcs])h([aeiu])$/$1$2h/",
        ),
        examples=("hzi -> zhi", "zih -> zhi"),
    ),
)

RULES_BY_ID: dict[str, PinyinRule] = {rule.id: rule for rule in RULES_CATALOG}
VALID_RULE_IDS: frozenset[str] = frozenset(RULES_BY_ID)

# 标准规则反向/常见别名前置映射表（均映射到 RULES_BY_ID 中的规范 ID）
RULE_ALIASES: dict[str, str] = {
    "zh=z": "z=zh",
    "ch=c": "c=ch",
    "sh=s": "s=sh",
    "n=l": "l=n",
    "r=l": "l=r",
    "h=f": "f=h",
    "k=g": "g=k",
    "on=ong": "ong=on",
    "ing=in": "in=ing",
    "eng=en": "en=eng",
    "ang=an": "an=ang",
    "iang=ian": "ian=iang",
    "uang=uan": "uan=uang",
    "eng=ong": "ong=eng",
    "un=ong": "ong=un",
    "ve=ue": "ue=ve",
    "jv=ju": "ju=jv",
    "u=v": "ju=jv",
    "v=u": "ju=jv",
    "na=an": "an=na",
    "ne=en": "en=ne",
    "ni=in": "in=ni",
    "nu=un": "un=nu",
    "ia=ai": "ai=ia",
    "ie=ei": "ei=ie",
    "hz=zh": "zh=hz",
}


def normalize_rule_id(raw_id: Any) -> str | None:
    """
    将单个候选规则 ID 规范化为标准词表中的 canonical ID。
    支持大小写归一化、常见分隔符（_ / - / <-> / -> / 空格）归一化与双向等价映射；
    遇到非法类型、空字符串或词表外的幻觉规则时返回 None。
    """
    if not isinstance(raw_id, str):
        return None
    cleaned = raw_id.strip().lower()
    if not cleaned:
        return None

    if cleaned in RULES_BY_ID:
        return cleaned
    if cleaned in RULE_ALIASES:
        return RULE_ALIASES[cleaned]

    normalized_sep = _SEP_RE.sub("=", cleaned)
    if normalized_sep in RULES_BY_ID:
        return normalized_sep
    if normalized_sep in RULE_ALIASES:
        return RULE_ALIASES[normalized_sep]
    return None


def is_valid_rule(raw_id: Any) -> bool:
    """判断输入是否可映射为词表中的合法规则。"""
    return normalize_rule_id(raw_id) is not None


def get_rule(raw_id: Any) -> PinyinRule | None:
    """根据规则 ID 或等价别名获取标准规则对象，无效则返回 None。"""
    canonical = normalize_rule_id(raw_id)
    if canonical is None:
        return None
    return RULES_BY_ID[canonical]


def validate_rules(raw_rules: Iterable[Any]) -> RuleValidationResult:
    """
    对候选规则列表做白名单校验、别名映射与去重（保留首次出现的顺序）。
    返回包含有效规则列表、被拦截项以及别名映射记录的 RuleValidationResult。
    """
    if isinstance(raw_rules, (str, bytes)):
        items: Iterable[Any] = (raw_rules,)
    else:
        items = raw_rules

    valid: list[str] = []
    seen: set[str] = set()
    rejected: list[Any] = []
    alias_mapped: dict[str, str] = {}

    for item in items:
        canonical = normalize_rule_id(item)
        if canonical is None:
            rejected.append(item)
            continue
        if isinstance(item, str) and item != canonical:
            alias_mapped[item] = canonical
        if canonical not in seen:
            seen.add(canonical)
            valid.append(canonical)

    return RuleValidationResult(
        valid=valid,
        rejected=rejected,
        alias_mapped=alias_mapped,
    )


def normalize_rules(raw_rules: Iterable[Any]) -> list[str]:
    """
    过滤非法或幻觉规则、完成标准规则 ID 映射并保持原顺序去重。
    """
    return validate_rules(raw_rules).valid


def list_rules(category: RuleCategory | None = None) -> list[PinyinRule]:
    """返回全部或指定分类的标准规则列表。"""
    if category is None:
        return list(RULES_CATALOG)
    return [rule for rule in RULES_CATALOG if rule.category == category]


def export_catalog(category: RuleCategory | None = None) -> list[dict[str, Any]]:
    """导出可 JSON 序列化的规则词表（供后端接口与前端开关面板使用）。"""
    return [rule.to_dict() for rule in list_rules(category)]


def get_rime_algebra_lines(rule_ids: Iterable[Any]) -> list[str]:
    """
    根据规则 ID 列表提取去重后的 Rime speller/algebra 表达式列表。
    非法规则会被自动忽略。
    """
    canonical_ids = normalize_rules(rule_ids)
    lines: list[str] = []
    seen_lines: set[str] = set()
    for rule_id in canonical_ids:
        rule = RULES_BY_ID[rule_id]
        for expr in rule.algebra:
            if expr not in seen_lines:
                seen_lines.add(expr)
                lines.append(expr)
    return lines


def export_rime_algebra(rule_ids: Iterable[Any], *, include_comments: bool = True) -> str:
    """
    一键生成可直接粘贴进 rime_ice.custom.yaml 的 Rime patch YAML 补丁文本。
    即使输入为空或全部为非法规则，也返回合法的空列表补丁结构。
    """
    canonical_ids = normalize_rules(rule_ids)
    if not canonical_ids:
        return "patch:\n  speller/algebra/+: []\n"

    lines = ["patch:", "  speller/algebra/+:"]
    seen_expr: set[str] = set()

    for rule_id in canonical_ids:
        rule = RULES_BY_ID[rule_id]
        rule_exprs = [expr for expr in rule.algebra if expr not in seen_expr]
        if not rule_exprs:
            continue
        if include_comments:
            lines.append(f"    # [{rule.id}] {rule.label}")
        for expr in rule_exprs:
            seen_expr.add(expr)
            escaped = expr.replace("'", "''")
            lines.append(f"    - '{escaped}'")

    if len(lines) == 2:
        return "patch:\n  speller/algebra/+: []\n"
    return "\n".join(lines) + "\n"


def build_prompt_catalog_text() -> str:
    """生成供 LLM Prompt 使用的紧凑规则词表说明文本。"""
    parts: list[str] = []
    for category in RULE_CATEGORIES:
        parts.append(f"[{category}]")
        for rule in list_rules(category):
            parts.append(f"- {rule.id}: {rule.label} ({rule.description})")
    return "\n".join(parts)


if __name__ == "__main__":
    sample_input = ["ong=on", "zh=z", "l_r", "hallucinated_rule", "ong=on"]
    clean_ids = normalize_rules(sample_input)
    print("=== Normalized Rule IDs ===")
    print(json.dumps(clean_ids, ensure_ascii=False))
    print("\n=== Exported Rime Algebra YAML ===")
    print(export_rime_algebra(clean_ids), end="")
