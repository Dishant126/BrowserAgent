import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.agent.reasoner import DynamicDOMSolverLLM, format_context_for_llm
from app.schemas.action import SanitizedContext, UIElement, PIISummary

solver = DynamicDOMSolverLLM()

def run_solver(task, ctx, step, history):
    prompt = format_context_for_llm(task, ctx, step, history)
    elements = [line.strip() for line in prompt.splitlines() if line.strip().startswith("- [")]
    res_str = solver._solve(task, step, elements, history, page_url=ctx.pageUrl, page_title=ctx.pageTitle)
    data = json.loads(res_str)
    if isinstance(data.get('target'), str):
        data['target'] = {'value': data['target']}
    elif data.get('target') is None:
        data['target'] = {'value': ''}
    return data

def test_irctc_workflow():
    task = "book train from new delhi station to firozabad station on 8/9/2026"
    print(f"\n=== Testing IRCTC Autonomous Workflow ===")
    print(f"Prompt: '{task}'")

    # Step 1: Blank form on IRCTC
    bbox = {'x': 10, 'y': 10, 'width': 100, 'height': 30}
    step1_elements = [
        UIElement(id="el_001", elementId="el_001", type="input", role="Origin station search input", label="From Station", placeholder="From", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_002", elementId="el_002", type="input", role="Destination station search input", label="To Station", placeholder="To", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_003", elementId="el_003", type="input", role="Journey date picker", label="Journey Date", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_004", elementId="el_004", type="button", role="Search trains button", label="Search Trains", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]

    ctx1 = SanitizedContext(
        pageUrl="https://www.irctc.co.in/nget/train-search",
        pageTitle="IRCTC Next Generation eTicketing System",
        pageType="booking",
        elements=step1_elements,
        siteAdapter="IRCTC"
    )

    res1 = run_solver(task, ctx1, step=1, history=[])
    print(f"Step 1 Action: {res1['action']} -> {res1.get('value')} on {res1['target']['value']} (reason: {res1['reason']})")
    assert res1['action'] == 'fill' and 'delhi' in res1['value'].lower()
    print("  [PASS] Correctly filled origin with New Delhi")

    # Step 2: Autocomplete suggestions appear
    step2_elements = [
        UIElement(id="el_001", elementId="el_001", type="input", role="Origin station search input", label="From Station", value="New Delhi", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_010", elementId="el_010", type="li", role="Station autocomplete dropdown suggestion item", label="Station Option: NEW DELHI - NDLS", interactable=True, visible=True, bbox=bbox, tagName="li"),
        UIElement(id="el_011", elementId="el_011", type="li", role="Station autocomplete dropdown suggestion item", label="Station Option: DELHI S ROHILLA - DEE", interactable=True, visible=True, bbox=bbox, tagName="li"),
        UIElement(id="el_002", elementId="el_002", type="input", role="Destination station search input", label="To Station", placeholder="To", interactable=True, visible=True, bbox=bbox, tagName="input"),
    ]
    ctx2 = SanitizedContext(
        pageUrl="https://www.irctc.co.in/nget/train-search",
        pageTitle="IRCTC Next Generation eTicketing System",
        pageType="booking",
        elements=step2_elements,
        siteAdapter="IRCTC"
    )
    res2 = run_solver(task, ctx2, step=2, history=[res1])
    print(f"Step 2 Action: {res2['action']} on {res2['target']['value']} (reason: {res2['reason']})")
    assert res2['action'] == 'click' and res2['target']['value'] == 'el_010'
    print("  [PASS] Correctly selected New Delhi NDLS autocomplete suggestion")

    # Step 3: Train Results page with "Book Now"
    step3_elements = [
        UIElement(id="el_020", elementId="el_020", type="div", role="Travel class selector tab for Sleeper (SL)", label="Select Class: Sleeper (SL)", interactable=True, visible=True, bbox=bbox, tagName="div"),
        UIElement(id="el_021", elementId="el_021", type="button", role="Train Book Now button", label="Book Now", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx3 = SanitizedContext(
        pageUrl="https://www.irctc.co.in/nget/booking/train-list",
        pageTitle="Train Availability",
        pageType="booking",
        elements=step3_elements,
        siteAdapter="IRCTC"
    )
    res3 = run_solver(task, ctx3, step=3, history=[res1, res2])
    print(f"Step 3 Action: {res3['action']} on {res3['target']['value']} (reason: {res3['reason']})")
    assert res3['action'] == 'click' and res3['target']['value'] == 'el_021'
    print("  [PASS] Clicked Book Now on train list")

    # Step 4: Login Dialog opens -> HITL ask_user
    step4_elements = [
        UIElement(id="el_030", elementId="el_030", type="input", role="IRCTC login username input", label="IRCTC User ID", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_031", elementId="el_031", type="password", role="IRCTC login password input", label="IRCTC Password", sensitive=True, sensitivityType="password", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_032", elementId="el_032", type="input", role="IRCTC login captcha input", label="IRCTC Captcha", interactable=True, visible=True, bbox=bbox, tagName="input"),
        UIElement(id="el_033", elementId="el_033", type="button", role="IRCTC login submit button", label="Sign In", interactable=True, visible=True, bbox=bbox, tagName="button"),
    ]
    ctx4 = SanitizedContext(
        pageUrl="https://www.irctc.co.in/nget/booking/train-list",
        pageTitle="Train Availability - Login",
        pageType="booking",
        elements=step4_elements,
        siteAdapter="IRCTC"
    )
    res4 = run_solver(task, ctx4, step=4, history=[res1, res2, res3])
    print(f"Step 4 Action: {res4['action']} (prompt: {res4.get('prompt')})")
    assert res4['action'] == 'ask_user' and 'credentials' in res4['prompt'].lower()
    print("  [PASS] Correctly engaged Human-In-The-Loop with local masking for login credentials!")

    print("\nALL IRCTC WORKFLOW TESTS PASSED 100%!")

if __name__ == "__main__":
    test_irctc_workflow()
