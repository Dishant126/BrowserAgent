/**
 * Adapter Registry — central registry of all supported site adapters.
 *
 * Supported sites:
 *   - Wikipedia        (en.wikipedia.org)  — full support
 *   - Yatra            (yatra.com)          — partial (flight/hotel/bus search)
 *   - MakeMyTrip       (makemytrip.com)     — partial (flight/hotel/holiday search)
 *   - ilovepdf         (ilovepdf.com)       — full (PDF tools)
 *   - IRCTC            (irctc.co.in)        — experimental (train search, PNR)
 *
 * The demo site (localhost) is always treated as fully supported.
 * If a domain is not in this list, return null (generic agent handles it).
 */

import type { SiteAdapter, SiteCapabilities } from './adapter-interface';
import type { SiteStatus, SiteCompatibility } from '../utils/types';
import { WikipediaAdapter } from './wikipedia-adapter';
import { YatraAdapter } from './yatra-adapter';
import { MakeMyTripAdapter } from './makemytrip-adapter';
import { IlovepdfAdapter } from './ilovepdf-adapter';
import { IrctcAdapter } from './irctc-adapter';
import { BooksToscrapeAdapter } from './books-toscrape-adapter';
import { QuotesToscrapeAdapter } from './quotes-toscrape-adapter';
import { UidaiAdapter } from './uidai-adapter';

// ── SUPPORTED SITES REGISTRY ─────────────────────────────────────────────────

const SUPPORTED_ADAPTERS: SiteAdapter[] = [
  new WikipediaAdapter(),
  new YatraAdapter(),
  new MakeMyTripAdapter(),
  new IlovepdfAdapter(),
  new IrctcAdapter(),
  new BooksToscrapeAdapter(),
  new QuotesToscrapeAdapter(),
  new UidaiAdapter(),
];

// Demo / benchmark site treated as fully supported
const DEMO_DOMAINS = new Set(['localhost', '127.0.0.1']);

/** Resolve the adapter for a given URL. Returns null if unsupported. */
export function getAdapter(url: string): SiteAdapter | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Always support demo site
    if (DEMO_DOMAINS.has(hostname)) return null; // Demo uses generic agent directly
    return SUPPORTED_ADAPTERS.find(a => a.matches(url)) ?? null;
  } catch {
    return null;
  }
}

/** Returns the site compatibility status for popup display. */
export function getSiteStatus(url: string): SiteStatus {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, '');

    // Demo/localhost — always full support (benchmark mode)
    if (DEMO_DOMAINS.has(domain)) {
      return {
        url,
        domain,
        compatibility: 'full',
        adapterName: 'Demo Benchmark',
        workflows: ['search', 'form_completion', 'navigation', 'pii_detection'],
      };
    }

    const adapter = SUPPORTED_ADAPTERS.find(a => a.matches(url));
    if (adapter) {
      return {
        url,
        domain,
        compatibility: adapter.supportLevel,
        adapterName: adapter.name,
        workflows: adapter.workflows,
      };
    }

    // Not in supported list — generic agent still works, just no site-specific hints
    return {
      url,
      domain,
      compatibility: 'unsupported',
    };
  } catch {
    return { url, domain: '', compatibility: 'unsupported' };
  }
}

/** Human-readable description of site compatibility for popup. */
export function getSiteCompatibilityLabel(compatibility: SiteCompatibility): {
  icon: string;
  label: string;
  color: string;
} {
  switch (compatibility) {
    case 'full':
      return { icon: '✓', label: 'SUPPORTED WEBSITE', color: '#10b981' };
    case 'partial':
      return { icon: '△', label: 'PARTIAL SUPPORT', color: '#f59e0b' };
    case 'experimental':
      return { icon: '⚗', label: 'EXPERIMENTAL', color: '#a78bfa' };
    case 'unsupported':
      return { icon: '○', label: 'UNSUPPORTED', color: '#64748b' };
  }
}

/** Returns all registered adapters for display in settings / UI. */
export function getAllAdapters(): SiteAdapter[] {
  return [...SUPPORTED_ADAPTERS];
}

/** Check if a URL is in the demo / benchmark mode. */
export function isDemoBenchmarkUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return DEMO_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}
