"""
Full Suite Verification for Interactive Live Session Chat & Trace Pipeline
"""
import sys
import os
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from main import app
from app.agent.reasoner import reason
from app.schemas.action import SanitizedContext, UIElement, BrowserAction

client = TestClient(app)

def test_trace_events_endpoints():
    print("\n--- Testing Trace Events Endpoints ---")
    session_id = f"test-trace-{os.getpid()}"
    event = {
        "id": "trace-001",
        "sessionId": session_id,
        "type": "PROMPT_RECEIVED",
        "detail": 'User: "Find the Merge PDF button"',
        "step": 1,
        "timestamp": 123456789,
        "metadata": {"user": "tester"}
    }
    
    # POST event
    res_post = client.post(f"/api/sessions/{session_id}/trace-events", json=event)
    assert res_post.status_code == 200, f"Failed to post trace event: {res_post.text}"
    assert res_post.json().get("ok") is True
    print("  ✓ POST /api/sessions/{id}/trace-events succeeded")

    # GET events for session
    res_get = client.get(f"/api/sessions/{session_id}/trace-events")
    assert res_get.status_code == 200
    events = res_get.json()
    assert len(events) >= 1
    assert events[0]["type"] == "PROMPT_RECEIVED"
    print(f"  ✓ GET /api/sessions/{session_id}/trace-events returned {len(events)} events")

    # GET latest events
    res_latest = client.get("/api/sessions/latest/trace-events")
    assert res_latest.status_code == 200
    print(f"  ✓ GET /api/sessions/latest/trace-events succeeded")


