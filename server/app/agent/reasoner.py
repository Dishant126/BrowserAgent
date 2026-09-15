"""
Agent Reasoner — LangChain-based LLM integration.

Supported providers (set LLM_PROVIDER env var):
  gemini   — Google Gemini Flash (default)
  groq     — Groq inference (fast, high quota — recommended for hackathon)
  openai   — OpenAI GPT models
  anthropic — Anthropic Claude models
  mock     — Rule-based fallback (no API key required)
"""
from __future__ import annotations
import os
import time
import json
import re
from typing import Optional, Any, cast

from dotenv import load_dotenv
load_dotenv()

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.language_models import BaseChatModel

from app.schemas.action import SanitizedContext, BrowserAction, ActionTarget

# ── MODEL FACTORY ─────────────────────────────────────────────────────────────

def get_llm() -> Any:
    """Return the configured LLM. Change LLM_PROVIDER env var to switch."""
    provider = os.getenv("LLM_PROVIDER", "gemini").lower()

    if provider == "groq":
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        if not groq_key or groq_key in ("your_groq_api_key_here", ""):
            print("[Reasoner] No GROQ_API_KEY. Using DynamicDOMSolver fallback.")
            return DynamicDOMSolverLLM()
        model_name = os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b")
        try:
            from langchain_groq import ChatGroq
        except ImportError:
            print("[Reasoner] langchain-groq not installed. Run: pip install langchain-groq")
            return DynamicDOMSolverLLM()
        print(f"[Reasoner] Using Groq model: {model_name}")
        return ChatGroq(
            model=model_name,
            api_key=groq_key,
            temperature=0.1,
        )

    elif provider == "gemini":
        api_key = os.getenv("GOOGLE_API_KEY", "").strip()
        if not api_key or api_key in ("your_gemini_api_key_here", ""):
            print("[Reasoner] No GOOGLE_API_KEY. Using DynamicDOMSolver fallback.")
            return DynamicDOMSolverLLM()
        model_name = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
        from langchain_google_genai import ChatGoogleGenerativeAI
        print(f"[Reasoner] Using Gemini model: {model_name}")
        return ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=api_key,
        )

    elif provider == "openai":
        try:
            from langchain_openai import ChatOpenAI
            return ChatOpenAI(
                model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                api_key=os.getenv("OPENAI_API_KEY"),
                temperature=0.1,
            )
        except ImportError:
            print("[Reasoner] langchain-openai not installed. Run: pip install langchain-openai")
            return DynamicDOMSolverLLM()

    elif provider == "anthropic":
        try:
            from langchain_anthropic import ChatAnthropic
            return ChatAnthropic(
                model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-20240307"),
                api_key=os.getenv("ANTHROPIC_API_KEY"),
                temperature=0.1,
            )
        except ImportError:
            print("[Reasoner] langchain-anthropic not installed. Run: pip install langchain-anthropic")
            return DynamicDOMSolverLLM()

    print(f"[Reasoner] Unknown provider '{provider}'. Using DynamicDOMSolver fallback.")
    return DynamicDOMSolverLLM()


# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are PrivSight — a privacy-preserving browser automation agent with visual perception.
You receive a SANITIZED web page context (all raw PII like faces, passwords, credit cards, and sensitive identifiers have been redacted or blurred locally on the client before reaching you).
When a sanitized screenshot is attached, use it to understand the visual layout, modal overlays, dropdown menus, and screen structure. Redacted regions appear as blurred blocks with labels like [FACE BLURRED], [CARD REDACTED], [PASSWORD REMOVED].

You must determine the SINGLE next best action to complete the user's task.

CRITICAL RULES:
1. Return ONLY valid JSON — no prose, no markdown fences, no <think> blocks.
2. Allowed action types: click, fill, scroll, select, navigate, wait, back, forward, finish, ask_user, done
3. Elements are identified by stable IDs like el_001, el_002, etc. — ALWAYS use these IDs in targets.
4. Do NOT generate CSS selectors, JavaScript, or raw DOM paths. Use element IDs only.
5. Do ONE action per step — never chain multiple actions in one response.
6. Do NOT repeat an action already in ACTIONS ALREADY EXECUTED unless the page state changed. If you already scrolled and the requested item/button still does not exist on this website, call 'ask_user' or 'done' explaining that the element is not found.
7. SENSITIVE DATA: If the task requires a password, OTP, payment info, or government ID, use ask_user.
8. COMPLETION: You are an autonomous agent. Continue executing actions step-by-step until the ENTIRE user goal is achieved. Only return 'done' or 'finish' when the final objective is visibly accomplished on the page (e.g. form submitted, requested button clicked, article read, item starred or added to cart). Never stop after an intermediate navigation or click.
9. CONFIDENCE: Be honest about confidence. Low = 0.70, Medium = 0.85, High = 0.95+
10. NAVIGATION: After a search or page transition, wait or observe the updated page state on the NEXT step before acting on new elements.

GENERAL-PURPOSE AGENT STRATEGIES (Works on ANY website):
- MULTI-STEP EXPLORATION:
  * If the user's goal requires navigating through multiple screens (e.g. going to a tab/profile, finding a specific item in a list, opening it, and interacting with it), break it down logically.
  * Step 1: Open the relevant section, tab, or search bar.
  * Step 2: Locate the specific target item from the loaded results.
  * Step 3: Perform the requested action on that item (click, star, submit, fill, download, etc.).
- POPUPS & OVERLAYS:
  * If a cookie banner, login modal, or promotional overlay blocks the view, click its close ('✕', 'Dismiss', 'Close', 'No thanks') button first.
- SEARCH & AUTOCOMPLETE:
  * When filling a search input that offers dynamic suggestions, prefer clicking the matching suggestion item from the dropdown.
- SCROLLING & UNFOUND ELEMENTS:
  * If a requested item or button is not visible in the current viewport elements and you have not scrolled yet, emit a 'scroll' action downwards to bring it into view.
  * If you have already scrolled and the requested item clearly does not exist on the page, return 'ask_user' or 'done' explaining that the element was not found.
- UIDAI / MYAADHAAR WORKFLOW:
  * On the MyAadhaar home page: locate and click 'Download Aadhaar' / 'Download Aadhaar Service'.
  * On the Download Aadhaar page: entering an Aadhaar number and solving the visual CAPTCHA is required. NEVER guess or bypass CAPTCHA. Emit 'ask_user' with prompt: "Please enter your 12-digit Aadhaar number and solve the CAPTCHA security code on the page, then click Request OTP."
  * When the OTP input field appears: emit 'ask_user' with prompt: "An OTP has been sent to your UIDAI-registered mobile. Please enter the OTP to continue."
  * Once the user confirms OTP entry: click 'Verify & Download e-Aadhaar'. The downloaded e-Aadhaar PDF is preserved safely on the local device.

ELEMENT ID FORMAT:
Each interactive element has a stable ID like el_001. The target field must use:
  {"type": "element-id", "value": "el_042"}

FALLBACK (only if no element ID matches): use descriptive text:
  {"type": "text", "value": "Search button"}

