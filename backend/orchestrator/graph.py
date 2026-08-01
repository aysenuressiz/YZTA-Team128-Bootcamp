"""LangGraph orkestratör — intent router + ortak hafıza + 3 ajan."""

from __future__ import annotations

import os
from typing import Any, Literal

from langgraph.graph import END, START, StateGraph

from orchestrator.memory.long_term import memory_backend_name, search_memories
from orchestrator.memory.short_term import load_recent_messages
from orchestrator.memory.structured import build_structured_context
from orchestrator.nodes.companion import companion_node
from orchestrator.nodes.escalation import escalation_node
from orchestrator.nodes.health import health_node
from orchestrator.router import resolve_intent
from orchestrator.state import AgentState

_compiled_graph = None


def load_context_node(state: AgentState) -> AgentState:
    """Aşama 2: uzun süreli + yapılandırılmış bağlamı State'e yükler."""
    elder_id = state.get("elder_id") or ""
    conversation_id = state.get("conversation_id") or ""
    query = state.get("user_message") or ""

    memories = search_memories(elder_id, query, limit=5) if elder_id or query else []
    structured = build_structured_context(elder_id or None, conversation_id or None)

    return {
        **state,
        "retrieved_memories": memories,
        "structured_context": structured,
    }


def route_node(state: AgentState) -> AgentState:
    result = resolve_intent(state.get("user_message", ""), state.get("chat_history"))
    return {
        **state,
        "intent": result["intent"],
        "urgency": result.get("urgency", "low"),
        "escalation_reason": result.get("reason"),
    }


def pick_agent(state: AgentState) -> Literal["companion", "health", "escalation"]:
    intent = state.get("intent") or "companion"
    if intent in {"companion", "health", "escalation"}:
        return intent  # type: ignore[return-value]
    return "companion"


def check_health_escalation(state: AgentState) -> Literal["escalation", "end"]:
    """PR-2: Sağlık düğümünden sonra anomali varsa Eskalasyon'a geç."""
    if state.get("escalation_needed"):
        return "escalation"
    return "end"


def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("load_context", load_context_node)
    workflow.add_node("router", route_node)
    workflow.add_node("companion", companion_node)
    workflow.add_node("health", health_node)
    workflow.add_node("escalation", escalation_node)

    workflow.add_edge(START, "load_context")
    workflow.add_edge("load_context", "router")
    workflow.add_conditional_edges(
        "router",
        pick_agent,
        {
            "companion": "companion",
            "health": "health",
            "escalation": "escalation",
        },
    )
    workflow.add_edge("companion", END)
    workflow.add_conditional_edges(
        "health",
        check_health_escalation,
        {
            "escalation": "escalation",
            "end": END,
        },
    )
    workflow.add_edge("escalation", END)
    return workflow.compile()


def get_graph():
    global _compiled_graph
    # Geliştirme sırasında düğüm değişikliklerinin yüklenmesi için her seferinde derlenebilir;
    # production'da cache tutulur. Reload ile uvicorn zaten process yeniler.
    if _compiled_graph is None:
        _compiled_graph = build_graph()
    return _compiled_graph


def reset_graph_cache() -> None:
    global _compiled_graph
    _compiled_graph = None


def run_orchestrator(
    message: str,
    conversation_id: str,
    elder_id: str | None = None,
    user_name: str | None = None,
    user_id: str | None = None,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Tek giriş noktası — chat/voice endpoint'lerinden çağrılır."""
    chat_history = history if history is not None else load_recent_messages(conversation_id)

    initial: AgentState = {
        "elder_id": elder_id or "",
        "conversation_id": conversation_id or "",
        "user_id": user_id,
        "user_name": user_name,
        "user_message": (message or "").strip(),
        "chat_history": chat_history,
        "retrieved_memories": [],
        "structured_context": {},
        "intent": "companion",
        "urgency": "low",
        "agent_response": "",
        "escalation_needed": False,
        "escalation_reason": None,
        "routed_agent": "companion",
        "memories_stored": [],
    }

    if not initial["user_message"]:
        return {
            "ai_response": f"{user_name or 'Canım'}, seni duyamadım. Tekrar söyler misin?",
            "intent": "companion",
            "routed_agent": "companion",
            "escalation": False,
            "urgency": "low",
            "memory_backend": memory_backend_name(),
        }

    final_state = get_graph().invoke(initial)

    # Her turda risk skoru (aile paneli geçmişi); yükseklerde persist
    risk_payload = None
    try:
        from services.risk_scoring import persist_risk_event, score_message_risk

        risk_payload = score_message_risk(
            initial["user_message"],
            intent=final_state.get("intent"),
            urgency=final_state.get("urgency"),
            escalated=bool(final_state.get("escalation_needed")),
        )
        persist_risk_event(
            elder_id=elder_id,
            user_id=user_id,
            message=initial["user_message"],
            risk=risk_payload,
            conversation_id=conversation_id,
            reason=final_state.get("escalation_reason"),
        )
    except Exception as risk_err:
        print(f"[ORCHESTRATOR] risk skor atlandı: {risk_err}")

    return {
        "ai_response": final_state.get("agent_response") or "Bir sorun oluştu, tekrar dener misin?",
        "intent": final_state.get("intent", "companion"),
        "routed_agent": final_state.get("routed_agent", "companion"),
        "escalation": bool(final_state.get("escalation_needed")),
        "urgency": final_state.get("urgency", "low"),
        "escalation_reason": final_state.get("escalation_reason"),
        "risk": risk_payload,
        "memories_used": final_state.get("retrieved_memories") or [],
        "memories_stored": final_state.get("memories_stored") or [],
        "memory_backend": memory_backend_name(),
    }


def is_orchestrator_enabled() -> bool:
    return os.getenv("ORCHESTRATOR_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
