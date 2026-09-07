/**
 * Face Detector — High-speed on-device face & visual PII detector.
 *
 * Combines:
 * 1. Pixel-level skin chrominance and facial geometry analysis via Vision Model Engine
 * 2. Visual scan of DOM elements (profile photos, user avatars, face-tagged elements, ID badges)
 * 3. Extracts exact client bounding boxes in page coordinate space for redaction overlay and canvas blurring.
 *
 * All inference and detection happens 100% locally on-device.
 */

import type { BoundingBox } from '../utils/types';
import { evaluateScreenState } from './vision-model';

export interface FaceDetection {
  bbox: BoundingBox;
  confidence: number;
  source: 'heuristic' | 'vision_model';
  domElement?: HTMLElement;
  isFixed?: boolean;
}

export function isElementFixedOrSticky(el: Element | null): boolean {
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    try {
      const style = window.getComputedStyle(cur);
      const pos = style.position;
      if (pos === 'fixed' || pos === 'sticky' || pos === '-webkit-sticky') return true;
    } catch {}
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Detect faces, avatar regions, and visual ID photos on the current page.
 */
export async function detectFaces(screenCanvas?: HTMLCanvasElement, devicePixelRatio = 1): Promise<FaceDetection[]> {
  const results: FaceDetection[] = [];

  // Anchor placeholders to avoid matching legitimate styles like 'color-bg-default'
  const GENERIC_PLACEHOLDER_REGEX = /\b(?:default[-_]avatar|avatar[-_]default|default[-_]photo|default[-_]image|no[-_]avatar|no[-_]photo|no[-_]image|user[-_]silhouette|user[-_]placeholder|profile[-_]placeholder|placeholder[-_]avatar|anonymous[-_]user|guest[-_]avatar|avatar_placeholder)\b|silhouette|anonymous\.svg|placeholder\.svg|nobody\.png|\buser\.(?:png|svg|jpg|webp)|\bavatar\.(?:png|svg|jpg|webp)|\bdefault\.(?:png|svg|jpg|webp)/i;

  // Patterns for tech stacks, programming languages, skill icons, badges that must NEVER be masked as faces
  const TECH_OR_BADGE_REGEX = /devicon|devicons|shields\.io|badge|cdn\.jsdelivr\.net|fontawesome|iconify|skill-icons|github-readme-stats|simple-icons|\/icons\/|\/logos\/|\/skills\/|\/tech\/|react|express|nodejs|mongodb|javascript|typescript|python|c\+\+|html5|css3/i;

  try {
    // ── 1. DOM Pattern 1: Elements with explicit avatar attributes or class names (Run FIRST) ──
    const photoElements = document.querySelectorAll<HTMLElement>(
      '[data-pii-type="face"], .profile-photo, .user-avatar, .avatar, [class*="avatar"], [class*="profile-img"], [class*="user-photo"], [itemprop="image"], .vcard-avatar img, img[src*="avatars.githubusercontent.com"], img[alt*="photo" i], img[alt*="avatar" i], img[alt*="profile" i], img[alt*="headshot" i]'
    );

    photoElements.forEach(el => {
      const isExplicitFace = el.getAttribute('data-pii-type') === 'face';

      // Skip pure SVG or font glyphs
      if (!isExplicitFace) {
        if (el.closest('svg, i') || ['SVG', 'PATH', 'I'].includes(el.tagName)) return;
        if (el.querySelector('svg') && !el.querySelector('img')) return;
      }

      let targetEl: HTMLElement = el;
      const childImg = el.querySelector<HTMLImageElement>('img');
      if (childImg) {
        targetEl = childImg;
      } else if (!isExplicitFace) {
        const isImage = ['IMG', 'PICTURE'].includes(el.tagName);
        if (!isImage) return;
      }

      if (!isExplicitFace && targetEl instanceof HTMLImageElement) {
        const src = (targetEl.src || '').toLowerCase();
        const alt = (targetEl.alt || '').toLowerCase();
        const cls = (targetEl.className || '').toLowerCase();
        const combined = `${src} ${alt} ${cls}`;

        // Never mask tech or skill icons
        if (TECH_OR_BADGE_REGEX.test(combined)) {
          return;
        }

        // Check if target image is a generic placeholder avatar
        if (src.includes('.svg') || src.startsWith('data:image/svg') || GENERIC_PLACEHOLDER_REGEX.test(combined)) {
          return;
        }
      }

      const rect = targetEl.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16 || rect.width > 350 || rect.height > 350) return; // Must be valid avatar dimensions

      // Avatars and portraits aspect ratio
      const aspect = rect.width / rect.height;
      if (aspect < 0.35 || aspect > 2.8) return;

      const bbox: BoundingBox = {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };

      // Deduplicate overlapping bboxes
      const alreadyExists = results.some(r => {
        const xOverlap = Math.max(0, Math.min(r.bbox.x + r.bbox.width, bbox.x + bbox.width) - Math.max(r.bbox.x, bbox.x));
        const yOverlap = Math.max(0, Math.min(r.bbox.y + r.bbox.height, bbox.y + bbox.height) - Math.max(r.bbox.y, bbox.y));
        const overlapArea = xOverlap * yOverlap;
        const minArea = Math.min(r.bbox.width * r.bbox.height, bbox.width * bbox.height);
        return minArea > 0 && overlapArea / minArea > 0.25;
      });

      if (!alreadyExists) {
        results.push({
          bbox,
          confidence: 0.98,
          source: 'heuristic',
          domElement: targetEl,
          isFixed: isElementFixedOrSticky(targetEl),
        });
      }
    });

    // ── 2. DOM Pattern 2: Scan all visible images for personal photo signatures ──
    document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24 || rect.width > 350 || rect.height > 350) return; // Skip small icons or large banners

      const src = (img.src || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();
      const cls = (img.className || '').toLowerCase();

      // Immediately reject tech logos, language icons, and badges
      if (TECH_OR_BADGE_REGEX.test(`${src} ${alt} ${cls}`)) {
        return;
      }

      // Check if image is an avatar on known platforms (e.g. GitHub avatars CDN)
      const isKnownAvatarUrl = /avatars\.githubusercontent\.com\/u\/|\/avatars\/|\/profile_images\//i.test(src);

      // Strip domain to prevent raw.githubusercontent.com from falsely matching /user/
      let srcPath = src;
      try {
        const u = new URL(src, window.location.href);
        srcPath = u.pathname;
      } catch {}

      const combined = `${srcPath} ${alt} ${cls}`;

      // Skip generic placeholder silhouettes and default icons
      if (src.includes('.svg') || src.startsWith('data:image/svg') || GENERIC_PLACEHOLDER_REGEX.test(combined)) {
        return;
      }

      if (isKnownAvatarUrl || /avatar|profile|portrait|author|selfie|passport|headshot|person|\/u\/\d+/.test(combined)) {
        const aspect = rect.width / rect.height;
        if (aspect < 0.35 || aspect > 2.8) return;

        const bbox: BoundingBox = {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };

        const alreadyExists = results.some(r => {
          const xOverlap = Math.max(0, Math.min(r.bbox.x + r.bbox.width, bbox.x + bbox.width) - Math.max(r.bbox.x, bbox.x));
          const yOverlap = Math.max(0, Math.min(r.bbox.y + r.bbox.height, bbox.y + bbox.height) - Math.max(r.bbox.y, bbox.y));
          const overlapArea = xOverlap * yOverlap;
          const minArea = Math.min(r.bbox.width * r.bbox.height, bbox.width * bbox.height);
          return minArea > 0 && overlapArea / minArea > 0.25;
        });

        if (!alreadyExists) {
          results.push({
            bbox,
            confidence: isKnownAvatarUrl ? 0.98 : 0.90,
            source: 'heuristic',
            domElement: img,
            isFixed: isElementFixedOrSticky(img),
          });
        }
      }
    });

    // ── 3. Pixel Vision Model (Fallback only for uncatalogued photos) ──
    if (screenCanvas) {
      try {
        const dpr = devicePixelRatio > 0 ? devicePixelRatio : (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
        const evalResult = await evaluateScreenState(screenCanvas, window.scrollX, window.scrollY, dpr);
        for (const reg of evalResult.sensitiveRegions) {
          if (reg.type === 'face') {
            if (reg.bbox.width > 350 || reg.bbox.height > 350 || reg.bbox.width < 24 || reg.bbox.height < 24) {
              continue; // Reject anomalous or noisy regions
            }

            // If region overlaps with ANY already-detected avatar, skip it (the whole avatar is already protected)
            const coveredByAvatar = results.some(r => {
              const xOverlap = Math.max(0, Math.min(r.bbox.x + r.bbox.width, reg.bbox.x + reg.bbox.width) - Math.max(r.bbox.x, reg.bbox.x));
              const yOverlap = Math.max(0, Math.min(r.bbox.y + r.bbox.height, reg.bbox.y + reg.bbox.height) - Math.max(r.bbox.y, reg.bbox.y));
              const overlapArea = xOverlap * yOverlap;
              const regArea = reg.bbox.width * reg.bbox.height;
              return regArea > 0 && overlapArea / regArea > 0.2;
            });
            if (coveredByAvatar) continue;

            const centerX = Math.round(reg.bbox.x - window.scrollX + reg.bbox.width / 2);
            const centerY = Math.round(reg.bbox.y - window.scrollY + reg.bbox.height / 2);
            if (centerX < 0 || centerX > window.innerWidth || centerY < 0 || centerY > window.innerHeight) {
              continue;
            }

            const elAtPoint = document.elementFromPoint(centerX, centerY);
            if (!elAtPoint) continue;

            const img = elAtPoint instanceof HTMLImageElement ? elAtPoint : elAtPoint.querySelector('img');
            const hasAvatarClass = /avatar|profile[-_]photo|user[-_]photo|headshot/i.test(`${elAtPoint.className || ''} ${elAtPoint.id || ''}`);

            // MUST be inside an actual image or avatar element — never mask empty CSS background or text
            if (!img && !hasAvatarClass) {
              continue;
            }

            const targetImg = img || elAtPoint;
            const imgRect = targetImg.getBoundingClientRect();
            if (imgRect.width > 350 || imgRect.height > 350) continue;

            // Expand detection to cover the full target image element cleanly rather than a tiny patch
            const fullBbox: BoundingBox = {
              x: Math.round(imgRect.left + window.scrollX),
              y: Math.round(imgRect.top + window.scrollY),
              width: Math.round(imgRect.width),
              height: Math.round(imgRect.height),
            };

            const duplicate = results.some(r => {
              const xO = Math.max(0, Math.min(r.bbox.x + r.bbox.width, fullBbox.x + fullBbox.width) - Math.max(r.bbox.x, fullBbox.x));
              const yO = Math.max(0, Math.min(r.bbox.y + r.bbox.height, fullBbox.y + fullBbox.height) - Math.max(r.bbox.y, fullBbox.y));
              return (xO * yO) / (fullBbox.width * fullBbox.height) > 0.25;
            });
            if (duplicate) continue;

            results.push({
              bbox: fullBbox,
              confidence: reg.confidence,
              source: 'vision_model',
              domElement: targetImg as HTMLElement,
              isFixed: isElementFixedOrSticky(targetImg),
            });
          }
        }
      } catch (visErr) {
        console.warn('[FaceDetector] Pixel vision model warning:', visErr);
      }
    }
  } catch (err) {
    console.warn('[FaceDetector] Face detection warning:', err);
  }

  return results;
}

/** Detect <img> elements that likely contain personal or sensitive identification */
export function detectSensitiveImages(): Array<{ el: HTMLImageElement; bbox: BoundingBox }> {
  const results: Array<{ el: HTMLImageElement; bbox: BoundingBox }> = [];
  try {
    document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) return;
      const hint = `${img.src} ${img.alt} ${img.className}`.toLowerCase();
      if (/photo|avatar|profile|face|person|signature|id.card|aadhaar|pan|passport/.test(hint)) {
        results.push({
          el: img,
          bbox: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    });
  } catch (err) {
    console.warn('[FaceDetector] Image scan warning:', err);
  }
  return results;
}