JSON FORMAT (return exactly this structure):
{
  "action": "click|fill|select|scroll|navigate|wait|back|forward|ask_user|done|finish",
  "target": {"type": "element-id", "value": "el_NNN"},
  "value": "<string value for fill/select, omit otherwise>",
  "reason": "<one clear sentence explaining why>",
  "confidence": 0.95,
  "prompt": "<only for ask_user: question to show the user>"
}
"""

# ── CONTEXT FORMATTER ─────────────────────────────────────────────────────────

def format_context_for_llm(
    task: str,
    context: SanitizedContext,
    step: int,
    previous_actions: list[dict] | None = None,
    conversation_history: list[dict] | None = None,
) -> str:
    interactable = [e for e in context.elements if e.interactable and e.visible]
    elem_lines = []
    for el in interactable[:50]:
        # Use stable element ID (el_NNN) if available, fall back to domSelector
        el_id = getattr(el, 'elementId', None) or el.id or el.domSelector
        parts = [f"[{el_id}]"]
        parts.append(f'tag={el.tagName or el.type}')
        lbl = getattr(el, 'label', None) or ""
        lbl = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', '[EMAIL REDACTED]', str(lbl))
        if lbl:
            parts.append(f'label="{lbl}"')
        ph = getattr(el, 'placeholder', None) or ""
        ph = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', '[EMAIL REDACTED]', str(ph))
        if ph:
            parts.append(f'placeholder="{ph}"')
        if el.role:
            parts.append(f'role="{el.role[:80]}"')
        aria = getattr(el, 'ariaLabel', None) or ""
        aria = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', '[EMAIL REDACTED]', str(aria))
        if aria:
            parts.append(f'aria="{aria}"')
        if el.value and not el.sensitive:
            val_clean = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', '[EMAIL REDACTED]', el.value)
            parts.append(f'value="{val_clean}"')
        if el.sensitive or '[EMAIL REDACTED]' in lbl or '[EMAIL REDACTED]' in ph:
            parts.append(f'[REDACTED:{el.sensitivityType or "pii"}]')
        elem_lines.append("  - " + " ".join(parts))

    elements_block = "\n".join(elem_lines)
    pii = context.piiSummary

    # Site adapter context
    adapter_context = ""
    if getattr(context, 'siteAdapter', None):
        adapter_context = f"\nSITE ADAPTER: {context.siteAdapter}"

    # Perception level
    perception_info = ""
    if getattr(context, 'perceptionLevel', None):
        level_names = {1: "DOM + Accessibility", 2: "DOM + Text", 3: "DOM + OCR", 4: "Screenshot"}
        perception_info = f"\nPERCEPTION LEVEL: {level_names.get(context.perceptionLevel, 'DOM')}"

    # Build action history block
    history_block = ""
    if previous_actions:
        lines = []
        for a in previous_actions:
            if isinstance(a, dict):
                act = a.get('action', '?')
                tgt = a.get('target', {}).get('value', '') if isinstance(a.get('target'), dict) else str(a.get('target') or '')
                val = a.get('value', '')
                reason = a.get('reason', '')
                step_idx = a.get('step', '?')
            else:
                act = getattr(a, 'action', '?')
                tgt_obj = getattr(a, 'target', None)
                tgt = getattr(tgt_obj, 'value', '') if tgt_obj else ''
                val = getattr(a, 'value', '') or ''
                reason = getattr(a, 'reason', '') or ''
                step_idx = getattr(a, 'step', '?')
            val_str = f"= {val}" if val else ''
            reason_str = f"→ {reason}" if reason else ''
            lines.append(f"  - Step {step_idx}: {act} {tgt} {val_str} {reason_str}".strip())
        history_block = "\nACTIONS ALREADY EXECUTED (DO NOT REPEAT THESE):\n" + "\n".join(lines) + "\n"

    # Build conversation history block
    conversation_block = ""
    if conversation_history:
        clines = []
        for ch in conversation_history:
            role = (ch.get('role') or ch.get('kind') or 'user').upper()
            txt = ch.get('text') or ch.get('content') or ''
            if txt:
                clines.append(f"  - {role}: {txt}")
        if clines:
            conversation_block = "\nCONVERSATION HISTORY (Current Interactive Session):\n" + "\n".join(clines) + "\n"

    return f"""TASK: {task}
STEP: {step}{adapter_context}{perception_info}
PAGE URL: {context.pageUrl}
PAGE TITLE: {context.pageTitle}
{conversation_block}{history_block}
PRIVACY: {pii.totalDetected} PII items redacted locally. Raw PII = 0 bytes.

INTERACTABLE ELEMENTS ({len(interactable)} elements — use el_NNN IDs in target.value):
{elements_block}

PAGE TEXT (sanitized):
{context.sanitizedText[:1000]}

