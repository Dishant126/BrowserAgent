import urllib.request
import json

# Step 1 test: on https://www.ilovepdf.com/user
req1 = {
    "task": "merge 2 pdfs",
    "stepNumber": 1,
    "sessionId": "test-verify-1",
    "previousActions": [],
    "context": {
        "pageUrl": "https://www.ilovepdf.com/user",
        "pageTitle": "My account Profile",
        "pageType": "general",
        "timestamp": 12345678,
        "sanitizedText": "My account Profile Dishant Bajaj",
        "elements": [
            {"elementId": "el_001", "tagName": "a", "label": "ilovepdf", "role": "link", "interactable": True, "visible": True},
            {"elementId": "el_002", "tagName": "a", "label": "Merge PDF", "role": "PDF tool link: Merge PDF", "interactable": True, "visible": True},
            {"elementId": "el_003", "tagName": "a", "label": "Split PDF", "role": "PDF tool link: Split PDF", "interactable": True, "visible": True}
        ],
        "piiSummary": {"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        "perceptionLevel": 1
    }
}

req_data = json.dumps(req1).encode("utf-8")
r = urllib.request.Request("http://localhost:8000/api/action", data=req_data, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(r) as resp:
    res1 = json.loads(resp.read())

act1 = res1.get("action") or {}
print("STEP 1 RESPONSE:")
print(f"  action: {act1.get('action')}")
print(f"  target: {act1.get('target')}")
print(f"  reason: {act1.get('reason')}")
print(f"  requiresApproval: {act1.get('requiresApproval')}")

# Step 2 test: on https://www.ilovepdf.com/merge_pdf
req2 = {
    "task": "merge 2 pdfs",
    "stepNumber": 2,
    "sessionId": "test-verify-1",
    "previousActions": [{
        "action": act1.get("action"),
        "target": act1.get("target"),
        "reason": act1.get("reason"),
        "step": 1
    }],
    "context": {
        "pageUrl": "https://www.ilovepdf.com/merge_pdf",
        "pageTitle": "Merge PDF files online",
        "pageType": "general",
        "timestamp": 12345679,
        "sanitizedText": "Merge PDF files Combine PDFs Select PDF files",
        "elements": [
            {"elementId": "el_001", "tagName": "a", "label": "ilovepdf", "role": "link", "interactable": True, "visible": True},
            {"elementId": "el_002", "tagName": "a", "label": "Select/Upload PDF", "role": "File upload button", "ariaLabel": "Select PDF files", "interactable": True, "visible": True},
            {"elementId": "el_003", "tagName": "a", "label": "Merge PDF", "role": "PDF tool link: Merge PDF", "interactable": True, "visible": True}
        ],
        "piiSummary": {"totalDetected": 0, "totalRedacted": 0, "byType": {}},
        "perceptionLevel": 1
    }
}

req_data2 = json.dumps(req2).encode("utf-8")
r2 = urllib.request.Request("http://localhost:8000/api/action", data=req_data2, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(r2) as resp2:
    res2 = json.loads(resp2.read())

act2 = res2.get("action") or {}
print("\nSTEP 2 RESPONSE:")
print(f"  action: {act2.get('action')}")
print(f"  target: {act2.get('target')}")
print(f"  reason: {act2.get('reason')}")
print(f"  requiresApproval: {act2.get('requiresApproval')}")
