"""Mood normalize + decline detection unit tests (DB yok)."""

from services.family_insights import (
    detect_mood_decline,
    normalize_mood,
    score_text_sentiment,
)


def test_normalize_mood_variants():
    assert normalize_mood("Harika!")["key"] == "great"
    assert normalize_mood("Biraz halsizim")["key"] == "tired"
    assert normalize_mood("good")["label"] == "İyi"
    assert normalize_mood(None)["key"] == "unknown"


def test_sentiment_and_risk():
    pos = score_text_sentiment("Bugün çok iyiyim, teşekkürler")
    assert pos["score"] > 0
    risk = score_text_sentiment("Düştüm, nefessiz kaldım")
    assert risk["risk"] is True
    assert risk["score"] < 0


def test_mood_decline_streak():
    series = [
        {"avg_score": 2.5, "label": "İyi"},
        {"avg_score": 1.0, "label": "Halsiz"},
        {"avg_score": 0.8, "label": "Kötü"},
        {"avg_score": 1.0, "label": "Halsiz"},
    ]
    result = detect_mood_decline(series, streak=3)
    assert result["triggered"] is True


if __name__ == "__main__":
    test_normalize_mood_variants()
    test_sentiment_and_risk()
    test_mood_decline_streak()
    print("OK — family insights mood tests")
