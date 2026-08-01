"""Orkestratör — yanlış pozitif / risk skor eval seti."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from orchestrator.router import rule_based_intent, resolve_intent
from services.risk_scoring import score_message_risk
from services.voice_junk import is_whisper_junk


def test_urgent_still_escalates():
    cases = [
        "Düştüm kalkamıyorum",
        "Nefes alamıyorum yardım et",
        "Göğsüm ağrıyor acil yardım",
        "Ambulans çağırın",
        "acil",
        "ölmek istiyorum",
        "Kendime zarar vermek istiyorum",
    ]
    for text in cases:
        assert rule_based_intent(text) == "escalation", text
        risk = score_message_risk(text)
        assert risk["flagged"] or risk["score"] >= 70, text


def test_false_positives_not_escalation():
    """Gündelik / hikâye cümleleri escalation olmamalı."""
    safe = [
        "Bugün hava çok güzel",
        "Filmde biri düştü",
        "Komşuya yardım ettim",
        "Bulaşığa yardım eder misin",
        "Acil değil, biraz yorgunum",
        "Markete gittim",
        "Torunuma yardım ettim",
        "Merhaba nasılsın",
        "İyi akşamlar",
    ]
    for text in safe:
        assert rule_based_intent(text) != "escalation", f"FP escalation: {text}"
        risk = score_message_risk(text)
        assert risk["score"] < 70, f"FP high score ({risk['score']}): {text}"


def test_health_not_confused_with_emergency():
    assert rule_based_intent("İlacımı içtim") == "health"
    assert rule_based_intent("Başım ağrıyor") == "health"
    assert rule_based_intent("Tansiyon hapımı unuttum") == "health"


def test_whisper_junk_filter():
    assert is_whisper_junk("") is True
    assert is_whisper_junk("İzlediğiniz için teşekkür ederim") is True
    assert is_whisper_junk("Thanks for watching") is True
    assert is_whisper_junk("Merhaba nasılsın") is False
    assert is_whisper_junk("İlacımı aldım") is False


def test_resolve_urgent_high():
    result = resolve_intent("Düştüm ve kalkamıyorum")
    assert result["intent"] == "escalation"
    assert result["urgency"] == "high"


if __name__ == "__main__":
    test_urgent_still_escalates()
    test_false_positives_not_escalation()
    test_health_not_confused_with_emergency()
    test_whisper_junk_filter()
    test_resolve_urgent_high()
    print("OK — risk eval + voice junk tests passed")
