"""PR-3b — seçici SMS: ağrı 7'de yok, 9+'da var; Twilio stub."""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.sms_service import (
    SMS_PAIN_ESCALATION_THRESHOLD,
    maybe_notify_family_sms,
    send_family_sms,
    should_send_family_sms,
)


def test_sms_pain_threshold_default_is_nine():
    assert SMS_PAIN_ESCALATION_THRESHOLD == 9


def test_pain_seven_escalates_but_no_sms_gate():
    """WS eskalasyonu için 7 yeterli; SMS için değil."""
    assert should_send_family_sms(pain_level=7, intent="health", urgency="high") is False
    assert should_send_family_sms(pain_level=8, intent="health", urgency="high") is False


def test_pain_nine_triggers_sms_gate():
    assert should_send_family_sms(pain_level=9, intent="health", urgency="high") is True
    assert should_send_family_sms(pain_level=10, is_danger=False) is True


def test_danger_and_router_escalation_trigger_sms():
    assert should_send_family_sms(pain_level=2, is_danger=True) is True
    assert should_send_family_sms(
        pain_level=None, intent="escalation", urgency="high"
    ) is True


def test_send_family_sms_stub_when_disabled():
    with patch.dict(os.environ, {"FAMILY_SMS_ENABLED": "false"}, clear=False):
        result = send_family_sms("+905551112233", "Test kritik uyarı")
        assert result
        assert result["mode"] == "stub"
        assert result["to"] == "+905551112233"


def test_to_e164_turkish_local():
    from services.sms_service import to_e164

    assert to_e164("5444444444") == "+905444444444"
    assert to_e164("0544 444 44 44") == "+905444444444"
    assert to_e164("+905444444444") == "+905444444444"


def test_maybe_notify_pain_7_does_not_call_send():
    state = {
        "intent": "health",
        "urgency": "high",
        "health_decision": {"pain_level": 7, "is_danger": False},
        "escalation_reason": "Ağrı seviyesi 7/10 (eşik 7).",
        "user_id": "user-1",
        "elder_id": "elder-1",
        "user_name": "Ayşe",
    }
    with patch("services.sms_service.send_family_sms") as mock_send:
        result = maybe_notify_family_sms(state)
    assert result["attempted"] is False
    assert result["sent"] is False
    assert result["reason"] == "below_sms_threshold"
    mock_send.assert_not_called()


def test_maybe_notify_pain_9_sends_sms():
    state = {
        "intent": "health",
        "urgency": "high",
        "health_decision": {"pain_level": 9, "is_danger": False},
        "escalation_reason": "Ağrı seviyesi 9/10 (eşik 7).",
        "user_id": "user-1",
        "elder_id": "elder-1",
        "user_name": "Ayşe",
        "user_message": "Ağrım 9",
    }
    with (
        patch(
            "services.sms_service.resolve_family_contact",
            return_value={"phone": "+905551112233", "sms_enabled": True},
        ),
        patch("services.sms_service.send_family_sms", return_value=True) as mock_send,
    ):
        result = maybe_notify_family_sms(state)

    assert result["attempted"] is True
    assert result["sent"] is True
    mock_send.assert_called_once()
    args = mock_send.call_args[0]
    assert args[0] == "+905551112233"
    assert "KRİTİK" in args[1] or "kritik" in args[1].lower() or "Kritik" in args[1]


def test_escalation_node_pain_7_no_sms_send():
    from orchestrator.nodes.escalation import escalation_node

    with (
        patch("orchestrator.nodes.escalation._try_insert_alert"),
        patch("orchestrator.nodes.escalation._notify_family"),
        patch("services.sms_service.send_family_sms") as mock_send,
        patch(
            "services.sms_service.resolve_family_contact",
            return_value={"phone": "+905551112233", "sms_enabled": True},
        ),
    ):
        out = escalation_node(
            {
                "user_name": "Ayşe",
                "elder_id": "elder-1",
                "user_id": "user-1",
                "user_message": "Bel ağrım 7",
                "intent": "health",
                "urgency": "high",
                "escalation_reason": "Ağrı seviyesi 7/10 (eşik 7).",
                "health_decision": {"pain_level": 7, "is_danger": False},
            }
        )

    assert out["sms_result"]["attempted"] is False
    mock_send.assert_not_called()


def test_escalation_node_pain_9_calls_sms():
    from orchestrator.nodes.escalation import escalation_node

    with (
        patch("orchestrator.nodes.escalation._try_insert_alert"),
        patch("orchestrator.nodes.escalation._notify_family"),
        patch("services.sms_service.send_family_sms", return_value=True) as mock_send,
        patch(
            "services.sms_service.resolve_family_contact",
            return_value={"phone": "+905551112233", "sms_enabled": True},
        ),
    ):
        out = escalation_node(
            {
                "user_name": "Ayşe",
                "elder_id": "elder-1",
                "user_id": "user-1",
                "user_message": "Ağrım 9",
                "intent": "health",
                "urgency": "high",
                "escalation_reason": "Ağrı seviyesi 9/10 (eşik 7).",
                "health_decision": {"pain_level": 9, "is_danger": False},
            }
        )

    assert out["sms_result"]["sent"] is True
    mock_send.assert_called_once()


if __name__ == "__main__":
    test_sms_pain_threshold_default_is_nine()
    test_pain_seven_escalates_but_no_sms_gate()
    test_pain_nine_triggers_sms_gate()
    test_danger_and_router_escalation_trigger_sms()
    test_send_family_sms_stub_when_disabled()
    test_maybe_notify_pain_7_does_not_call_send()
    test_maybe_notify_pain_9_sends_sms()
    test_escalation_node_pain_7_no_sms_send()
    test_escalation_node_pain_9_calls_sms()
    print("OK — PR-3b SMS escalation tests passed")
