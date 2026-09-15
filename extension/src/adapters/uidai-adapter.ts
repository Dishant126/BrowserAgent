/**
 * UIDAI Site Adapter — myaadhaar.uidai.gov.in & uidai.gov.in
 *
 * Supported workflows:
 *   - download_aadhaar: Navigate to Download Aadhaar, guide user through Aadhaar/CAPTCHA input,
 *     trigger OTP request, prompt user for OTP, and safely trigger e-Aadhaar PDF download.
 *
 * Security & Privacy Invariants:
 *   - 100% on-device PII masking (Aadhaar number and OTP are NEVER sent to backend).
 *   - Never bypass or guess CAPTCHA; prompts the user via ask_user.
 *   - Never bypass or guess OTP; prompts the user via ask_user.
 *   - The downloaded e-Aadhaar PDF remains strictly local.
 */

import { BaseSiteAdapter, type SiteCapabilities, type PageContext } from './adapter-interface';
import type { UIElement } from '../utils/types';

export class UidaiAdapter extends BaseSiteAdapter {
  readonly name = 'UIDAI MyAadhaar';
  readonly domains = ['myaadhaar.uidai.gov.in', 'myaadhaarbeta.uidai.gov.in', 'uidai.gov.in'];
  readonly urlPatterns = [
    /https?:\/\/(?:myaadhaar|myaadhaarbeta|www)\.uidai\.gov\.in/i,
  ];
  readonly supportLevel = 'full' as const;
  readonly workflows = ['download_aadhaar', 'check_enrolment_status'];

  getCapabilities(): SiteCapabilities {
    return {
      workflows: this.workflows,
      hasRichA11y: false,
      hasStableIds: false,
      domains: this.domains,
      requiresScrollBeforeInteraction: false,
      isDynamic: true,
      stopBeforePayment: true,
    };
  }

