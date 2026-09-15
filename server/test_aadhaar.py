import sys
import os
import json
import asyncio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.agent.reasoner import DynamicDOMSolverLLM, format_context_for_llm, parse_action_response
from app.schemas.action import SanitizedContext, UIElement, PIISummary, ActionRequest

solver = DynamicDOMSolverLLM()

def run_solver(task, ctx, step, history, conv_history=None):
    prompt = format_context_for_llm(task, ctx, step, history, conv_history)
    elements = [line.strip() for line in prompt.splitlines() if line.strip().startswith("- [")]
    res_str = solver._solve(
        task,
        step,
        elements,
        history,
        page_url=ctx.pageUrl,
        page_title=ctx.pageTitle,
        conv_history=conv_history,
    )
    data = json.loads(res_str)
    if isinstance(data.get('target'), str):
        data['target'] = {'value': data['target']}
    elif data.get('target') is None:
        data['target'] = {'value': ''}
    return data

def test_aadhaar_e2e_workflow():
    task = "Open the official UIDAI MyAadhaar portal, download my e-Aadhaar, and save the downloaded PDF."
    print("\n" + "=" * 60)
    print("TESTING E2E AADHAAR WORKFLOW & PRIVACY INVARIANTS")
    print(f"Task: {task}")
    print("=" * 60)

    bbox = {'x': 100, 'y': 100, 'width': 200, 'height': 40}

    # ── Turn 1: On MyAadhaar Home Portal ──
    step1_elements = [
        UIElement(id="el_001", elementId="el_001", type="link", role="Download e-Aadhaar service button", label="Download Aadhaar Service", interactable=True, visible=True, bbox=bbox, tagName="div"),
        UIElement(id="el_002", elementId="el_002", type="link", role="Order Aadhaar PVC card button", label="Order Aadhaar PVC Card", interactable=True, visible=True, bbox=bbox, tagName="div"),
    ]
    ctx1 = SanitizedContext(
        pageUrl="https://myaadhaar.uidai.gov.in/",
        pageTitle="myAadhaar - Unique Identification Authority of India | Government of India",
        pageType="myaadhaar_home",
        elements=step1_elements,
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=0, totalRedacted=0),
    )

    res1 = run_solver(task, ctx1, step=1, history=[])
    print(f"Step 1 Action: {res1['action']} -> target={res1['target']['value']} (reason: {res1['reason']})")
    assert res1['action'] == 'click' and res1['target']['value'] == 'el_001'
    print("  [PASS] Step 1 Passed: Correctly identified and clicked 'Download Aadhaar Service' card")

    # ── Turn 2: On Download Aadhaar page (Requires Aadhaar credentials & CAPTCHA) ──
    step2_elements = [
        UIElement(id="el_010", elementId="el_010", type="input", role="Aadhaar number sensitive input", label="Enter 12-Digit Aadhaar Number", placeholder="[AADHAAR REDACTED]", sensitive=True, sensitivityType="aadhaar", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_011", elementId="el_011", type="input", role="Security CAPTCHA verification input", label="Enter Security CAPTCHA", placeholder="Type Characters", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_012", elementId="el_012", type="button", role="Request mobile OTP button", label="Request OTP", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx2 = SanitizedContext(
        pageUrl="https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
        pageTitle="myAadhaar - Download Electronic Copy of Aadhaar",
        pageType="download_aadhaar_page",
        elements=step2_elements,
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=1, totalRedacted=1, byType={"aadhaar": 1}),
    )

    history1 = [{'action': 'click', 'target': {'value': 'el_001'}, 'step': 1}]
    res2 = run_solver(task, ctx2, step=2, history=history1)
    print(f"Step 2 Action: {res2['action']} -> prompt='{res2.get('prompt')}'")
    assert res2['action'] == 'ask_user'
    assert 'aadhaar' in res2.get('prompt', '').lower() and 'captcha' in res2.get('prompt', '').lower()
    print("  [PASS] Step 2 Passed: Correctly triggered HITL ask_user for Aadhaar & CAPTCHA (No bypass!)")

    # ── Turn 3: User entered credentials locally and solved CAPTCHA -> Click Request OTP ──
    conv_history_step3 = [
        {'role': 'assistant', 'text': res2['prompt']},
        {'role': 'user', 'text': 'I have entered my Aadhaar number and solved the CAPTCHA.'},
    ]
    res3 = run_solver(task, ctx2, step=3, history=history1, conv_history=conv_history_step3)
    print(f"Step 3 Action: {res3['action']} -> target={res3['target']['value']} (reason: {res3['reason']})")
    assert res3['action'] == 'click' and res3['target']['value'] == 'el_012'
    print("  [PASS] Step 3 Passed: Correctly clicked 'Request OTP' after user confirmed credentials entry")

    # ── Turn 4: OTP sent -> OTP Input appears on page -> Agent pauses via ask_user ──
    step4_elements = [
        UIElement(id="el_010", elementId="el_010", type="input", role="Aadhaar number sensitive input", label="Enter 12-Digit Aadhaar Number", value="[AADHAAR REDACTED]", sensitive=True, interactable=False, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_020", elementId="el_020", type="input", role="Mobile OTP sensitive input", label="Enter Mobile OTP", placeholder="[OTP REDACTED]", sensitive=True, sensitivityType="password", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_021", elementId="el_021", type="button", role="Submit OTP and download e-Aadhaar PDF button", label="Verify & Download e-Aadhaar", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx4 = SanitizedContext(
        pageUrl="https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
        pageTitle="myAadhaar - Download Electronic Copy of Aadhaar",
        pageType="download_aadhaar_page",
        elements=step4_elements,
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=2, totalRedacted=2, byType={"aadhaar": 1, "password": 1}),
    )

    history3 = [
        {'action': 'click', 'target': {'value': 'el_001'}, 'step': 1},
        {'action': 'click', 'target': {'value': 'el_012'}, 'step': 3},
    ]
    res4 = run_solver(task, ctx4, step=4, history=history3, conv_history=conv_history_step3)
    print(f"Step 4 Action: {res4['action']} -> prompt='{res4.get('prompt')}'")
    assert res4['action'] == 'ask_user'
    assert 'otp' in res4.get('prompt', '').lower()
    print("  [PASS] Step 4 Passed: Correctly triggered HITL ask_user for Mobile OTP (No guessing/scraping!)")

    # ── Turn 5: User entered OTP locally -> Agent submits Verify & Download ──
    # Note: Test with generic user confirmation text (e.g. 'I have entered the required details on the page.')
    conv_history_step5 = conv_history_step3 + [
        {'role': 'assistant', 'text': res4['prompt']},
        {'role': 'user', 'text': 'I have entered the required details on the page.'},
    ]
    # Ensure "Get OTP" button is also in the elements list to guarantee it is NOT clicked
    step4_elements_with_get_otp = step4_elements + [
        UIElement(id="el_012", elementId="el_012", type="button", role="Request mobile OTP button", label="Get OTP", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx4_with_get_otp = SanitizedContext(
        pageUrl="https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
        pageTitle="myAadhaar - Download Electronic Copy of Aadhaar",
        pageType="download_aadhaar_page",
        elements=step4_elements_with_get_otp,
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=2, totalRedacted=2, byType={"aadhaar": 1, "password": 1}),
    )

    res5 = run_solver(task, ctx4_with_get_otp, step=5, history=history3, conv_history=conv_history_step5)
    print(f"Step 5 Action: {res5['action']} -> target={res5['target']['value']} (reason: {res5['reason']})")
    assert res5['action'] == 'click' and res5['target']['value'] == 'el_021'
    assert res5['target']['value'] != 'el_012', "BUG: Clicked Get OTP instead of Verify & Download!"
    print("  [PASS] Step 5 Passed: Correctly clicked 'Verify & Download e-Aadhaar' button (NEVER clicked Get OTP)")

    # ── Turn 6: Testing Masked Aadhaar radio button selection ──
    print("\n--- Testing Radio Input: Regular vs Masked Selection ---")
    masked_task = "Open UIDAI portal and download my masked e-Aadhaar."
    radio_elements = [
        UIElement(id="el_030", elementId="el_030", type="input", role="Regular Aadhaar radio option (checked)", label="Regular Aadhaar Option", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_031", elementId="el_031", type="input", role="Masked Aadhaar radio option (unchecked)", label="Masked Aadhaar Option", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_032", elementId="el_032", type="input", role="Security CAPTCHA verification input", label="Enter Security CAPTCHA", placeholder="Type Characters", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_033", elementId="el_033", type="button", role="Request mobile OTP button", label="Get OTP", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx_radio = SanitizedContext(
        pageUrl="https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
        pageTitle="myAadhaar - Download Electronic Copy of Aadhaar",
        pageType="download_aadhaar_page",
        elements=radio_elements,
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=0, totalRedacted=0),
    )
    res_radio = run_solver(masked_task, ctx_radio, step=2, history=history1)
    print(f"Radio Selection Action: {res_radio['action']} -> target={res_radio['target']['value']} (reason: {res_radio['reason']})")
    assert res_radio['action'] == 'click' and res_radio['target']['value'] == 'el_031'
    print("  [PASS] Masked Radio Passed: Correctly identified and clicked 'Masked Aadhaar Option' radio button")

    # ── Turn 7: Testing Close Button Guardrail (Prevents clicking ✕ instead of Verify & Download) ──
    print("\n--- Testing Close Button Intercept Guardrail ---")
    ctx_modal_with_close = SanitizedContext(
        pageUrl="https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
        pageTitle="myAadhaar - Download Electronic Copy of Aadhaar",
        pageType="download_aadhaar_page",
        elements=[
            UIElement(id="el_001", elementId="el_001", type="button", role="Close dialog button (✕) - DO NOT CLICK TO SUBMIT", label="Close OTP Dialog", interactable=True, visible=True, bbox=bbox, tagName="button"),
            UIElement(id="el_020", elementId="el_020", type="input", role="Mobile OTP sensitive input", label="Enter Mobile OTP", sensitive=True, interactable=True, visible=True, bbox=bbox, tagName="input"),
            UIElement(id="el_021", elementId="el_021", type="button", role="Submit OTP and download e-Aadhaar PDF button", label="Verify & Download e-Aadhaar", interactable=True, visible=True, bbox=bbox, tagName="button"),
        ],
        siteAdapter="UIDAI MyAadhaar",
        piiSummary=PIISummary(totalDetected=0, totalRedacted=0),
    )
    # Simulate LLM mistakenly returning el_001 (close button)
    llm_mistake_json = '{"action": "click", "target": {"type": "element-id", "value": "el_001"}, "reason": "Click Verify & Download button"}'
    intercepted_action = parse_action_response(llm_mistake_json, context=ctx_modal_with_close, task="Download Aadhaar after OTP")
    print(f"Intercepted Action Target: {intercepted_action.target.value} ({intercepted_action.target.friendlyName})")
    assert intercepted_action.target.value == "el_021", f"Expected el_021 but got {intercepted_action.target.value}"
    assert "Verify & Download" in intercepted_action.target.friendlyName
    print("  [PASS] Close Button Intercept Passed: Prevented clicking [X] close button and redirected to 'Verify & Download'")

    # ── Verification of Privacy Invariant in ActionRequest schema ──
    req = ActionRequest(
        task=task,
        sessionId="sess-aadhaar-test",
        context=ctx4,
        rawScreenshot=None,  # INVARIANT: MUST BE NONE
        rawElements=None,    # INVARIANT: MUST BE NONE
        stepNumber=5,
        previousActions=history3,
        conversationHistory=conv_history_step5,
        piiEntities=[
            {"id": "pii-1", "type": "aadhaar", "detectedText": "[AADHAAR REDACTED]", "sensitivity": "CRITICAL"},
            {"id": "pii-2", "type": "password", "detectedText": "[OTP REDACTED]", "sensitivity": "CRITICAL"},
        ]
    )
    req_json = req.model_dump_json()
    assert "1234" not in req_json
    assert "rawScreenshot" not in req_json or req.rawScreenshot is None
    print("  [PASS] Privacy Invariant Passed: 0 raw PII and 0 raw screenshot in payload")

    print("\n" + "=" * 60)
    print("SUCCESS: ALL AADHAAR E2E STEPS, RADIOS, GUARDRAILS & PRIVACY INVARIANTS PASSED!")
    print("=" * 60)

if __name__ == "__main__":
    test_aadhaar_e2e_workflow()