INSTRUCTIONS: Use the el_NNN IDs from INTERACTABLE ELEMENTS in your target. 
Look at ACTIONS ALREADY EXECUTED and CONVERSATION HISTORY. Do NOT repeat any action already done.
CRITICAL: When completing OTP or submitting a form, NEVER click close (✕) or dismiss buttons! Always click the submission/verification button (e.g. 'Verify & Download').
Do NOT click modal close (✕) or dismiss buttons unless the user explicitly requested to close or cancel.
Return the SINGLE best NEXT action as JSON only."""



# ── RESPONSE PARSER ───────────────────────────────────────────────────────────

def parse_action_response(text: Any, context: Optional[SanitizedContext] = None, task: Optional[str] = None) -> BrowserAction:
    """
    Parse LLM response into a validated BrowserAction.
    Enriches action.target with human-friendly button/link label from context.elements.
    """
    if isinstance(text, list):
        parts = []
        for item in text:
            if isinstance(item, dict):
                parts.append(item.get('text', '') or item.get('content', '') or '')
            elif isinstance(item, str):
                parts.append(item)
        text = '\n'.join(parts)

    if not isinstance(text, str):
        text = str(text)

    # 1. Strip <think>...</think> reasoning blocks
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # 2. Strip markdown code blocks
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```$', '', text, flags=re.MULTILINE).strip()

    try:
        data = json.loads(text.strip())
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group())
            except json.JSONDecodeError:
                raise ValueError(f"Cannot parse LLM response: {text[:150]}")
        else:
            raise ValueError(f"Cannot parse LLM response: {text[:150]}")

    valid = {"click", "fill", "type", "scroll", "select", "focus", "navigate", "wait",
             "back", "forward", "finish", "ask_user", "done"}
    raw_action = data.get("action", "wait").lower()
    if raw_action == "type":
        action_type = "fill"
    elif raw_action in valid:
        action_type = raw_action
    else:
        action_type = "wait"

    target = None
    if "target" in data and data["target"]:
        t_data = data["target"]
        if isinstance(t_data, dict):
            t_val = str(t_data.get("elementId") or t_data.get("value") or "")
            t_type = str(t_data.get("type", "element-id"))
            if t_val:
                target = ActionTarget(
                    type=t_type if t_type in ("selector", "element-id", "role", "text") else "element-id",
                    value=t_val,
                    elementId=t_val,
                    friendlyName=t_data.get("friendlyName"),
                    label=t_data.get("label"),
                )
        elif isinstance(t_data, str):
            # LLM sometimes returns target as a plain string
            target = ActionTarget(type="element-id", value=t_data, elementId=t_data)

    # ── Resolve friendly human-readable name from context elements ─────────
    friendly_name = ""
    if target and context and getattr(context, "elements", None):
        clean_target_id = (target.elementId or target.value or "").replace("#", "").strip().lower()
        for el in context.elements:
            el_id = (getattr(el, "elementId", None) or el.id or "").replace("#", "").strip().lower()
            el_sel = (getattr(el, "domSelector", "") or "").strip().lower()
            if clean_target_id and (el_id == clean_target_id or el_sel == clean_target_id):
                raw_label = getattr(el, "label", None) or getattr(el, "ariaLabel", None) or getattr(el, "role", None) or getattr(el, "text", None) or ""
                cleaned = re.sub(r'^(PDF tool link:|link:|button:|tab:|menuitem:)\s*', '', str(raw_label), flags=re.IGNORECASE).strip()
                if cleaned:
                    friendly_name = cleaned
                    target.friendlyName = cleaned
                    target.label = cleaned
                    break

    # ── Guardrail: Prevent clicking close (✕) button when completing forms or OTP ─────────
    if action_type == "click" and target and context and getattr(context, "elements", None):
        target_role = ""
        for el in context.elements:
            el_id = getattr(el, "elementId", None) or el.id or ""
            if el_id == target.value:
                target_role = (getattr(el, "role", "") or getattr(el, "label", "") or "").lower()
                break
        is_close_target = any(k in target_role for k in ["close dialog", "✕", "do not click", "dismiss"])
        wants_close = any(k in (task or "").lower() for k in ["close", "cancel", "dismiss", "exit"])
        if is_close_target and not wants_close:
            # LLM mistakenly clicked close button thinking it's the action button!
            # Redirect to the actual verify / submit button if present!
            verify_el = next((el for el in context.elements if any(k in (getattr(el, "role", "") or getattr(el, "label", "")).lower() for k in ["verify & download", "verify and download", "verify", "submit otp", "download e-aadhaar"])), None)
            if verify_el:
                target.value = getattr(verify_el, "elementId", None) or verify_el.id
                target.elementId = target.value
                target.friendlyName = getattr(verify_el, "label", None) or getattr(verify_el, "role", None) or "Verify & Download"
                target.label = target.friendlyName
                friendly_name = target.friendlyName
                reason = "Clicking 'Verify & Download' button to complete the process"

    reason = data.get("reason", "LLM decision")
    task_str = (task or "").lower().strip()
    is_find_only = (task_str.startswith("find the ") or task_str.startswith("locate the ") or task_str.startswith("where is")) and not any(w in task_str for w in ["and", "then", "open", "click", "star", "submit", "fill", "book"])

    # If friendly name is resolved, clean any raw '#el_004' references in reason
    if friendly_name:
        reason = re.sub(r'#?el_\d+', f'"{friendly_name}"', reason)
        if is_find_only and action_type == "click":
            reason = f'I found the "{friendly_name}" button. Would you like me to click it?'

    requires_approval = bool(data.get("requiresApproval", False)) or (is_find_only and action_type == "click")
    is_sensitive_flow = any(w in reason.lower() for w in ["approve payment", "confirm purchase"])
    if is_sensitive_flow:
        requires_approval = True

    raw_conf = data.get("confidence", 0.9)
    try:
        c_val = float(raw_conf)
        if c_val > 1.0:
            c_val = c_val / 100.0
        confidence_val = max(0.0, min(1.0, c_val))
    except (ValueError, TypeError):
        confidence_val = 0.9

    return BrowserAction(
        action=action_type,
        target=target,
        value=data.get("value"),
        direction=data.get("direction"),
        amount=data.get("amount"),
        url=data.get("url"),
        reason=reason,
        confidence=confidence_val,
        requiresApproval=requires_approval,
        prompt=data.get("prompt"),
    )


# ── DYNAMIC DOM SOLVER (fallback only, when no API key) ───────────────────────

class DynamicDOMSolverLLM:
    """
    Rule-based fallback. Only used when no LLM API key is configured.
    Parses task text, conversation history, and element list to generate actions.
    """

    async def ainvoke(self, messages):
        raw_content = messages[-1].content if messages else ""
        if isinstance(raw_content, list):
            parts = []
            for item in raw_content:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        parts.append(str(item.get("text", "")))
                    elif "content" in item:
                        parts.append(str(item.get("content", "")))
                elif isinstance(item, str):
                    parts.append(item)
            prompt = "\n".join(parts)
        elif isinstance(raw_content, str):
            prompt = raw_content
        else:
            prompt = str(raw_content or "")

        # Extract TASK line
        task_m = re.search(r'^TASK: (.+)$', prompt, re.MULTILINE)
        task = task_m.group(1).strip() if task_m else ""

        # Extract STEP
        step_m = re.search(r'^STEP: (\d+)', prompt, re.MULTILINE)
        step = int(step_m.group(1)) if step_m else 1

        # Extract conversation history
        conv_history = []
        conv_block = re.search(r'CONVERSATION HISTORY \(Current Interactive Session\):\n(.*?)(?:\n\n|\nINTERACTABLE ELEMENTS|\nACTIONS ALREADY|\nPRIVACY:)', prompt, re.DOTALL)
        if conv_block:
            for line in conv_block.group(1).splitlines():
                m = re.search(r'^\s*-\s*([A-Z]+):\s*(.+)$', line)
                if m:
                    conv_history.append({"role": m.group(1).lower(), "text": m.group(2).strip()})

        # Extract history
        history = []
        hist_block = re.search(r'ACTIONS ALREADY EXECUTED \(DO NOT REPEAT THESE\):\n(.*?)(?:\n\n|\nPRIVACY:)', prompt, re.DOTALL)
        if hist_block:
            for line in hist_block.group(1).splitlines():
                # Match lines like "  - Step 3: fill #destination = Mumbai → reason" or "Step ?: ..."
                m = re.search(r'Step [\d?]+: (\w+)\s+([^=\n→]+?)(?:\s*=\s*([^→\n]+))?\s*(?:→\s*(.+))?$', line)
                if m:
                    reason_val = m.group(4).strip() if m.group(4) else ""
                    is_pending = any(w in reason_val.lower() for w in ["would you like", "shall i", "approve", "confirm", "found the"])
                    history.append({
                        "action": m.group(1).strip(),
                        "target": {"value": m.group(2).strip()},
                        "value": m.group(3).strip() if m.group(3) else "",
                        "reason": reason_val,
                        "requiresApproval": is_pending,
                    })

        # Extract PAGE URL & TITLE
        url_m = re.search(r'^PAGE URL:\s*(.+)$', prompt, re.MULTILINE)
        page_url = url_m.group(1).strip() if url_m else ""
        title_m = re.search(r'^PAGE TITLE:\s*(.+)$', prompt, re.MULTILINE)
        page_title = title_m.group(1).strip() if title_m else ""

        # Extract sanitized page text
        text_m = re.search(r'PAGE TEXT \(sanitized\):\n(.*?)(?:\n\n|\nINSTRUCTIONS:|$)', prompt, re.DOTALL)
        sanitized_text = text_m.group(1).strip() if text_m else ""

        # Parse element lines
        elements = []
        for line in prompt.splitlines():
            if line.strip().startswith("- ["):
                elements.append(line.strip())

        result = self._solve(task, step, elements, history, page_url=page_url, page_title=page_title, conv_history=conv_history, sanitized_text=sanitized_text)

        class R:
            def __init__(self, c): self.content = c
        return R(result)

    def _solve(
        self,
        task: str,
        step: int,
        elem_lines: list[str],
        history: list[dict] | None = None,
        page_url: str = "",
        page_title: str = "",
        conv_history: list[dict] | None = None,
        sanitized_text: str = "",
    ) -> str:
        """General-purpose browser task solver. Parses actual el_NNN element IDs and
        matches task keywords against any element type (button, link, input, etc.)."""

        # ── Parse elements from the el_NNN format ──────────────────────────────
        parsed = []
        for line in elem_lines:
            eid_m   = re.search(r'\[(el_\d+)\]',        line)
            lbl_m   = re.search(r'label="([^"]+)"',      line)
            ph_m    = re.search(r'placeholder="([^"]+)"',line)
            role_m  = re.search(r'role="([^"]+)"',       line)
            tag_m   = re.search(r'tag=(\w+)',            line)
            aria_m  = re.search(r'aria="([^"]+)"',       line)
            val_m   = re.search(r'value="([^"]+)"',      line)

            el_id       = eid_m.group(1)  if eid_m   else ""
            label       = (lbl_m.group(1)  if lbl_m   else "").lower()
            placeholder = (ph_m.group(1)   if ph_m    else "").lower()
            role        = (role_m.group(1)  if role_m  else "").lower()
            tag         = (tag_m.group(1)   if tag_m   else "").lower()
            aria        = (aria_m.group(1)  if aria_m  else "").lower()
            cur_val     = (val_m.group(1)   if val_m   else "").lower()

            # Combined hint for keyword matching
            hint = f"{label} {placeholder} {role} {aria} {cur_val}".strip().lower()

            is_button = tag in ("button",) or "button" in role
            is_input  = tag in ("input", "textarea") and tag != "button"
            is_select = tag == "select"
            is_link   = tag in ("a",)

            parsed.append({
                "el_id": el_id, "label": label, "placeholder": placeholder,
                "role": role, "tag": tag, "aria": aria, "hint": hint,
                "cur_val": cur_val,
                "is_button": is_button, "is_input": is_input,
                "is_select": is_select, "is_link": is_link,
            })

        # ── Track already-done actions ─────────────────────────────────────────
        done_set: set[tuple[str, str]] = set()
        last_pending_target: Optional[str] = None
        if history and len(history) > 0:
            last_h = history[-1]
            last_action_name = last_h.get("action", "") if isinstance(last_h, dict) else getattr(last_h, "action", "")
            tgt_obj = last_h.get("target") if isinstance(last_h, dict) else getattr(last_h, "target", None)
            last_tgt = (tgt_obj.get("value") or tgt_obj.get("elementId", "")) if isinstance(tgt_obj, dict) else getattr(tgt_obj, "value", "")
            was_pending_approval = bool(last_h.get("requiresApproval") if isinstance(last_h, dict) else getattr(last_h, "requiresApproval", False))

            navigated_to_tool = any(w in page_url.lower() for w in ["merge", "split", "compress", "convert"]) and len(history) <= 2
            if not navigated_to_tool and not was_pending_approval:
                done_set.add((last_action_name, last_tgt))
            if was_pending_approval and last_tgt:
                last_pending_target = last_tgt

        task_lower = task.lower().strip()

        STOP = {
            "click", "find", "found", "finds", "the", "button", "link", "card", "please", "step",
            "and", "for", "with", "web", "then", "open", "show", "press", "hit",
            "tap", "navigate", "use", "get", "from", "this", "that", "page",
            "tab", "into", "onto", "its", "has", "are", "was", "not", "can",
        }

        # ── Pronoun & Affirmative resolution from Conversation History ─────────
        # e.g. "Click it", "it", "click that button", "yes", "confirm", "proceed", "go ahead"
        is_pronoun_reference = bool(
            re.search(r'^(click\s+it|it|click\s+that|click\s+the\s+button|click\s+this|yes|confirm|proceed|ok|sure|go\s+ahead)$', task_lower) or
            re.search(r'\b(click\s+it|open\s+it)\b', task_lower)
        )
        if (is_pronoun_reference or task_lower in ("click it", "it", "yes", "confirm", "proceed")) and last_pending_target:
            target_el = next((el for el in parsed if el["el_id"] == last_pending_target), None)
            if target_el:
                display = target_el["label"] or target_el["role"] or target_el["el_id"]
                return json.dumps({
                    "action": "click",
                    "target": {"type": "element-id", "value": target_el["el_id"], "elementId": target_el["el_id"]},
                    "reason": f"Executing confirmed action on '{display}'",
                    "confidence": 0.95,
                    "requiresApproval": False,
                })

        if (is_pronoun_reference or task_lower in ("click it", "it", "yes", "confirm")) and conv_history:
            for prev in reversed(conv_history):
                prev_text = prev.get("text", "").lower()
                cand_words = [w for w in re.findall(r'[a-zA-Z0-9]+', prev_text) if len(w) >= 3 and w not in STOP and w not in ("click", "find", "button", "yes", "confirm", "would", "like")]
                if cand_words:
                    task_lower = f"click {' '.join(cand_words)}"
                    break

        # ── Multi-clause intent splitting ─────────────────────────────────────
        # If task has multiple clauses like "click Merge pdf and then open file explorer",
        # check which clause to fulfill based on action history and current page URL/title.
        clauses = [c.strip() for c in re.split(r'\b(?:and\s+then|then|after\s+that)\b', task_lower) if c.strip()]
        active_task = task_lower
        if len(clauses) > 1:
            c0 = clauses[0]
            c0_keywords = [w for w in re.findall(r'[a-zA-Z0-9]+', c0) if len(w) >= 3 and w not in STOP]
            already_at_c0 = False
            if c0_keywords:
                matched_in_page = sum(1 for w in c0_keywords if w in page_url.lower() or w in page_title.lower())
                if matched_in_page >= len(c0_keywords):
                    already_at_c0 = True

            if len(history or []) >= 1 or already_at_c0:
                active_task = clauses[1]
            else:
                active_task = clauses[0]

        # Check if user prompt is asking to "Find" vs "Click"
        wants_to_find = bool(re.search(r'\b(find|locate|where\s+is|search\s+for|show\s+me)\b', active_task)) and not bool(re.search(r'\b(click|press|tap|hit)\b', active_task))

        # ── Extract fill targets from task ─────────────────────────────────────
        dest, origin = "", ""
        origin_m = re.search(r'\bfrom\s+([A-Za-z\s]+?)(?:\s+station|\s+to|\s+on|\s+at|$)', task, re.I)
        dest_m   = re.search(r'\bto\s+([A-Za-z\s]+?)(?:\s+station|\s+from|\s+on|\s+at|$)', task, re.I)
        if origin_m: origin = origin_m.group(1).strip()
        if dest_m:   dest   = dest_m.group(1).strip()
        if not origin:
            orig_fallback = re.search(r'\bfrom\s+([A-Za-z]+)', task, re.I)
            if orig_fallback: origin = orig_fallback.group(1).strip()
        if not dest:
            dest_fallback = re.search(r'\bto\s+([A-Za-z]+)', task, re.I)
            if dest_fallback: dest = dest_fallback.group(1).strip()

        import datetime as _dt
        date_val = ""
        if "tomorrow" in task_lower:
            date_val = (_dt.date.today() + _dt.timedelta(days=1)).strftime("%d/%m/%Y")
        date_m = re.search(r'(\d{4}-\d{2}-\d{2})', task)
        if date_m: date_val = date_m.group(1)
        date_slash = re.search(r'(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})', task)
        if date_slash and not date_val:
            parts = re.split(r'[\/\-\.]', date_slash.group(1))
            if len(parts) == 3:
                day, month, year = parts[0].zfill(2), parts[1].zfill(2), parts[2]
                if len(year) == 2: year = "20" + year
                date_val = f"{day}/{month}/{year}"
            else:
                date_val = date_slash.group(1)

        # ── SPECIAL HANDLING 0: Direct navigation if starting on search engine / new tab ──────────
        is_search_or_blank = any(w in page_url.lower() for w in ["google.com", "bing.com", "duckduckgo.com", "search.brave.com", "newtab", "about:blank", "brave://", "chrome://"]) or not page_url
        if is_search_or_blank:
            if re.search(r'\b(?:aadhaar|uidai|myaadhaar)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://myaadhaar.uidai.gov.in",
                    "reason": "Navigating directly to official UIDAI MyAadhaar portal",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:pdf\s+to\s+word|convert\s+pdf|word\s+to\s+pdf)\b', task_lower) and not re.search(r'\b(?:aadhaar|uidai)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.ilovepdf.com/pdf_to_word",
                    "reason": "Navigating directly to PDF to Word converter on iLovePDF",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:merge\s+pdf|combine\s+pdf)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.ilovepdf.com/merge_pdf",
                    "reason": "Navigating directly to Merge PDF tool on iLovePDF",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:compress\s+pdf|reduce\s+pdf)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.ilovepdf.com/compress_pdf",
                    "reason": "Navigating directly to Compress PDF tool on iLovePDF",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:split\s+pdf)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.ilovepdf.com/split_pdf",
                    "reason": "Navigating directly to Split PDF tool on iLovePDF",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:train|irctc|pnr)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.irctc.co.in/nget/train-search",
                    "reason": "Navigating directly to IRCTC train booking",
                    "confidence": 0.98,
                })
            elif re.search(r'\b(?:flight|makemytrip)\b', task_lower):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://www.makemytrip.com",
                    "reason": "Navigating directly to MakeMyTrip flight booking",
                    "confidence": 0.98,
                })

        # ── SPECIAL HANDLING 1: Dismiss initial disclaimer / Kavach popup dialogs ──────────
        for el in parsed:
            if el["is_button"] and ("dismiss alert" in el["hint"] or "dismiss" in el["hint"] or el["hint"] == "ok"):
                if ("click", el["el_id"]) not in done_set:
                    return json.dumps({
                        "action": "click",
                        "target": {"type": "element-id", "value": el["el_id"], "elementId": el["el_id"]},
                        "reason": "Dismissing alert popup",
                        "confidence": 0.95,
                    })

        # ── SPECIAL HANDLING 2: IRCTC Login Modal (Human-In-The-Loop) ──────────
        has_login_modal = any(
            ("irctc password" in el["hint"] or "password" in el["hint"]) and el["is_input"]
            for el in parsed
        )
        if has_login_modal and ("login" in task_lower or "book" in task_lower or "irctc" in page_url.lower()):
            return json.dumps({
                "action": "ask_user",
                "prompt": "IRCTC requires login to proceed with booking. Please enter your credentials and solve the CAPTCHA. All your personal credentials remain strictly masked and protected on your local device.",
                "reason": "IRCTC login authentication required with Human-in-the-Loop",
                "confidence": 0.95,
            })

        # ── SPECIAL HANDLING 2b: Payment Gateway / Card Details (Human-In-The-Loop) ──────────
        has_card_or_cvv_in_lines = any(
            any(w in line.lower() for w in ["credit_card", "cvv", "card number", "expiry date", "credit card", "debit card"])
            for line in elem_lines
        )
        is_payment_flow = (
            "razorpay" in page_url.lower() or
            "checkout" in page_url.lower() or
            "payment" in page_url.lower() or
            any(k in task_lower for k in ["pay", "payment", "checkout", "buy"]) or
            has_card_or_cvv_in_lines
        ) and not ("uidai" in page_url.lower() or "aadhaar" in task_lower)
        has_card_or_cvv_inputs = any(
            el["is_input"] and any(k in el["hint"] for k in ["card number", "cvv", "cvc", "expiry", "mm / yy", "security code"])
            for el in parsed
        )

        if is_payment_flow and has_card_or_cvv_inputs:
            last_user_msg = next((m.get("text", "") for m in reversed(conv_history or []) if m.get("role") == "user"), "")
            # Only treat explicit confirmation phrases as having completed card entry
            already_confirmed = any(k in last_user_msg.lower() for k in ["done", "entered", "filled", "typed", "submitted", "card added", "details added", "i have entered"])
            if not already_confirmed:
                return json.dumps({
                    "action": "ask_user",
                    "prompt": "Please enter your card number, expiry date, and CVV to proceed with payment. All your financial details remain completely masked and private on your local device.",
                    "reason": "Payment security: Card details and CVV must be entered by the user with Human-in-the-Loop",
                    "confidence": 0.98,
                })

        # ── SPECIAL HANDLING 2c: UIDAI Aadhaar Download (Human-In-The-Loop) ──────────
        is_uidai = "uidai" in page_url.lower() or "aadhaar" in task_lower
        if is_uidai:
            last_user_msg = next((m.get("text", "") for m in reversed(conv_history or []) if m.get("role") == "user"), "").lower()
            user_confirmed = any(k in last_user_msg for k in ["done", "entered", "filled", "typed", "submitted", "i have entered", "details received", "provided", "ok", "yes", "proceed"])

            # Check if on Download Aadhaar page
            is_download_page = "genericdownloadaadhaar" in page_url.lower() or "gen-ae-aadhaar" in page_url.lower() or any("aadhaar number" in el["hint"] or "type characters" in el["hint"] for el in parsed)

            if is_download_page:
                # Check for "Verify & Download" button (EXCLUDE close/dismiss buttons and service cards!)
                verify_btn = next((el for el in parsed if any(k in el["hint"] for k in ["verify & download", "verify and download", "verify &amp; download", "download e-aadhaar", "download aadhaar"]) and not any(k in el["hint"] for k in ["service", "card", "home", "faq", "close", "dismiss", "✕", "\u2715", "x"])), None)
                if not verify_btn:
                    verify_btn = next((el for el in parsed if any(k in el["hint"] for k in ["verify", "download"]) and not any(k in el["hint"] for k in ["service", "card", "home", "faq", "close", "dismiss", "✕", "\u2715", "captcha"])), None)

                # Check if OTP fields or OTP modal/drawer is open
                has_otp_field = any(
                    (("enter mobile otp" in el["hint"] or "otp" in el["hint"]) and el["is_input"]) or
                    (el["is_input"] and el.get("cur_val") and len(el.get("cur_val", "")) == 1)
                    for el in parsed
                ) or (verify_btn is not None)

                # ── STEP A: If OTP modal / Verify & Download button is present ──
                if verify_btn is not None or has_otp_field:
                    assistant_asked_otp = any(any(k in m.get("text", "").lower() for k in ["enter the otp", "enter otp", "otp has been sent", "mobile otp", "enter your otp"]) for m in (conv_history or []) if m.get("role") == "assistant")
                    has_digits_entered = any(el["is_input"] and el.get("cur_val") and len(el.get("cur_val", "")) > 0 for el in parsed)
                    user_confirmed_otp = (assistant_asked_otp and user_confirmed) or ("otp" in last_user_msg and user_confirmed)
                    otp_ready = user_confirmed_otp or has_digits_entered

                    if not otp_ready:
                        return json.dumps({
                            "action": "ask_user",
                            "prompt": "An OTP has been sent to your UIDAI-registered mobile. Please enter the OTP on the page to continue.",
                            "reason": "UIDAI OTP verification requires Human-in-the-Loop; sensitive OTP is protected on-device",
                            "confidence": 0.98,
                        })
                    elif verify_btn:
                        return json.dumps({
                            "action": "click",
                            "target": {"type": "element-id", "value": verify_btn["el_id"], "elementId": verify_btn["el_id"]},
                            "reason": "Clicking 'Verify & Download' button to download e-Aadhaar",
                            "confidence": 0.98,
                        })

                # ── STEP B: Select Regular / Masked Radio Option if requested ──
                wants_masked = any(k in task_lower for k in ["masked", "mask aadhaar", "masked aadhaar"]) or any("masked" in m.get("text", "").lower() for m in reversed(conv_history or []) if m.get("role") == "user")
                wants_regular = any(k in task_lower for k in ["regular", "unmasked", "normal aadhaar"]) or any("regular" in m.get("text", "").lower() for m in reversed(conv_history or []) if m.get("role") == "user")

                if wants_masked:
                    masked_btn = next((el for el in parsed if any(k in el["hint"] for k in ["masked", "masked aadhaar", "do you want a masked aadhaar"]) and not any(k in el["hint"] for k in ["what is masked", "faq", "regular"])), None)
                    if masked_btn and ("click", masked_btn["el_id"]) not in done_set and "(checked)" not in masked_btn.get("role", ""):
                        return json.dumps({
                            "action": "click",
                            "target": {"type": "element-id", "value": masked_btn["el_id"], "elementId": masked_btn["el_id"]},
                            "reason": "Selecting 'Masked Aadhaar' option per user instruction",
                            "confidence": 0.98,
                        })
                elif wants_regular:
                    regular_btn = next((el for el in parsed if any(k in el["hint"] for k in ["regular aadhaar", "regular"]) and not any(k in el["hint"] for k in ["faq", "service"])), None)
                    if regular_btn and ("click", regular_btn["el_id"]) not in done_set and "(checked)" not in regular_btn.get("role", ""):
                        return json.dumps({
                            "action": "click",
                            "target": {"type": "element-id", "value": regular_btn["el_id"], "elementId": regular_btn["el_id"]},
                            "reason": "Selecting 'Regular Aadhaar' option per user instruction",
                            "confidence": 0.98,
                        })

                # ── STEP C: Check if credentials/CAPTCHA input needed ──
                has_cred_inputs = any(el["is_input"] and ("aadhaar" in el["hint"] or "captcha" in el["hint"] or "type characters" in el["hint"]) for el in parsed)
                if has_cred_inputs and not user_confirmed:
                    return json.dumps({
                        "action": "ask_user",
                        "prompt": "Please enter your 12-digit Aadhaar number and solve the CAPTCHA security code on the page, then click Send OTP.",
                        "reason": "UIDAI security requires user to solve CAPTCHA and provide Aadhaar number; sensitive credentials are masked on-device",
                        "confidence": 0.98,
                    })

                # ── STEP D: If user already entered credentials, click Request OTP / Get OTP (ONLY if verify_btn does NOT exist) ──
                if verify_btn is None:
                    req_otp_btn = next((el for el in parsed if any(k in el["hint"] for k in ["send otp", "request otp", "get otp"])), None)
                    if req_otp_btn and ("click", req_otp_btn["el_id"]) not in done_set:
                        return json.dumps({
                            "action": "click",
                            "target": {"type": "element-id", "value": req_otp_btn["el_id"], "elementId": req_otp_btn["el_id"]},
                            "reason": "Clicking 'Send OTP' button after user solved CAPTCHA",
                            "confidence": 0.95,
                        })

            # On MyAadhaar home page: locate Download Aadhaar service card or Get Aadhaar
            dl_card = next((el for el in parsed if any(k in el["hint"] for k in ["download aadhaar", "get aadhaar", "electronic copy", "e-aadhaar"]) and ("click", el["el_id"]) not in done_set), None)
            if dl_card:
                return json.dumps({
                    "action": "click",
                    "target": {"type": "element-id", "value": dl_card["el_id"], "elementId": dl_card["el_id"]},
                    "reason": "Navigating to Download Aadhaar service on UIDAI portal",
                    "confidence": 0.95,
                })

            if not is_download_page and any((h.get("action") == "click") for h in (history or [])):
                return json.dumps({
                    "action": "navigate",
                    "url": "https://myaadhaarbeta.uidai.gov.in/genericDownloadAadhaar/en",
                    "reason": "Navigating directly to e-Aadhaar download page on UIDAI portal",
                    "confidence": 0.95,
                })


        # ── SPECIAL HANDLING 3: Autocomplete suggestion selection (origin / destination) ──────────
        for el in parsed:
            if ("click", el["el_id"]) in done_set: continue
            if "station option" in el["hint"] or "station suggestion" in el["hint"]:
                h_low = el["hint"].lower()
                orig_words = [w.lower() for w in origin.split() if len(w) >= 3]
                dest_words = [w.lower() for w in dest.split() if len(w) >= 3]
                if (orig_words and any(w in h_low for w in orig_words)) or (dest_words and any(w in h_low for w in dest_words)):
                    return json.dumps({
                        "action": "click",
                        "target": {"type": "element-id", "value": el["el_id"], "elementId": el["el_id"]},
                        "reason": f"Select matching station suggestion '{el['label']}'",
                        "confidence": 0.95,
                    })

        # ── SPECIAL HANDLING 4: Train list page results (Book Now / Class Selection) ──────────
        if "train-list" in page_url.lower() or any("book now" in el["hint"] for el in parsed):
            # Check for class selection if user specified sleeper, 3a, 2a, etc.
            req_class = None
            if re.search(r'\b(?:sleeper|sl)\b', task_lower): req_class = "sleeper"
            elif re.search(r'\b(?:3a|3 tier|3rd ac|third ac)\b', task_lower): req_class = "3 tier"
            elif re.search(r'\b(?:2a|2 tier|2nd ac|second ac)\b', task_lower): req_class = "2 tier"
            elif re.search(r'\b(?:1a|1st ac|first ac)\b', task_lower): req_class = "first"

            # Click travel class
            if req_class:
                class_el = next((el for el in parsed if req_class in el["hint"] and ("click", el["el_id"]) not in done_set), None)
                if class_el:
                    return json.dumps({
                        "action": "click",
                        "target": {"type": "element-id", "value": class_el["el_id"], "elementId": class_el["el_id"]},
                        "reason": f"Select {req_class.upper()} travel class",
                        "confidence": 0.92,
                    })

            # Click Book Now
            book_btn = next((el for el in parsed if "book now" in el["hint"] and ("click", el["el_id"]) not in done_set), None)
            if book_btn:
                return json.dumps({
                    "action": "click",
                    "target": {"type": "element-id", "value": book_btn["el_id"], "elementId": book_btn["el_id"]},
                    "reason": "Clicking Book Now for selected train",
                    "confidence": 0.95,
                })

        # ── SPECIAL HANDLING 5: PDF Processing & Conversion Tools (iLovePDF, etc.) ──────────
        # Check if process/convert button is ready (e.g. "Convert to WORD", "Merge PDF", "Compress PDF")
        process_btn = next((
            el for el in parsed
            if (el["is_button"] or "btn" in el.get("tag", "") or el.get("el_id") == "processTask") and (
                el["el_id"] == "processTask" or
                "processtask" in el["el_id"].lower() or
                any(w in el["hint"] for w in ["convert to word", "merge pdf", "compress pdf", "split pdf", "convert to"])
            ) and ("click", el["el_id"]) not in done_set
        ), None)
        if process_btn:
            btn_lbl = process_btn["label"] or process_btn["role"] or "Convert to WORD"
            return json.dumps({
                "action": "click",
                "target": {"type": "element-id", "value": process_btn["el_id"], "elementId": process_btn["el_id"]},
                "reason": f"Clicking '{btn_lbl}' to process the uploaded file",
                "confidence": 0.98,
                "requiresApproval": False,
            })

        # Check if Download button is ready after conversion / processing
        download_btn = next((
            el for el in parsed
            if (el["is_button"] or el["is_link"]) and (
                any(w in el["hint"] for w in ["download word", "download merged pdf", "download file", "download pdf", "download document"]) or
                ("download" in el["hint"] and any(w in el["hint"] for w in ["word", "pdf", "file", "now"]))
            ) and ("click", el["el_id"]) not in done_set
        ), None)
        if download_btn:
            dl_lbl = download_btn["label"] or download_btn["role"] or "Download file"
            return json.dumps({
                "action": "click",
                "target": {"type": "element-id", "value": download_btn["el_id"], "elementId": download_btn["el_id"]},
                "reason": f"Clicking '{dl_lbl}' to save the converted file",
                "confidence": 0.99,
                "requiresApproval": False,
            })

        # If on download page and download button was clicked or file has finished converting, complete task
        is_on_download_page = not is_uidai and ("/download" in page_url.lower() or "converted to an editable" in (page_title + " " + sanitized_text).lower())
        if is_on_download_page and (len(history or []) > 0 or ("click", download_btn["el_id"] if download_btn else "") in done_set):
            return json.dumps({
                "action": "done",
                "reason": "The converted file has been downloaded to your downloads folder. Task completed!",
                "confidence": 0.99,
            })

        # ── STEP 1: Fill empty text inputs when task specifies values ──────────
        for el in parsed:
            if not el["is_input"]: continue
            if not el["el_id"]:    continue
            if ("fill", el["el_id"]) in done_set: continue
            if el["cur_val"]:       continue   # already has value
            h = el["hint"]
            fill_val = None
            if any(w in h for w in ["from", "origin", "depart", "source"]) and origin:
                fill_val = origin
            elif any(w in h for w in ["to", "dest", "arrival", "destination", "where"]) and dest:
                fill_val = dest
            elif any(w in h for w in ["date", "depart", "when", "travel"]) and date_val:
                fill_val = date_val
            if fill_val:
                return json.dumps({
                    "action": "fill",
                    "target": {"type": "element-id", "value": el["el_id"], "elementId": el["el_id"]},
                    "value": fill_val,
                    "reason": f"Fill '{el['label'] or el['placeholder']}' with '{fill_val}'",
                    "confidence": 0.90,
                })

        # ── STEP 2: Keyword-scored element matching ───────────────────────────
        task_words = [
            w for w in re.findall(r'[a-zA-Z0-9]+', active_task)
            if len(w) >= 3 and w not in STOP
        ]
        if not task_words:
            task_words = [
                w for w in re.findall(r'[a-zA-Z0-9]+', task_lower)
                if len(w) >= 3 and w not in STOP
            ]

        # Expand task words with common stems (e.g. pdfs -> pdf, merging -> merge)
        task_words_base = set()
        for w in task_words:
            task_words_base.add(w)
            if w.endswith("s") and len(w) > 3:
                task_words_base.add(w.rstrip("s"))
            if w.endswith("ing") and len(w) > 4:
                task_words_base.add(w[:-3])

        # File upload / explorer intents: specifically asking for file explorer, upload, or file selection
        wants_file_explorer = any(w in active_task for w in ["file explorer", "explorer", "upload", "select file", "select files", "choose file", "choose files", "browse"])
        is_on_tool_page = any(w in page_url.lower() for w in ["/merge", "/split", "/compress", "/convert", "merge_pdf", "split_pdf"])

        scored: list[tuple[int, dict]] = []
        for el in parsed:
            if not el["el_id"]: continue
            if ("click", el["el_id"]) in done_set: continue
            h = el["hint"]

            # Penalize brand / header logos (e.g. "ilovepdf", "logo", links to home)
            is_brand_logo = (
                el["label"] in ("ilovepdf", "logo", "brand", "home") or
                "logo" in el["role"] or "brand" in el["role"] or
                "logo" in el["aria"] or "brand" in el["aria"] or
                (el["el_id"] == "el_001" and el["label"] in ("ilovepdf", ""))
            )
            if is_brand_logo and not any(w in active_task for w in ["home", "logo", "brand"]):
                continue

            # Word match score
            score = sum(4 for w in task_words_base if w in h)

            # Check if this element is a file picker/uploader button
            is_file_picker_elem = (not is_on_download_page) and (
                any(w in h for w in ["select pdf files", "select files", "choose files", "upload", "select file", "browse file"]) or
                ("file" in el.get("tag", "") and not "download" in h) or
                (el.get("el_id") == "pickfiles" and not "download" in h)
            )

            # Boost file upload elements when task explicitly requests file explorer / upload OR already on tool page and not asking for a different tool
            if wants_file_explorer and is_file_picker_elem:
                score += 15
            elif is_on_tool_page and is_file_picker_elem and not any(w in active_task for w in ["split", "compress", "convert"]):
                score += 10

            if score > 0:
                if el["is_button"] or el["is_link"]:
                    score += 2
                scored.append((score, el))

        if scored:
            scored.sort(key=lambda x: -x[0])
            best_score, best_el = scored[0]
            display = best_el["label"] or best_el["role"] or best_el["el_id"]
            h_lower = best_el["hint"].lower()
            is_file_picker = (
                any(w in h_lower for w in ["select pdf files", "select files", "choose files", "upload", "pickfiles", "select file", "browse file"]) or
                "file" in best_el.get("tag", "").lower() or
                "file" in best_el.get("role", "").lower() or
                best_el.get("el_id") == "pickfiles"
            )
            confidence = 0.95
            display_clean = display.replace("_", " ").title()

            is_confirmed_turn = (
                is_pronoun_reference or
                task_lower in ("click it", "it", "yes", "confirm", "proceed", "sure", "ok") or
                any(w in task_lower for w in ["yes", "confirm", "proceed", "go ahead", "approved"])
            )

            if wants_to_find:
                if is_file_picker:
                    action_reason = "Shall I click on Select PDF files to open file explorer?"
                else:
                    action_reason = f"I found the {display_clean} button. Would you like me to click it?"
                requires_approval = True
            elif is_file_picker:
                action_reason = "Clicking to open file explorer for file selection"
                requires_approval = False
            else:
                action_reason = f"Clicking '{display_clean}' to proceed with task"
                requires_approval = False

            return json.dumps({
                "action": "click",
                "target": {"type": "element-id", "value": best_el["el_id"], "elementId": best_el["el_id"]},
                "reason": action_reason,
                "confidence": confidence,
                "requiresApproval": requires_approval,
            })

        # ── STEP 3: Generic submit/search button fallback ──────────────────────
        SUBMIT_WORDS = {
            "search", "submit", "go", "find", "login", "signin", "register",
            "continue", "next", "confirm", "buy", "book", "order", "pay",
            "proceed", "start", "begin", "run",
        }
        task_implies_submit = any(w in task_lower for w in SUBMIT_WORDS)
        if task_implies_submit:
            for el in parsed:
                if not (el["is_button"] or el["is_link"]): continue
                if not el["el_id"]: continue
                if ("click", el["el_id"]) in done_set: continue
                if any(w in el["hint"] for w in SUBMIT_WORDS):
                    return json.dumps({
                        "action": "click",
                        "target": {"type": "element-id", "value": el["el_id"], "elementId": el["el_id"]},
                        "reason": f"Click submission element matching task intent",
                        "confidence": 0.78,
                    })

        # ── STEP 4: If step 1 + elements present → scroll to reveal more ───────
        if step == 1 and parsed:
            return json.dumps({
                "action": "scroll",
                "direction": "down",
                "amount": 400,
                "reason": f"Scrolling down to find elements matching: {task}",
                "confidence": 0.68,
            })

        # ── STEP 5: Task completion or no match ────────────────────────────────
        if history and len(history) > 0:
            return json.dumps({
                "action": "done",
                "reason": f"Completed {len(history)} action(s) for task: {task}",
                "confidence": 0.85,
            })

        return json.dumps({
            "action": "done",
            "reason": f"I couldn't confidently find the requested button for: {task}",
            "confidence": 0.40,
        })


# ── MAIN REASONER ─────────────────────────────────────────────────────────────

_llm: Optional[Any] = None

def get_cached_llm() -> Any:
    global _llm
    if _llm is None:
        _llm = get_llm()
    return _llm


async def reason(
    task: str,
    context: SanitizedContext,
    step: int = 1,
    previous_actions: list[dict] | None = None,
    step_number: int | None = None,
    conversation_history: list[dict] | None = None,
    **kwargs,
) -> tuple[BrowserAction, int, str, str, str]:
    """
    Main reasoning function with multimodal VLM vision support.
    Returns (action, latency_ms, model_name, prompt_sent, raw_llm_response).
    Server receives ONLY sanitized context — no raw PII ever here.
    """
    if isinstance(step, list) and previous_actions is None:
        previous_actions, step = step, 1
    elif isinstance(previous_actions, int):
        step, previous_actions = previous_actions, (step if isinstance(step, list) else [])

    if step_number is not None:
        step = step_number
    if previous_actions is None:
        previous_actions = []

    llm = get_cached_llm()
    prompt = format_context_for_llm(task, context, step, previous_actions, conversation_history)
    full_prompt = f"[SYSTEM]\n{SYSTEM_PROMPT}\n\n[USER]\n{prompt}"

    provider = os.getenv("LLM_PROVIDER", "gemini").lower()

    # Multimodal image handling: In SIH 171, provide visual screenshot perception to VLM whenever available
    raw_screen = getattr(context, "sanitizedScreenshot", None) or getattr(context, "screenshot", None)
    has_image = bool(raw_screen and len(str(raw_screen)) > 100)
    if has_image and provider in ("gemini", "openai"):
        image_url = str(raw_screen)
        if image_url and not image_url.startswith("data:"):
            image_url = f"data:image/jpeg;base64,{image_url}"
        human_content: list[dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=cast(Any, human_content))]
    else:
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]

    t0 = time.time()
    try:
        if provider == "gemini":
            import asyncio
            response = await asyncio.to_thread(llm.invoke, messages)
        else:
            response = await llm.ainvoke(messages)
        latency_ms = int((time.time() - t0) * 1000)
        if isinstance(response.content, list):
            raw_text = "\n".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in response.content
            )
        else:
            raw_text = str(response.content)
        action = parse_action_response(raw_text, context=context, task=task)
        model_map = {
            "groq": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            "gemini": os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            "openai": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            "anthropic": os.getenv("ANTHROPIC_MODEL", "claude-haiku-20240307"),
        }
        model_name = model_map.get(provider, "dynamic-dom-solver")
        print(f"[Reasoner] Step {step} -> {action.action} ({latency_ms}ms) | target={action.target} val={action.value}")
        return action, latency_ms, model_name, full_prompt, raw_text

    except Exception as err:
        print(f"[Reasoner] LLM error at step {step}: {err}")
        # Reset cached LLM so next call tries fresh
        global _llm
        _llm = None
        # Fall back to rule-based solver
        solver = DynamicDOMSolverLLM()
        text_messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]
        r2 = await solver.ainvoke(text_messages)
        latency_ms = int((time.time() - t0) * 1000)
        raw_text = r2.content if isinstance(r2.content, str) else str(r2.content)
        action = parse_action_response(raw_text, context=context, task=task)
        print(f"[Reasoner] Fallback solver step {step} -> {action.action}")
        return action, latency_ms, "fallback-solver", full_prompt, raw_text

