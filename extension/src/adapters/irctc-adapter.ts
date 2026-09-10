/**
 * IRCTC Site Adapter — irctc.co.in
 *
 * Supported workflows:
 *   - train_search:  Fill source/destination station, pick date, search trains
 *   - train_booking: Select train & class, click Book Now, handle login & passenger form with HITL
 *   - pnr_status:    Enter PNR number, check train status
 *
 * Key characteristics:
 *   - Angular application with PrimeNG components (p-autocomplete, p-calendar)
 *   - Station search uses autocomplete dropdown (type station -> pick suggestion item)
 *   - Login is required for booking -> engages Human-in-the-Loop with 100% on-device PII masking
 *   - Financial safety: stopBeforePayment = true (strictly stops before payment gateway)
 */

import { BaseSiteAdapter, type SiteCapabilities, type PageContext } from './adapter-interface';
import type { UIElement, BrowserAction } from '../utils/types';

export class IrctcAdapter extends BaseSiteAdapter {
  readonly name = 'IRCTC';
  readonly domains = ['irctc.co.in', 'www.irctc.co.in'];
  readonly urlPatterns = [/https?:\/\/(?:www\.)?irctc\.co\.in/];
  readonly supportLevel = 'experimental' as const;
  readonly workflows = ['train_search', 'train_booking', 'pnr_status'];

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
        el.domSelector, el.attributes?.['id'], el.attributes?.['name'],
        el.attributes?.['formcontrolname'], el.attributes?.['class'],
      ].join(' ').toLowerCase();

      // Disclaimer / Kavach / Alert dialog OK button
      if (el.tagName === 'button' && (hint.includes('ui-dialog') || hint.includes('btn-primary')) && /^(ok|dismiss|close|i agree)\b/i.test(el.text || el.label || '')) {
        return { ...el, label: 'Dismiss Alert (OK)', role: 'Dismiss disclaimer alert button' };
      }

      // Autocomplete suggestion item in station dropdown
      if ((el.tagName === 'li' || el.role === 'option' || hint.includes('ui-autocomplete-list-item') || hint.includes('ui-autocomplete-items')) && el.text) {
        return {
          ...el,
          label: `Station Option: ${el.text.trim()}`,
          ariaLabel: `Station Option: ${el.text.trim()}`,
          role: 'Station autocomplete dropdown suggestion item',
        };
      }

      // Source / From station input
      if (/from.station|origin|source.station|\bfrom\b/.test(hint) && el.tagName === 'input') {
        return { ...el, label: 'From Station', ariaLabel: 'From Station', role: 'Origin station search input' };
      }

      // Destination / To station input
      if (/to.station|destination.station|\bto\b|dest/.test(hint) && el.tagName === 'input') {
        return { ...el, label: 'To Station', ariaLabel: 'To Station', role: 'Destination station search input' };
      }

      // Journey date input / picker
      if (/journey.date|travel.date|date.of.journey|depart|ui-calendar/.test(hint)) {
        return { ...el, label: 'Journey Date', ariaLabel: 'Journey Date', role: 'Journey date picker' };
      }

      // Search Trains button
      if (el.tagName === 'button' && /search.train|find.train|train_search|search/.test(hint)) {
        return { ...el, label: 'Search Trains', ariaLabel: 'Search Trains', role: 'Search trains button' };
      }

      // Train list: Class selector tabs (Sleeper SL, 3A, 2A, 1A, etc.)
      if (/sleeper|\b(sl|3a|2a|1a|cc|2s|3e)\b/i.test(hint) && (el.tagName === 'div' || el.tagName === 'button' || el.tagName === 'span' || el.tagName === 'a')) {
        const classMatch = (el.text || hint).match(/Sleeper\s*\(SL\)|AC\s*3\s*Tier|AC\s*2\s*Tier|AC\s*First|Second\s*Sitting|\b(?:SL|3A|2A|1A|CC|2S|3E)\b/i);
        const className = classMatch ? classMatch[0] : (el.text || 'Class Tab');
        return {
          ...el,
          label: `Select Class: ${className}`,
          ariaLabel: `Select Class: ${className}`,
          role: `Travel class selector tab for ${className}`,
        };
      }

      // Train list: Availability box (e.g. Sat 12 Sep WL27 / AVAILABLE)
      if (hint.includes('avail-box') || hint.includes('pre-avail-box') || /wl\d+|avail|rac\d+/i.test(el.text || '')) {
        return {
          ...el,
          label: `Check Availability: ${el.text?.slice(0, 30) || 'Date Option'}`,
          role: 'Check train availability date box',
        };
      }

      // Book Now button on train list
      if ((el.tagName === 'button' || el.tagName === 'a') && /book.now|proceed.to.book/i.test(hint)) {
        return {
          ...el,
          label: 'Book Now',
          ariaLabel: 'Book Now',
          role: 'Train Book Now button',
        };
      }

      // IRCTC Login Dialog: Username
      if (/user.name|userid|user_id|username/i.test(hint) && el.tagName === 'input') {
        return {
          ...el,
          label: 'IRCTC User ID',
          ariaLabel: 'IRCTC User ID',
          role: 'IRCTC login username input',
        };
      }

      // IRCTC Login Dialog: Password
      if (/password|pwd/i.test(hint) && el.tagName === 'input') {
        return {
          ...el,
          label: 'IRCTC Password',
          ariaLabel: 'IRCTC Password',
          role: 'IRCTC login password input',
          sensitive: true,
          sensitivityType: 'password',
        };
      }

      // IRCTC Login Dialog: Captcha
      if (/captcha|nlpanswer/i.test(hint) && el.tagName === 'input') {
        return {
          ...el,
          label: 'IRCTC Captcha',
          ariaLabel: 'IRCTC Captcha',
          role: 'IRCTC login captcha input',
        };
      }

      // IRCTC Login Dialog: Sign In button
      if (el.tagName === 'button' && /sign.in|login/i.test(hint)) {
        return {
          ...el,
          label: 'Sign In',
          ariaLabel: 'Sign In',
          role: 'IRCTC login submit button',
        };
      }

      // Passenger Details: Name
      if (/passenger.name|traveller.name/i.test(hint) && el.tagName === 'input') {
        return {
          ...el,
          label: 'Passenger Name',
          role: 'Passenger name input',
          sensitive: true,
          sensitivityType: 'name',
        };
      }

      // Passenger Details: Age
      if (/passenger.age|age\b/i.test(hint) && el.tagName === 'input') {
        return { ...el, label: 'Passenger Age', role: 'Passenger age input' };
      }

      // PNR Number input
      if (/pnr/.test(hint) && el.tagName === 'input') {
        return { ...el, label: 'PNR Number', ariaLabel: 'PNR Number', role: 'PNR number input' };
      }

      // Get PNR Status button
      if (el.tagName === 'button' && /pnr.status|get.status|check.pnr/.test(hint)) {
        return { ...el, label: 'Get PNR Status', ariaLabel: 'Check PNR Status', role: 'PNR status button' };
      }

      // Quota / class selector
      if (/quota|class|travel.class/.test(hint) && (el.tagName === 'select' || el.role === 'combobox')) {
        return { ...el, label: 'Travel Class/Quota', role: 'Travel class or quota selector' };
      }

      return el;
    });
  }

  enrichPageContext(ctx: PageContext): PageContext {
    const url = ctx.url.toLowerCase();
    let hint = '';

    if (url.includes('pnr') || url.includes('status')) {
      hint = '[IRCTC PNR STATUS] Enter your 10-digit PNR number in the PNR input field and click "Get PNR Status". No login required.';
    } else if (url.includes('train-list') || url.includes('booking')) {
      hint = '[IRCTC TRAIN LIST] Results are loaded! Steps:\n' +
        '1. Find the requested or best train card (e.g. Netaji Express, Mahananda Exp, etc.).\n' +
        '2. Click on the desired class tab (e.g. "Select Class: Sleeper (SL)" or "AC 3 Tier (3A)").\n' +
        '3. Click the date availability box if required to refresh seats.\n' +
        '4. Click the orange "Book Now" button for that train.\n' +
        '5. If the IRCTC login modal appears, request the user to enter credentials and solve CAPTCHA via ask_user.\n' +
        '   ALL passwords and usernames are strictly masked locally before sending DOM/screenshots to AI.\n' +
        '6. STOP before payment gateway — financial safety requires human authorization.';
    } else {
      hint = '[IRCTC TRAIN SEARCH] Steps:\n' +
        '1. If an initial alert/disclaimer popup appears (e.g. Kavach or COVID), click "Dismiss Alert (OK)".\n' +
        '2. Fill "From Station" input (type station name, e.g. "NEW DELHI").\n' +
        '3. CRITICAL: In the next step, click the matching autocomplete suggestion item from the dropdown (e.g. "Station Option: NEW DELHI - NDLS").\n' +
        '4. Fill "To Station" input (type destination, e.g. "FIROZABAD").\n' +
        '5. Click the matching autocomplete suggestion item from the dropdown (e.g. "Station Option: FIROZABAD - FZD").\n' +
        '6. Fill Journey Date (format DD/MM/YYYY, e.g. 08/09/2026).\n' +
        '7. Click "Search Trains" button to load train availability results.';
    }

    return {
      ...ctx,
      visibleText: `${hint}\n\n${ctx.visibleText}`,
    };
  }

  validateAction(action: BrowserAction): string | null {
    // Strictly guard financial transactions: stop before final bank payment / gateway execution
    if (action.action === 'click' && action.target?.value) {
      const v = action.target.value.toLowerCase();
      if (/pay.and.book|make.payment|confirm.payment|submit.payment\b/.test(v)) {
        return 'IRCTC adapter: stopped before payment gateway — financial payment requires explicit human authorization.';
      }
    }
    // Block payment gateway redirect URLs
    if (action.action === 'navigate' && action.url) {
      if (/paymentgateway|payu|razorpay|billdesk|hdfcbank|sbi\.co\.in\/epay/i.test(action.url)) {
        return 'IRCTC adapter: stopped before external payment gateway.';
      }
    }
    return null;
  }

  describePageForLLM(ctx: PageContext): string {
    return `IRCTC (Indian Railways) — Autonomous train search & booking adapter with Human-in-the-Loop.\n` +
      `GUIDELINES:\n` +
      `- After typing into "From Station" or "To Station", always click the matching "Station Option" item from the suggestion list.\n` +
      `- On the train list page, click the requested travel class (SL, 3A, 2A, 1A) and click "Book Now".\n` +
      `- When the login dialog opens, use ask_user to prompt the user for authentication / CAPTCHA (all sensitive fields are masked on-device).\n` +
      `- Never submit automated payments without human confirmation.`;
  }
}
