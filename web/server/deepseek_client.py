"""DeepSeek API client with JSON Mode, rule whitelisting, and local fallback."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import httpx

from profiler.rules_schema import (
    RULES_BY_ID,
    build_prompt_catalog_text,
    export_rime_algebra,
    normalize_rule_id,
)

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
DEFAULT_TIMEOUT_SEC = 6.0


@dataclass(frozen=True, slots=True)
class AnalyzeResult:
    """Normalized analysis result returned by DeepSeek or local fallback."""

    title: str
    comment: str
    rules: list[str]
    rule_reasons: dict[str, str]
    rime_yaml: str
    fallback: bool


def _get_timeout_sec() -> float:
    raw = os.getenv("DEEPSEEK_TIMEOUT_SEC", "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SEC
    try:
        value = float(raw)
        return max(0.5, min(value, 30.0))
    except ValueError:
        return DEFAULT_TIMEOUT_SEC


def _build_messages(
    *,
    target_text: str,
    target_pinyin: str,
    typed_input: str,
    duration_sec: float,
    cpm: float,
    accuracy: float,
    backspaces: int,
) -> list[dict[str, str]]:
    catalog_text = build_prompt_catalog_text()
    system_prompt = (
        "你是一位幽默接地气的中文输入法教练，负责根据课堂打字竞速数据生成趣味点评和可量化的拼音模糊音/容错规则推荐。\n"
        "请严格输出合法的 JSON 对象，不要输出任何额外说明或 Markdown 代码块，JSON 字段要求如下：\n"
        '1. "title": 4~8 个字的趣味打字风格称号（字符串）\n'
        '2. "comment": 40~80 字的接地气趣味风格点评（字符串，可结合速度、精准度、退格次数与拼写习惯）\n'
        '3. "rules": 推荐的规则列表（数组，最多 4 条），每个元素为对象 {"id": "<规则ID>", "reason": "<15~30字简短理由>"}\n'
        "其中规则 ID 必须严格从以下标准词表中挑选，禁止自造不存在的 ID：\n"
        f"{catalog_text}"
    )
    user_prompt = json.dumps(
        {
            "target_text": target_text,
            "target_pinyin": target_pinyin,
            "typed_input": typed_input,
            "duration_sec": round(duration_sec, 2),
            "cpm": round(cpm, 1),
            "accuracy": round(accuracy, 1),
            "backspaces": int(backspaces),
        },
        ensure_ascii=False,
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def _extract_valid_rules(payload: dict[str, Any]) -> tuple[list[str], dict[str, str]]:
    """Filter DeepSeek rule suggestions against the profiler.rules_schema whitelist."""
    raw_rules = payload.get("rules", [])
    raw_reasons = payload.get("rule_reasons", {})
    if not isinstance(raw_reasons, dict):
        raw_reasons = {}

    valid_rules: list[str] = []
    seen: set[str] = set()
    rule_reasons: dict[str, str] = {}

    items = raw_rules if isinstance(raw_rules, list) else []
    for item in items:
        reason = ""
        if isinstance(item, dict):
            candidate_id = item.get("id") or item.get("rule_id")
            reason = str(item.get("reason", "")).strip()
        else:
            candidate_id = item
            if isinstance(candidate_id, str):
                reason = str(raw_reasons.get(candidate_id, "")).strip()

        canonical = normalize_rule_id(candidate_id)
        if canonical is None:
            continue
        if canonical not in seen:
            seen.add(canonical)
            valid_rules.append(canonical)
            if not reason:
                reason = RULES_BY_ID[canonical].description
            rule_reasons[canonical] = reason
        if len(valid_rules) >= 5:
            break

    return valid_rules, rule_reasons


def _heuristic_fallback(
    *,
    target_pinyin: str,
    typed_input: str,
    cpm: float,
    accuracy: float,
    backspaces: int,
) -> AnalyzeResult:
    """Deterministic local fallback when DeepSeek API key is absent or request fails."""
    typed_lower = typed_input.lower()
    target_lower = target_pinyin.lower()

    matched_rules: list[str] = []
    rule_reasons: dict[str, str] = {}

    def _add(rule_id: str, reason: str) -> None:
        if rule_id in RULES_BY_ID and rule_id not in matched_rules and len(matched_rules) < 4:
            matched_rules.append(rule_id)
            rule_reasons[rule_id] = reason

    if ("ong" in target_lower and "on" in typed_lower) or "zhon" in typed_lower or "don" in typed_lower:
        _add("ong=on", "检测到后鼻音 ong 省尾倾向，开启可减少末尾 g 漏敲。")
    if any(tok in typed_lower for tok in ("zh", "ch", "sh")) or any(
        tok in target_lower for tok in ("zh", "ch", "sh")
    ):
        if accuracy < 98.0:
            _add("z=zh", "平翘舌连打易混淆，开启 z/zh 互通可降低回改率。")
    if "in" in target_lower or "ing" in target_lower:
        if accuracy < 98.0:
            _add("in=ing", "前后鼻音高速输入易混，开启后候选词更宽容。")
    if "l" in typed_lower and "r" in target_lower:
        _add("l=r", "检测到 l/r 键位替换痕迹，开启声母互通可提升容错。")

    if not matched_rules and accuracy < 99.0:
        _add("ong=on", "高速连打时省去后鼻音尾键可有效提升击键流畅度。")
        _add("in=ing", "开启前后鼻音互通，减少细微拼写偏差带来的退格。")

    if cpm >= 200 and accuracy >= 95:
        title = "键盘无影手"
    elif cpm >= 160 and backspaces >= 5:
        title = "疾风回删侠"
    elif accuracy >= 96:
        title = "稳健精准派"
    elif cpm >= 150:
        title = "极速省电派"
    else:
        title = "潜力节奏手"

    comment = (
        f"本次输入速度 {cpm:.1f} 字/分、精准度 {accuracy:.1f}%、退格 {backspaces} 次。"
        "已为你生成本地规则推荐，开启对应模糊音容错可进一步减少回删、稳步提速。"
    )

    return AnalyzeResult(
        title=title,
        comment=comment,
        rules=matched_rules,
        rule_reasons=rule_reasons,
        rime_yaml=export_rime_algebra(matched_rules),
        fallback=True,
    )


def _request_deepseek_json(
    endpoint: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout_sec: float,
) -> dict[str, Any]:
    """Execute HTTP POST to DeepSeek Chat Completions and parse JSON response."""
    with httpx.Client(timeout=timeout_sec) as client:
        resp = client.post(endpoint, headers=headers, json=body)
        resp.raise_for_status()
        return resp.json()


def analyze_typing_style(
    *,
    target_text: str,
    target_pinyin: str,
    typed_input: str,
    duration_sec: float,
    cpm: float,
    accuracy: float,
    backspaces: int = 0,
) -> AnalyzeResult:
    """Call DeepSeek JSON Mode API to analyze typing style, with local fallback."""
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return _heuristic_fallback(
            target_pinyin=target_pinyin,
            typed_input=typed_input,
            cpm=cpm,
            accuracy=accuracy,
            backspaces=backspaces,
        )

    base_url = os.getenv("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")
    model = os.getenv("DEEPSEEK_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    timeout_sec = _get_timeout_sec()
    endpoint = f"{base_url}/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": _build_messages(
            target_text=target_text,
            target_pinyin=target_pinyin,
            typed_input=typed_input,
            duration_sec=duration_sec,
            cpm=cpm,
            accuracy=accuracy,
            backspaces=backspaces,
        ),
        "response_format": {"type": "json_object"},
        "temperature": 0.7,
    }

    try:
        data = _request_deepseek_json(endpoint, headers, body, timeout_sec)
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError("DeepSeek JSON content is not an object")
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        return _heuristic_fallback(
            target_pinyin=target_pinyin,
            typed_input=typed_input,
            cpm=cpm,
            accuracy=accuracy,
            backspaces=backspaces,
        )

    title = str(parsed.get("title", "")).strip() or "节奏输入派"
    comment = str(parsed.get("comment", "")).strip() or (
        f"速度 {cpm:.1f} 字/分、精准度 {accuracy:.1f}%，已为你匹配专属拼音容错规则。"
    )
    valid_rules, rule_reasons = _extract_valid_rules(parsed)

    return AnalyzeResult(
        title=title,
        comment=comment,
        rules=valid_rules,
        rule_reasons=rule_reasons,
        rime_yaml=export_rime_algebra(valid_rules),
        fallback=False,
    )
