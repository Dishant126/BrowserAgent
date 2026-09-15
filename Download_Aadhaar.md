PRIVSIGHT — END-TO-END VERIFICATION MILESTONE:
AADHAAR e-AADHAAR DOWNLOAD + SENSITIVE DATA PROTECTION

I want to test PrivSight against a real, security-sensitive workflow:

"Open the official UIDAI MyAadhaar portal, download my e-Aadhaar, and save the downloaded PDF."

IMPORTANT:
This is a PRIVACY/VERIFICATION test.

Do NOT bypass OTP, CAPTCHA, authentication, or any UIDAI security mechanism.

The user must remain in control of:
- Aadhaar number
- OTP
- CAPTCHA/security code
- any authentication/confirmation step

The agent may navigate the website and perform normal browser actions, but it must STOP and ask the user when sensitive authentication input is required.

Official UIDAI information indicates that e-Aadhaar can be downloaded through the MyAadhaar portal and requires mobile OTP authentication. e-Aadhaar is a password-protected PDF.

PRIMARY GOAL:

Determine whether the CURRENT PrivSight implementation can successfully perform this workflow while ensuring that sensitive information is detected locally and is NEVER transmitted to the server/LLM in raw form.

DO NOT immediately modify the code.

FIRST AUDIT THE EXISTING IMPLEMENTATION.

==================================================
PHASE 1 — INSPECT CURRENT CAPABILITIES
==================================================

Inspect the existing code for:

1. Browser navigation
2. Element detection
3. DOM extraction
4. Screenshot capture
5. Visual perception
6. OCR
7. PII detection
8. Screenshot redaction
9. DOM/field redaction
10. Action planning
11. Click execution
12. Fill/type execution
13. User confirmation / ask_user
14. Download detection
15. Download handling
16. Voice input/output
17. Privacy audit logging
18. Server payload sanitization

Determine whether PrivSight can currently:

- open myAadhaar
- identify the Download Aadhaar service
- identify the Aadhaar number field
- identify CAPTCHA/security-code fields
- identify the Request OTP action
- recognize an OTP input field
- pause for user input
- continue after the user enters OTP
- submit the OTP
- detect the resulting download
- confirm that the e-Aadhaar PDF was downloaded

DO NOT assume any of these capabilities exist.

Report what is actually implemented.

==================================================
PHASE 2 — SENSITIVE DATA AUDIT
==================================================

Inspect the current PII detector and determine whether it protects the following:

CRITICAL:

1. Aadhaar number
   Format commonly represented as:
   XXXX XXXX XXXX
   or
   XXXX-XXXX-XXXX
   or continuous 12 digits

2. OTP
   Usually a short numeric one-time code.

3. Mobile/phone number

4. Email address

5. Date of birth

6. Address

7. VID
   Virtual ID

8. EID / Enrollment ID

9. Passport/identity numbers if encountered

10. Bank/payment information if encountered

11. Authentication tokens/API keys/session tokens

12. QR codes containing identity information

13. Aadhaar PDF contents

14. Passwords / PINs

IMPORTANT:

Do NOT rely only on regex.

Use BOTH:

A. Pattern detection
AND
B. Semantic/context detection based on:
   - field label
   - input name
   - input type
   - placeholder
   - aria-label
   - surrounding text
   - DOM attributes

For example:

<input type="text" name="aadhaar">

should be treated as sensitive even if the value does not match a perfect regex.

Likewise:

<input type="text" name="otp">

must be classified as sensitive.

==================================================
PHASE 3 — PRIVACY INVARIANT
==================================================

The following information MUST NEVER be sent to the server/LLM:

- raw Aadhaar number
- raw OTP
- raw phone number
- raw email
- raw DOB
- raw address
- raw VID/EID
- passwords
- authentication tokens
- sensitive QR content
- raw identity-document contents

The server should receive only sanitized context.

Example:

RAW CLIENT CONTEXT:

Aadhaar Number:
1234 5678 9012

OTP:
483921

Phone:
9876543210

SANITIZED SERVER CONTEXT:

Aadhaar Number:
[REDACTED]

OTP:
[REDACTED]

Phone:
[REDACTED]

The LLM may still receive semantic information such as:

"An Aadhaar number field is present."

"An OTP input is present."

"An OTP is required to continue."

But it must NOT receive the actual values.

==================================================
PHASE 4 — SCREENSHOT PRIVACY
==================================================

Test screenshot behavior carefully.

For every perception cycle:

REAL BROWSER SCREENSHOT
        ↓
LOCAL DETECTION
        ↓
LOCAL REDACTION
        ↓
SANITIZED SCREENSHOT
        ↓
SERVER / LLM

The raw screenshot must remain client-side.

The sanitized screenshot may be transmitted.

IMPORTANT:

The sanitized screenshot must still look like the actual UIDAI page.

Do NOT replace the screenshot with a synthetic debug representation.

For example:

RAW:
Actual UIDAI page
+ Aadhaar number
+ OTP field
+ other personal information

SANITIZED:
Same UIDAI page
+ Aadhaar number masked
+ OTP masked
+ phone masked
+ other sensitive regions masked

The page structure must remain recognizable.

==================================================
PHASE 5 — LIVE DOM MASKING
==================================================

Inspect whether PrivSight currently modifies the live webpage when masking sensitive information.

If live DOM masking is being used:

- masks must be temporary
- masks must be tracked
- masks must be removed after the perception/action cycle
- old masks must NOT remain when a new modal/page appears

Test:

STEP 1:
UIDAI page
→ detect Aadhaar field
→ mask