async def test_interactive_multi_turn_flow():
    print("\n--- Testing Interactive Multi-Turn Reasoning Flow ---")
    
    # Turn 1: User asks "Find the Merge PDF button"
    ctx1 = SanitizedContext(
        pageUrl="https://www.ilovepdf.com/user",
        pageTitle="My Account — iLovePDF",
        pageType="utility_tool",
        timestamp=1000,
        elements=[
            UIElement(id="el_001", tagName="a", label="Merge PDF", role="PDF tool link: Merge PDF", interactable=True, visible=True, domSelector="#btn-merge"),
            UIElement(id="el_002", tagName="a", label="Split PDF", role="PDF tool link: Split PDF", interactable=True, visible=True, domSelector="#btn-split"),
            UIElement(id="el_003", tagName="button", label="Select files", role="Upload button", interactable=True, visible=True, domSelector="#btn-upload"),
        ],
        sanitizedText="iLovePDF Tools: Merge PDF, Split PDF, Compress PDF",
        ocrTexts=["Merge PDF", "Split PDF"],
        piiSummary={"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        screenshotIncluded=False,
    )
    
    act1, *_ = await reason(
        task="Find the Merge PDF button",
        context=ctx1,
        step_number=1,
        session_id="test-session-multi",
        previous_actions=[],
        conversation_history=[{"role": "user", "text": "Find the Merge PDF button"}]
    )
    
    print(f"Turn 1 Response:")
    print(f"  action: {act1.action}")
    print(f"  target: {act1.target}")
    print(f"  reason: {act1.reason}")
    print(f"  requiresApproval: {act1.requiresApproval}")
    
    assert act1.requiresApproval is True, "Turn 1 ('Find...') should require user approval before clicking"
    assert "merge pdf" in (act1.reason or "").lower()
    target_id1 = act1.target.get_element_id() if act1.target else ""
    assert target_id1 == "el_001", f"Expected el_001, got {target_id1}"
    print("  ✓ Turn 1: Successfully found Merge PDF button and requested confirmation")

    # Turn 2: User responds "Click it" with conversation history
    history_turn2 = [
        {"role": "user", "text": "Find the Merge PDF button"},
        {"role": "assistant", "text": act1.reason or "I found the Merge PDF button. Would you like me to click it?"},
        {"role": "user", "text": "Click it"}
    ]
    
    act2, *_ = await reason(
        task="Click it",
        context=ctx1,
        step_number=2,
        session_id="test-session-multi",
        previous_actions=[act1],
        conversation_history=history_turn2
    )
    
    print(f"\nTurn 2 Response ('Click it'):")
    print(f"  action: {act2.action}")
    print(f"  target: {act2.target}")
    print(f"  reason: {act2.reason}")
    print(f"  requiresApproval: {act2.requiresApproval}")
    
    assert act2.action == "click"
    target_id2 = act2.target.get_element_id() if act2.target else ""
    assert target_id2 == "el_001", f"Expected 'Click it' to resolve to el_001 from history, got {target_id2}"
    print("  ✓ Turn 2: Resolved 'Click it' pronoun to el_001 and executed click")

    # Turn 3: Page transitions to tool page, user says "Now open the file explorer"
    ctx3 = SanitizedContext(
        pageUrl="https://www.ilovepdf.com/merge_pdf",
        pageTitle="Merge PDF files online",
        pageType="utility_tool",
        timestamp=2000,
        elements=[
            UIElement(id="el_001", tagName="a", label="iLovePDF home", role="link", interactable=True, visible=True, domSelector="#logo"),
            UIElement(id="el_002", tagName="a", label="Select PDF files", role="File upload button: Select PDF files from computer", interactable=True, visible=True, domSelector="#uploader"),
        ],
        sanitizedText="Merge PDF files online. Select PDF files to combine.",
        ocrTexts=["Select PDF files"],
        piiSummary={"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        screenshotIncluded=False,
    )
    
    history_turn3 = history_turn2 + [
        {"role": "assistant", "text": "Done. Clicked Merge PDF button."},
        {"role": "user", "text": "Now open the file explorer"}
    ]
    
    act3, *_ = await reason(
        task="Now open the file explorer",
        context=ctx3,
        step_number=3,
        session_id="test-session-multi",
        previous_actions=[act1, act2],
        conversation_history=history_turn3
    )
    
    print(f"\nTurn 3 Response ('Now open the file explorer'):")
    print(f"  action: {act3.action}")
    print(f"  target: {act3.target}")
    print(f"  reason: {act3.reason}")
    
    assert act3.action == "click"
    target_id3 = act3.target.get_element_id() if act3.target else ""
    assert target_id3 == "el_002", f"Expected el_002 for file upload button, got {target_id3}"
    print("  ✓ Turn 3: Continuous session seamlessly opened file explorer on new page")


async def test_compound_instruction():
    print("\n--- Testing Compound Instruction: 'Click Merge PDF and then open file explorer' ---")
    
    # Step A: on portal page
    ctx_portal = SanitizedContext(
        pageUrl="https://www.ilovepdf.com/user",
        pageTitle="User Profile",
        pageType="utility_tool",
        timestamp=1000,
        elements=[
            UIElement(id="el_001", tagName="a", label="Merge PDF", role="PDF tool link: Merge PDF", interactable=True, visible=True, domSelector="#merge"),
        ],
        sanitizedText="User Profile Merge PDF",
        ocrTexts=["Merge PDF"],
        piiSummary={"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        screenshotIncluded=False,
    )
    
    res_a, *_ = await reason(
        task="Click Merge PDF and then open file explorer",
        context=ctx_portal,
        step_number=1,
        session_id="test-compound",
        previous_actions=[],
        conversation_history=[]
    )
    print(f"  Step A on portal: action={res_a.action} target={res_a.target}")
    assert res_a.action == "click"
    assert res_a.target.get_element_id() == "el_001"

    # Step B: on merge_pdf page
    ctx_tool = SanitizedContext(
        pageUrl="https://www.ilovepdf.com/merge_pdf",
        pageTitle="Merge PDF files online",
        pageType="utility_tool",
        timestamp=2000,
        elements=[
            UIElement(id="el_002", tagName="a", label="Select PDF files", role="File upload button: Select files", interactable=True, visible=True, domSelector="#uploader"),
        ],
        sanitizedText="Merge PDF files online Select PDF files",
        ocrTexts=["Select PDF files"],
        piiSummary={"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        screenshotIncluded=False,
    )
    
    res_b, *_ = await reason(
        task="Click Merge PDF and then open file explorer",
        context=ctx_tool,
        step_number=2,
        session_id="test-compound",
        previous_actions=[res_a],
        conversation_history=[]
    )
    print(f"  Step B on tool page: action={res_b.action} target={res_b.target}")
    assert res_b.action == "click"
    assert res_b.target.get_element_id() == "el_002"
    print("  ✓ Compound multi-step task completed across portal & tool pages")


async def test_element_not_found():
    print("\n--- Testing Element Not Found Graceful Fallback ---")
    ctx = SanitizedContext(
        pageUrl="https://www.ilovepdf.com/user",
        pageTitle="User Profile",
        pageType="utility_tool",
        timestamp=1000,
        elements=[
            UIElement(id="el_001", tagName="a", label="Merge PDF", role="link", interactable=True, visible=True, domSelector="#merge"),
        ],
        sanitizedText="iLovePDF home",
        ocrTexts=[],
        piiSummary={"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        screenshotIncluded=False,
    )
    
    res, *_ = await reason(
        task="Find the interstellar spaceship launcher button",
        context=ctx,
        step_number=2,
        session_id="test-not-found",
        previous_actions=[BrowserAction(action="scroll", reason="scrolled down")],
        conversation_history=[]
    )
    print(f"  Response: action={res.action} reason='{res.reason}' confidence={res.confidence}")
    assert res.action in ["done", "finish"]
    assert "couldn't confidently find" in (res.reason or "").lower() or "not find" in (res.reason or "").lower() or "completed" in (res.reason or "").lower()
    print("  ✓ Gracefully handled unfound element")


async def main():
    test_trace_events_endpoints()
    await test_interactive_multi_turn_flow()
    await test_compound_instruction()
    await test_element_not_found()
    print("\n==========================================")
    print("🎉 ALL TESTS PASSED SUCCESSFULLY!")
    print("==========================================")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