  normalizeElements(elements: UIElement[]): UIElement[] {
    return elements.map(el => {
      const hint = [
        el.placeholder, el.label, el.role, el.ariaLabel, el.text,
        el.value, el.attributes?.['value'], el.accessibleName,
        el.domSelector, el.attributes?.['id'], el.attributes?.['name'],
        el.attributes?.['class'], el.attributes?.['data-testid'],
      ].filter(Boolean).join(' ').toLowerCase();

      // 1. "Download Aadhaar" service card on homepage
      if (/download\s*aadhaar|electronic\s*copy|e-aadhaar/i.test(hint) && (el.tagName === 'button' || el.tagName === 'div' || el.tagName === 'a' || el.tagName === 'span')) {
        if (!hint.includes('verify') && !hint.includes('get otp')) {
          return {
            ...el,
            label: 'Download Aadhaar Service',
            ariaLabel: 'Download Aadhaar Service',
            role: 'Download e-Aadhaar service button',
          };
        }
      }

      // 2. Aadhaar number input (placeholder "XXXX XXXX XXXX" or "Enter Aadhaar Number")
      if ((/x{4}\s*x{4}\s*x{4}/i.test(hint) || (/aadhaar/i.test(hint) && /number|enter|input/i.test(hint))) && el.tagName === 'input') {
        return {
          ...el,
          label: 'Enter 12-Digit Aadhaar Number',
          ariaLabel: 'Enter 12-Digit Aadhaar Number',
          role: 'Aadhaar number sensitive input',
          sensitive: true,
          sensitivityType: 'aadhaar',
        };
      }

      // 3. Virtual ID (VID) radio / tab
      if (/virtual\s*id|\bvid\b/i.test(hint) && (el.tagName === 'button' || el.tagName === 'input' || el.tagName === 'span' || el.tagName === 'label')) {
        return {
          ...el,
          label: 'Virtual ID (VID) Option',
          ariaLabel: 'Virtual ID (VID) Option',
          role: 'Virtual ID selection tab',
        };
      }

      // 4. Enrolment ID (EID) radio / tab
      if (/enrolment\s*id|\beid\b/i.test(hint) && (el.tagName === 'button' || el.tagName === 'input' || el.tagName === 'span' || el.tagName === 'label')) {
        return {
          ...el,
          label: 'Enrolment ID (EID) Option',
          ariaLabel: 'Enrolment ID (EID) Option',
          role: 'Enrolment ID selection tab',
        };
      }

      // 5. CAPTCHA input (placeholder "Type Characters" or label containing "Captcha")
      if ((/type\s*characters|enter\s*captcha|security\s*code|captcha/i.test(hint)) && el.tagName === 'input' && !hint.includes('aadhaar') && !hint.includes('otp')) {
        return {
          ...el,
          label: 'Enter Security CAPTCHA',
          ariaLabel: 'Enter Security CAPTCHA',
          role: 'Security CAPTCHA verification input',
        };
      }

      // 6. Refresh CAPTCHA button
      if (/refresh|reload/i.test(hint) && /captcha/i.test(hint) && (el.tagName === 'button' || el.tagName === 'svg' || el.tagName === 'i')) {
        return {
          ...el,
          label: 'Refresh CAPTCHA',
          ariaLabel: 'Refresh CAPTCHA',
          role: 'Refresh security CAPTCHA button',
        };
      }

      // 7. "Send OTP" / "Get OTP" / "Request OTP" button
      if (/send\s*otp|get\s*otp|request\s*otp/i.test(hint) && (el.tagName === 'button' || el.tagName === 'span' || el.tagName === 'div')) {
        return {
          ...el,
          label: 'Request OTP',
          ariaLabel: 'Request OTP',
          role: 'Request mobile OTP button',
        };
      }

      // 8a. Regular Aadhaar radio option
      if ((/\bregular\b/i.test(hint) || /regular\s*aadhaar/i.test(hint)) && !/masked/i.test(hint) && (el.tagName === 'input' || el.tagName === 'label' || el.tagName === 'span' || el.tagName === 'div' || el.role === 'radio')) {
        return {
          ...el,
          label: 'Regular Aadhaar Option',
          ariaLabel: 'Regular Aadhaar Option',
          role: 'Regular Aadhaar radio option',
        };
      }

      // 8b. Masked Aadhaar radio / checkbox
      if ((/\bmasked\b/i.test(hint) || /masked\s*aadhaar/i.test(hint)) && !/regular/i.test(hint) && !/what is masked/i.test(hint) && (el.tagName === 'input' || el.tagName === 'label' || el.tagName === 'span' || el.tagName === 'div' || el.role === 'radio' || el.role === 'checkbox')) {
        return {
          ...el,
          label: 'Masked Aadhaar Option',
          ariaLabel: 'Masked Aadhaar Option',
          role: 'Masked Aadhaar radio option',
        };
      }

      // 9. OTP input field (including 1-digit digit inputs in OTP modal)
      if (
        ((/enter\s*otp|mobile\s*otp|\botp\b|verification\s*code/i.test(hint)) || (el.tagName === 'input' && (el.attributes?.['maxlength'] === '1' || el.attributes?.['maxlength'] === '6'))) &&
        el.tagName === 'input' &&
        !hint.includes('get otp') &&
        !hint.includes('send otp') &&
        !hint.includes('request otp')
      ) {
        return {
          ...el,
          label: 'Enter Mobile OTP',
          ariaLabel: 'Enter Mobile OTP',
          role: 'Mobile OTP sensitive input',
          sensitive: true,
          sensitivityType: 'password',
        };
      }

      // 10. "Verify & Download" button
      if (/verify\s*&\s*download|verify\s*and\s*download/i.test(hint) || (hint.includes('verify') && hint.includes('download'))) {
        return {
          ...el,
          label: 'Verify & Download e-Aadhaar',
          ariaLabel: 'Verify & Download e-Aadhaar',
          role: 'Submit OTP and download e-Aadhaar PDF button',
        };
      }

      // 11. Close OTP Dialog button (✕ / Close / Dismiss)
      if (
        (/\bclose\b|\bdismiss\b/i.test(hint) || el.text === '✕' || el.text === '×' || el.text === 'X' || el.label === '✕' || el.label === '×' || hint.includes('close dialog')) &&
        (el.tagName === 'button' || el.tagName === 'span' || el.tagName === 'div' || el.tagName === 'a') &&
        !hint.includes('download') && !hint.includes('verify')
      ) {
        return {
          ...el,
          label: 'Close OTP Dialog',
          ariaLabel: 'Close OTP Dialog',
          role: 'Close dialog (✕) - DO NOT CLICK TO SUBMIT',
        };
      }

      return el;
    });
  }

  detectPageType(url: string, context?: PageContext): string {
    const u = url.toLowerCase();
    if (u.includes('genericdownloadaadhaar') || u.includes('gen-ae-aadhaar')) {
      return 'download_aadhaar_page';
    }
    if (u.includes('myaadhaar')) {
      return 'myaadhaar_home';
    }
    return 'generic';
  }

  getWorkflowGuidance(workflow: string, context?: PageContext): string | null {
    return (
      'UIDAI MYAADHAAR SECURITY & PRIVACY PROTOCOL:\n' +
      '1. On the MyAadhaar home page: Locate and click "Download Aadhaar Service".\n' +
      '2. On the Download Aadhaar page:\n' +
      '   - The user must provide their 12-digit Aadhaar number and solve the visual CAPTCHA.\n' +
      '   - UIDAI security requires CAPTCHA and OTP: NEVER attempt to bypass, OCR, or guess CAPTCHA or OTP.\n' +
      '   - When on this page and the fields are empty, call "ask_user" asking the user: "Please enter your 12-digit Aadhaar number and solve the CAPTCHA security code on the page, then click Request OTP."\n' +
      '   - All entered Aadhaar numbers and OTPs are masked 100% on-device and will NEVER be transmitted.\n' +
      '3. When the OTP input field appears:\n' +
      '   - Call "ask_user" with: "An OTP has been sent to your UIDAI-registered mobile. Please enter the OTP to continue."\n' +
      '   - Once the user enters the OTP, click "Verify & Download e-Aadhaar".\n' +
      '4. The downloaded e-Aadhaar PDF will be automatically detected and preserved locally in the downloads folder.\n'
    );
  }
}