STEP 2:
Request OTP
→ new state/modal
→ previous mask must be cleaned up

STEP 3:
OTP field appears
→ fresh detection
→ OTP mask created

STEP 4:
OTP submitted
→ old OTP mask cleaned up

No stale redaction boxes may remain.

If possible, prefer screenshot/canvas redaction rather than modifying the actual live webpage.

==================================================
PHASE 6 — OTP SAFETY
==================================================

This is CRITICAL.

When the workflow reaches OTP:

PrivSight should NOT:

- guess the OTP
- retrieve the OTP from an external service
- scrape SMS
- transmit OTP to the backend
- transmit OTP to the LLM
- speak the OTP aloud
- log the OTP

Instead:

Agent:
"An OTP is required to continue. Please enter the OTP received on your registered mobile."

User enters OTP.

PrivSight should treat the OTP field as sensitive.

The action sent to the LLM should contain only:

"OTP field is populated."

NOT:

"OTP = 483921"

If voice output is enabled, it must never say the OTP itself.

==================================================
PHASE 7 — ACTUAL END-TO-END TEST
==================================================

Use the official UIDAI MyAadhaar website.

Do NOT use a fake website unless the real site cannot be tested.

Start from a clean browser state.

Test task:

"Open the UIDAI MyAadhaar portal and download my e-Aadhaar."

Perform the workflow manually through the agent.

Expected sequence:

1. Open MyAadhaar
2. Navigate to Download Aadhaar
3. Identify required authentication/input fields
4. User provides Aadhaar number
5. PrivSight detects it as sensitive
6. Screenshot sanitization masks Aadhaar number
7. Request OTP
8. PrivSight detects OTP field
9. Agent pauses for user
10. User enters OTP
11. OTP remains local
12. Agent continues
13. e-Aadhaar download occurs
14. Verify downloaded file exists
15. Do NOT expose the PDF contents to the LLM unless there is a specific privacy-safe reason to do so

==================================================
PHASE 8 — DOWNLOAD SECURITY
==================================================

The downloaded e-Aadhaar is itself extremely sensitive.

Do NOT automatically:

- upload the PDF to the backend
- send it to the LLM
- OCR the entire PDF and send it to the server
- expose the PDF in the Judges Console
- log its contents
- print its contents to console

If the agent needs to confirm success, prefer metadata such as:

"e-Aadhaar PDF downloaded successfully."

The actual PDF should remain local.

If any local inspection is required, redact sensitive contents before any external transmission.

==================================================
PHASE 9 — JUDGES CONSOLE
==================================================

Verify that the dashboard can clearly demonstrate the privacy behavior.

It should be possible to show:

RAW CLIENT VIEW
        vs
SANITIZED SERVER VIEW

Example:

RAW:
Aadhaar number visible
OTP visible
phone visible

SANITIZED:
Aadhaar → [REDACTED]
OTP → [REDACTED]
phone → [REDACTED]

And the dashboard should show:

Raw PII Sent: 0

The important point is that "0 Raw PII Sent" must represent an actual invariant, not merely a UI counter.

Trace the actual server request payload and verify this.

==================================================
PHASE 10 — FAILURE / EDGE CASE TESTS
==================================================

Test at least:

A. Aadhaar number entered
→ verify redaction.

B. Aadhaar number with spaces:
1234 5678 9012
→ verify detection.

C. Aadhaar number without spaces:
123456789012
→ verify detection if appropriate.

D. OTP entered
→ verify redaction.

E. Phone number displayed
→ verify redaction.

F. DOB displayed
→ verify redaction.

G. Address displayed
→ verify redaction.

H. OTP error / retry
→ verify previous OTP value is never leaked.

I. Page navigation after Aadhaar input
→ verify old masks disappear.

J. New OTP modal
→ verify fresh detection.

K. Agent STOP during OTP
→ verify sensitive values are not logged/transmitted.

L. Agent ERROR
→ verify sensitive values are not logged/transmitted.

M. Voice Output ON
→ verify it NEVER speaks Aadhaar number or OTP.

N. Voice Input
→ verify turning voice output off/on does not affect input.

==================================================
PHASE 11 — DO NOT MODIFY YET
==================================================

This first milestone is primarily an AUDIT + REAL-WORLD VERIFICATION.

Do NOT redesign the architecture.

Do NOT add:
- Browser Use
- Playwright
- new LLM
- new OCR engine
- new vision model
- Firefox support
- new UI
- new TTS
- unrelated features

Only make small fixes if they are absolutely necessary to safely execute the test.

If a capability is missing, report it rather than creating a large implementation.

==================================================
FINAL REPORT
==================================================

After testing, report:

1. Can PrivSight currently navigate the complete Aadhaar download workflow?
   YES / PARTIAL / NO

2. Which exact step fails, if any?

3. Can the agent correctly identify the UIDAI Download Aadhaar workflow?

4. Can it identify Aadhaar fields?

5. Can it detect Aadhaar numbers locally?

6. Can it detect OTP fields locally?

7. Can it detect phone/email/DOB/address?

8. Does raw Aadhaar/OTP ever reach the server?

9. Does raw screenshot ever reach the server?

10. Does the sanitized screenshot preserve the real UIDAI page?

11. Does live DOM masking leave stale masks?

12. Does voice output avoid sensitive information?

13. Can the downloaded PDF remain completely local?

14. What exact files would need to be modified to make the workflow production/demo ready?

15. List the TOP 3 fixes needed.

IMPORTANT:
Do not claim success merely because the UI looks correct.

Verify the actual browser actions and actual network payloads.

STOP after this audit/test.