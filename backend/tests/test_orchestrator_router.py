"""Orkestratör PR-1 — kural tabanlı intent testleri (LLM gerektirmez)."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from orchestrator.router import resolve_intent, rule_based_intent


def test_urgent_falls_to_escalation():
    assert rule_based_intent("Düştüm kalkamıyorum") == "escalation"
    assert rule_based_intent("Nefes alamıyorum yardım et") == "escalation"
    result = resolve_intent("Düştüm ve kalkamıyorum")
    assert result["intent"] == "escalation"
    assert result["urgency"] == "high"


def test_self_harm_phrases_to_escalation():
    assert rule_based_intent("ölmek istiyorum") == "escalation"
    assert rule_based_intent("Kendime zarar vermek istiyorum") == "escalation"
    assert rule_based_intent("Artık dayanamıyorum") == "escalation"
    assert rule_based_intent("intihar etmek istiyorum") == "escalation"


def test_medication_keyword_to_health():
    assert rule_based_intent("İlacımı içtim") == "health"
    assert rule_based_intent("Tansiyon hapımı unuttum") == "health"
    result = resolve_intent("Bugün ilaçlarımı ne zaman içeceğim?")
    assert result["intent"] == "health"


def test_default_companion_for_smalltalk():
    # Kural eşleşmezse None; resolve LLM'e gider — sadece rule kontrolü
    assert rule_based_intent("Bugün hava çok güzel") is None
    assert rule_based_intent("") is None


def test_run_orchestrator_empty_message():
    from orchestrator.graph import run_orchestrator

    result = run_orchestrator(
        message="   ",
        conversation_id="test-conv",
        user_name="Ahmet Amca",
        history=[],
    )
    assert "ai_response" in result
    assert result["routed_agent"] == "companion"


if __name__ == "__main__":
    test_urgent_falls_to_escalation()
    test_medication_keyword_to_health()
    test_default_companion_for_smalltalk()
    test_run_orchestrator_empty_message()
    print("OK — orchestrator router tests passed")
