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
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        from langchain_google_genai import ChatGoogleGenerativeAI
        print(f"[Reasoner] Using Gemini model: {model_name}")
        return ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=api_key,
            temperature=0.1,
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
6. Do NOT repeat an action already in ACTIONS ALREADY EXECUTED unless the page state changed.
7. SENSITIVE DATA: If the task requires a password, OTP, payment info, or government ID, use ask_user.
8. COMPLETION: When the task goal is visibly achieved (article found, results shown, form done), return done or finish.
9. CONFIDENCE: Be honest about confidence. Low = 0.70, Medium = 0.85, High = 0.95+
10. NAVIGATION: After a search/submit, wait to see results on the NEXT step before acting on them.

SITE-SPECIFIC WORKFLOWS:
- MAKEMYTRIP (makemytrip.com):
  * If a login popup or promotional modal appears, click its close/dismiss button or click directly on the flight search form.
  * For flights: Click "One Way" tab if one-way. Click "From" input, type city name (e.g. "Delhi").
  * CRITICAL: Immediately after typing a city in From or To, CLICK the first autocomplete suggestion from the dropdown. Do not press Enter.
  * For Date: Click the departure date picker and select the requested date from the calendar.
  * Click the "Search" button. When results appear, call done.
- ILOVEPDF (ilovepdf.com):
  * If on homepage, click the required tool link (e.g. "Merge PDF", "Compress PDF", "PDF to Word").
  * On tool page: click "Select PDF files" (#pickfiles) to trigger file upload. Reason: "Shall I click on Select PDF files to open file explorer?"
  * NEVER return done without first clicking the file selection button.
  * Click the "Download" button when ready.
- WIKIPEDIA (wikipedia.org):
  * Find the search input, fill the query, click search or press enter, and locate the primary article content.

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
        if el.label:
            parts.append(f'label="{el.label}"')
        if el.placeholder:
            parts.append(f'placeholder="{el.placeholder}"')
        if el.role:
            parts.append(f'role="{el.role[:80]}"')
        if getattr(el, 'ariaLabel', None):
            parts.append(f'aria="{el.ariaLabel}"')
        if el.value and not el.sensitive:
            parts.append(f'value="{el.value}"')
        if el.sensitive:
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
Return the SINGLE best NEXT action as JSON only."""



# ── RESPONSE PARSER ───────────────────────────────────────────────────────────

def parse_action_response(text) -> BrowserAction:
    """Parse LLM response — handles strings, lists, <think> tags, and trailing metadata."""
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

    # 1. Strip <think>...</think> reasoning blocks from thinking models (e.g. Qwen, DeepSeek)
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # 2. Strip markdown code blocks
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```$', '', text, flags=re.MULTILINE).strip()

    data = None
    # 3. Try standard json.loads
    try:
        data = json.loads(text)
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
                target = ActionTarget(type=t_type if t_type in ("selector", "element-id", "role", "text") else "element-id", value=t_val, elementId=t_val)
        elif isinstance(t_data, str):
            # LLM sometimes returns target as a plain string
            target = ActionTarget(type="element-id", value=t_data, elementId=t_data)

    reason = data.get("reason", "LLM decision")
    requires_approval = bool(data.get("requiresApproval", False))
    if any(w in reason.lower() for w in ["shall i", "approve", "select pdf files", "select files", "choose files", "open file explorer", "would you like me to"]):
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

        # Parse element lines
        elements = []
        for line in prompt.splitlines():
            if line.strip().startswith("- ["):
                elements.append(line.strip())

        result = self._solve(task, step, elements, history, page_url=page_url, page_title=page_title, conv_history=conv_history)

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
            hint = f"{label} {placeholder} {role} {aria}".strip().lower()

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
        dest_m   = re.search(r'\bto\s+([A-Za-z]+)', task, re.I)
        origin_m = re.search(r'\bfrom\s+([A-Za-z]+)', task, re.I)
        if dest_m:   dest   = dest_m.group(1).strip()
        if origin_m: origin = origin_m.group(1).strip()

        import datetime as _dt
        date_val = ""
        if "tomorrow" in task_lower:
            date_val = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
        date_m = re.search(r'(\d{4}-\d{2}-\d{2})', task)
        if date_m: date_val = date_m.group(1)

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
            is_file_picker_elem = (
                any(w in h for w in ["select pdf files", "select files", "choose files", "upload", "pickfiles", "select file", "browse file"]) or
                "file" in el.get("tag", "") or "file" in el.get("placeholder", "") or
                el.get("el_id") == "pickfiles"
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

            is_confirmed_turn = bool(
                is_pronoun_reference or
                task_lower in ("click it", "it", "yes", "confirm", "proceed", "sure", "ok") or
                any(w in task_lower for w in ["yes", "confirm", "proceed", "go ahead", "approved"])
            )

            if wants_to_find or not is_confirmed_turn:
                if is_file_picker:
                    action_reason = "Shall I click on Select PDF files to open file explorer?"
                else:
                    action_reason = f"I found the {display_clean} button. Would you like me to click it?"
                requires_approval = True
            elif is_file_picker:
                action_reason = "Shall I click on Select PDF files to open file explorer?"
                requires_approval = False
            else:
                action_reason = f"Executing confirmed action on '{display_clean}'"
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

    # Multimodal image handling: if sanitized screenshot is attached, pass it to VLM
    has_image = bool(getattr(context, "sanitizedScreenshot", None) and getattr(context, "screenshotIncluded", False))
    if has_image and provider in ("gemini", "openai"):
        raw_screen = getattr(context, "sanitizedScreenshot", None) or ""
        image_url = str(raw_screen)
        if image_url and not image_url.startswith("data:"):
            image_url = f"data:image/webp;base64,{image_url}"
        human_content: list[dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=cast(Any, human_content))]
    else:
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)]

    t0 = time.time()
    try:
        response = await llm.ainvoke(messages)
        latency_ms = int((time.time() - t0) * 1000)
        raw_text = response.content if isinstance(response.content, str) else str(response.content)
        action = parse_action_response(raw_text)
        model_map = {
            "groq": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            "gemini": os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
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
        action = parse_action_response(raw_text)
        print(f"[Reasoner] Fallback solver step {step} -> {action.action}")
        return action, latency_ms, "fallback-solver", full_prompt, raw_text

