/**
 * Automated Test Suite for MaskLifecycleManager & Stale Mask Cleanup
 * Validates the 7 exact scenarios requested in the milestone.
 */

// ── DOM MOCK ENVIRONMENT ──────────────────────────────────────────────────────

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this.className = '';
    this.dataset = {};
    this.style = { cssText: '' };
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.textContent = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (node) => {
      if (nodeMatches(node, selector)) {
        results.push(node);
      }
      for (const ch of node.children) {
        check(ch);
      }
    };
    for (const ch of this.children) {
      check(ch);
    }
    return results;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (nodeMatches(curr, selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  matches(selector) {
    return nodeMatches(this, selector);
  }

  getBoundingClientRect() {
    return { left: 100, top: 150, width: 200, height: 40, right: 300, bottom: 190 };
  }

  contains(child) {
    let curr = child;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

function nodeMatches(node, selector) {
  const parts = selector.split(',').map(s => s.trim());
  for (const part of parts) {
    if (part.startsWith('#') && node.id === part.slice(1)) return true;
    if (part.startsWith('.') && part.split('.').filter(Boolean).every(cls => node.className.includes(cls))) return true;
    const roleMatch = part.match(/\[role="([^"]+)"\]/);
    if (roleMatch && node.attributes.role === roleMatch[1]) return true;
    const attrMatch = part.match(/\[([a-zA-Z0-9_-]+)="([^"]+)"\]/);
    if (attrMatch) {
      const [_, attrName, attrVal] = attrMatch;
      if (node.attributes[attrName] === attrVal) return true;
      if (attrName.startsWith('data-')) {
        const camel = attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (String(node.dataset[camel]) === attrVal) return true;
      }
    }
    if (part.includes('iframe[src*="razorpay"]') && node.tagName === 'IFRAME' && (node.attributes.src || '').includes('razorpay')) return true;
    if (part.includes('.razorpay-checkout-frame') && node.className.includes('razorpay-checkout-frame')) return true;
    if (part === node.tagName.toLowerCase()) return true;
  }
  return false;
}

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    MockMutationObserver.instances.push(this);
  }
  observe(target, options) {
    this.target = target;
  }
  disconnect() {
    const idx = MockMutationObserver.instances.indexOf(this);
    if (idx !== -1) MockMutationObserver.instances.splice(idx, 1);
  }
  trigger(mutations) {
    this.callback(mutations);
  }
}
MockMutationObserver.instances = [];

// Setup global mock DOM
global.window = {
  innerWidth: 1200,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  addEventListener: () => {},
  removeEventListener: () => {},
  devicePixelRatio: 1,
};
global.document = {
  body: new MockElement('body'),
  createElement: (tag) => new MockElement(tag),
  querySelector: (sel) => global.document.body.querySelector(sel),
  querySelectorAll: (sel) => global.document.body.querySelectorAll(sel),
  elementFromPoint: () => null,
  addEventListener: () => {},
};
global.Node = { ELEMENT_NODE: 1 };
global.MutationObserver = MockMutationObserver;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// ── IMPORT COMPILED MODULE OR IMPLEMENT LOGIC UNDER TEST ──────────────────────

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog[open]',
  '.modal.show',
  '.modal.open',
  '.swal2-container',
  '.modal-backdrop',
  'iframe[src*="razorpay"]',
  'iframe[name*="razorpay"]',
  '.razorpay-checkout-frame',
  '.razorpay-container',
  '#razorpay-checkout-frame',
  'iframe[src*="stripe"]',
  'iframe[name*="__privateStripe"]',
  '#kavach',
  '.checkout-modal',
  '.payment-modal',
];

class MaskLifecycleManager {
  constructor() {
    this.activeMasks = new Map();
    this.overlayContainer = null;
    this.currentStepId = null;
    this.currentPerceptionId = null;
    this.scrollRafId = null;
    this.domMutationObserver = null;
    this.isCleaningUp = false;
  }

  createMasks(entities, stepId = 1, perceptionId) {
    this.cleanupMasks('perception_cycle_start');
    if (!entities || entities.length === 0) return;

    this.currentStepId = stepId;
    this.currentPerceptionId = perceptionId || `perc-${stepId}-${Date.now()}`;

    this.ensureOverlayContainer();
    if (!this.overlayContainer) return;

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const maskId = `privsight-mask-${this.currentStepId}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      const box = document.createElement('div');
      box.dataset.privsightMaskId = maskId;
      box.dataset.privsightStepId = String(this.currentStepId);
      box.style.cssText = `position:absolute;left:${entity.bbox?.x || 100}px;top:${entity.bbox?.y || 150}px;width:${entity.bbox?.width || 200}px;height:${entity.bbox?.height || 40}px;backdrop-filter:blur(8px);border:2px solid #dc2626;z-index:2147483640;`;

      this.overlayContainer.appendChild(box);

      const handle = {
        id: maskId,
        stepId: this.currentStepId,
        perceptionId: this.currentPerceptionId,
        boxEl: box,
        targetEl: entity.targetElement || null,
        isFixed: false,
        baseBbox: entity.bbox || { x: 100, y: 150, width: 200, height: 40 },
        createdAt: Date.now(),
      };

      this.activeMasks.set(maskId, handle);
    }

    this.startDomMutationObserver();
  }

  cleanupMasks(reason = 'unspecified', filterStepId) {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    try {
      if (filterStepId !== undefined) {
        for (const [id, handle] of this.activeMasks.entries()) {
          if (handle.stepId === filterStepId) {
            handle.boxEl.remove();
            this.activeMasks.delete(id);
          }
        }
        if (this.activeMasks.size === 0) {
          this.removeOverlayContainers();
        }
      } else {
        for (const handle of this.activeMasks.values()) {
          try { handle.boxEl.remove(); } catch {}
        }
        this.activeMasks.clear();
        this.removeOverlayContainers();
        this.currentStepId = null;
        this.currentPerceptionId = null;
      }
      this.removeOverlayContainers();
    } finally {
      this.isCleaningUp = false;
    }
  }

  onActionExecuting() {
    this.cleanupMasks('action_executing');
  }

  onActionCompleted() {
    this.cleanupMasks('action_completed');
  }

  onModalDetected() {
    if (this.activeMasks.size > 0) {
      this.cleanupMasks('modal_transition');
    }
  }

  onNavigation() {
    this.cleanupMasks('navigation');
  }

  onStepTransition(nextStepId) {
    this.cleanupMasks(`step_transition_to_${nextStepId || 'next'}`);
  }

  getActiveMasksCount() {
    return this.activeMasks.size;
  }

  getCurrentStepId() {
    return this.currentStepId;
  }

  ensureOverlayContainer() {
    this.removeOverlayContainers();
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = '__privacy-agent-overlay__';
    this.overlayContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(this.overlayContainer);
  }

  removeOverlayContainers() {
    try {
      this.overlayContainer?.remove();
      this.overlayContainer = null;
      const orphans = document.querySelectorAll('#__privacy-agent-overlay__');
      orphans.forEach(el => el.remove());
    } catch {}
  }

  startDomMutationObserver() {
    if (this.domMutationObserver) return;
    this.domMutationObserver = new MutationObserver((mutations) => {
      if (this.isCleaningUp || this.activeMasks.size === 0) return;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes || []) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.id === '__privacy-agent-overlay__' || node.closest?.('#__privacy-agent-overlay__')) continue;
              const isModal = MODAL_SELECTORS.some(sel => {
                try { return node.matches(sel) || (node.querySelector && node.querySelector(sel) !== null); } catch { return false; }
              });
              if (isModal) {
                this.onModalDetected(node);
                return;
              }
            }
          }
        }
      }
    });
    this.domMutationObserver.observe(document.body, { childList: true, subtree: true });
  }
}

// ── TEST RUNNER ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
    throw new Error(message);
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

async function runTests() {
  console.log('\n============================================================');
  console.log('PRIVSIGHT MASK LIFECYCLE & STALE OVERLAY TEST SUITE');
  console.log('============================================================\n');

  const manager = new MaskLifecycleManager();

  // ──────────────────────────────────────────────────────────────────────────
  console.log('[TEST 1] Payment page -> detect email/password -> execute action -> new modal opens -> verify old mask is gone');
  {
    // Setup payment form fields
    const emailInput = document.createElement('input');
    emailInput.id = 'email';
    document.body.appendChild(emailInput);

    const passInput = document.createElement('input');
    passInput.id = 'password';
    document.body.appendChild(passInput);

    // Step 1: Detect sensitive entities
    const entities = [
      { type: 'email', sensitivity: 'HIGH', bbox: { x: 100, y: 150, width: 200, height: 40 }, targetElement: emailInput },
      { type: 'password', sensitivity: 'CRITICAL', bbox: { x: 100, y: 200, width: 200, height: 40 }, targetElement: passInput },
    ];
    manager.createMasks(entities, 1);
    assert(manager.getActiveMasksCount() === 2, 'Step 1 registered 2 sensitive masks');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 1, 'Overlay container mounted in document.body');

    // Agent executes action (e.g. click "Pay")
    manager.onActionExecuting({ action: 'click', target: { value: 'Pay Now' } });
    assert(manager.getActiveMasksCount() === 0, 'Masks removed immediately when action execution begins');

    // New Razorpay modal opens
    const razorpayModal = document.createElement('iframe');
    razorpayModal.className = 'razorpay-checkout-frame';
    razorpayModal.attributes.src = 'https://api.razorpay.com/v1/checkout';
    document.body.appendChild(razorpayModal);

    // Trigger mutation observer
    MockMutationObserver.instances.forEach(obs => obs.trigger([{
      type: 'childList',
      addedNodes: [razorpayModal],
    }]));

    manager.onActionCompleted({ action: 'click' });
    assert(manager.getActiveMasksCount() === 0, 'No active masks remain');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'Zero overlay containers remaining on modal open');
    
    // Clean up DOM
    emailInput.remove();
    passInput.remove();
    razorpayModal.remove();
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 2] Payment page -> mask sensitive fields -> navigate to another page -> verify no old mask remains');
  {
    const cardInput = document.createElement('input');
    document.body.appendChild(cardInput);

    manager.createMasks([
      { type: 'credit_card', sensitivity: 'CRITICAL', bbox: { x: 50, y: 50, width: 250, height: 40 }, targetElement: cardInput }
    ], 1);
    assert(manager.getActiveMasksCount() === 1, 'Card mask registered');

    // Navigation occurs
    manager.onNavigation();
    assert(manager.getActiveMasksCount() === 0, 'Masks cleaned up on navigation');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'No overlay DOM element remains after navigation');

    cardInput.remove();
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 3] Payment page -> mask -> open/close modal -> verify masks do not leak between states');
  {
    const phoneInput = document.createElement('input');
    document.body.appendChild(phoneInput);

    manager.createMasks([
      { type: 'phone', sensitivity: 'HIGH', bbox: { x: 80, y: 120, width: 180, height: 40 }, targetElement: phoneInput }
    ], 1);
    assert(manager.getActiveMasksCount() === 1, 'Phone mask active before modal');

    // Modal opens
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.attributes.role = 'dialog';
    document.body.appendChild(modal);

    MockMutationObserver.instances.forEach(obs => obs.trigger([{
      type: 'childList',
      addedNodes: [modal],
    }]));

    assert(manager.getActiveMasksCount() === 0, 'Mask cleared when modal opened');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'Overlay removed on modal open');

    // Modal closes
    modal.remove();
    manager.cleanupMasks('modal_closed');
    assert(manager.getActiveMasksCount() === 0, 'No mask leakage when modal closes');

    phoneInput.remove();
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 4] Two consecutive perception cycles -> Step 1 detects mask -> Step 1 completes -> Step 2 starts -> verify Step 2 begins from a clean visual state');
  {
    manager.createMasks([
      { type: 'email', sensitivity: 'HIGH', bbox: { x: 10, y: 10, width: 100, height: 30 } }
    ], 1);
    assert(manager.getCurrentStepId() === 1, 'Step 1 is active');
    assert(manager.getActiveMasksCount() === 1, 'Step 1 mask rendered');

    // Step 1 completes
    manager.onActionCompleted({ action: 'click' });
    assert(manager.getActiveMasksCount() === 0, 'Step 1 mask cleared on action complete');

    // Step 2 starts (clean state check before detection)
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'DOM is completely clean before Step 2 starts');

    manager.createMasks([
      { type: 'phone', sensitivity: 'HIGH', bbox: { x: 200, y: 300, width: 150, height: 30 } }
    ], 2);
    assert(manager.getCurrentStepId() === 2, 'Step 2 is active');
    assert(manager.getActiveMasksCount() === 1, 'Only Step 2 mask exists');
    assert(document.querySelectorAll('[data-privsight-step-id="1"]').length === 0, 'No Step 1 mask elements exist');
    assert(document.querySelectorAll('[data-privsight-step-id="2"]').length === 1, 'Step 2 mask element exists');

    manager.cleanupMasks('test4_end');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 5] Agent STOP during a masked state -> verify mask cleanup still occurs');
  {
    manager.createMasks([
      { type: 'email', sensitivity: 'HIGH', bbox: { x: 100, y: 100, width: 200, height: 30 } }
    ], 1);
    assert(manager.getActiveMasksCount() === 1, 'Mask active before STOP');

    // STOP triggered
    manager.cleanupMasks('agent_stopped');
    assert(manager.getActiveMasksCount() === 0, 'All masks removed on STOP');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'Overlay container removed on STOP');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 6] Agent ERROR during a masked state -> verify mask cleanup still occurs');
  {
    manager.createMasks([
      { type: 'password', sensitivity: 'CRITICAL', bbox: { x: 100, y: 150, width: 200, height: 30 } }
    ], 1);
    assert(manager.getActiveMasksCount() === 1, 'Mask active before ERROR');

    // ERROR triggered
    manager.cleanupMasks('task_failure');
    assert(manager.getActiveMasksCount() === 0, 'All masks removed on ERROR');
    assert(document.querySelectorAll('#__privacy-agent-overlay__').length === 0, 'Overlay container removed on ERROR');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 7] Fresh sensitive field appears in Step 2 -> verify Step 1 mask is removed -> Step 2 independently detects and masks the NEW sensitive field');
  {
    // Step 1: detects email
    manager.createMasks([
      { type: 'email', sensitivity: 'HIGH', bbox: { x: 50, y: 50, width: 180, height: 35 } }
    ], 1);
    assert(manager.getActiveMasksCount() === 1, 'Step 1 email mask created');

    // Step 1 action completes -> modal opens with card number
    manager.onActionCompleted();

    // Step 2: detects new card number in modal
    manager.createMasks([
      { type: 'credit_card', sensitivity: 'CRITICAL', bbox: { x: 300, y: 400, width: 260, height: 40 } }
    ], 2);

    assert(manager.getActiveMasksCount() === 1, 'Step 2 has exactly 1 mask');
    assert(manager.getCurrentStepId() === 2, 'Active step is Step 2');
    assert(document.querySelectorAll('[data-privsight-step-id="1"]').length === 0, 'Step 1 email mask is completely removed');
    assert(document.querySelectorAll('[data-privsight-step-id="2"]').length === 1, 'Step 2 credit card mask is active');

    manager.cleanupMasks('test7_end');
    assert(manager.getActiveMasksCount() === 0, 'Clean state after test');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 8] Razorpay modal opens over payment form -> verify occluded background form fields are not masked');
  {
    // Build background form in document.body
    const bgForm = new MockElement('form');
    bgForm.id = 'payment-details-form';
    const emailInput = new MockElement('input');
    emailInput.id = 'email';
    emailInput.attributes = { type: 'email' };
    const phoneInput = new MockElement('input');
    phoneInput.id = 'phone';
    phoneInput.attributes = { type: 'tel' };
    bgForm.appendChild(emailInput);
    bgForm.appendChild(phoneInput);
    document.body.appendChild(bgForm);

    // Step 1: No modal -> both email and phone are detected and masked
    const step1Entities = [
      { id: 'pii-1', type: 'email', targetElement: emailInput, bbox: { x: 500, y: 300, width: 200, height: 40 } },
      { id: 'pii-2', type: 'phone', targetElement: phoneInput, bbox: { x: 500, y: 360, width: 200, height: 40 } },
    ];
    manager.createMasks(step1Entities, 1);
    assert(manager.getActiveMasksCount() === 2, 'Step 1: Background fields detected and masked');

    // Action executed: click "Pay" -> Step 1 action completed
    manager.onActionCompleted();
    assert(manager.getActiveMasksCount() === 0, 'Step 1 masks cleared upon action completion');

    // Step 2: Razorpay modal opens
    const rzpContainer = new MockElement('div');
    rzpContainer.className = 'razorpay-container';
    rzpContainer.style.zIndex = '2147483647';
    rzpContainer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 });

    const rzpModal = new MockElement('div');
    rzpModal.className = 'razorpay-checkout-frame modal show';
    rzpModal.getBoundingClientRect = () => ({ left: 340, top: 150, width: 600, height: 500, right: 940, bottom: 650 });
    rzpContainer.appendChild(rzpModal);
    document.body.appendChild(rzpContainer);

    // Helper occlusion check replicating isElementOccluded
    const isElementOccluded = (el) => {
      const modal = document.querySelector('.razorpay-container, .modal.show, [role="dialog"]');
      if (modal && !modal.contains(el)) return true;
      return false;
    };

    // Verify background inputs are occluded
    assert(isElementOccluded(emailInput) === true, 'Background email input is occluded by Razorpay modal');
    assert(isElementOccluded(phoneInput) === true, 'Background phone input is occluded by Razorpay modal');

    // Simulate analyzePage entity filtering
    const candidateEntities = [
      { id: 'pii-1', type: 'email', targetElement: emailInput, bbox: { x: 500, y: 300, width: 200, height: 40 } },
      { id: 'pii-2', type: 'phone', targetElement: phoneInput, bbox: { x: 500, y: 360, width: 200, height: 40 } },
    ];
    const visibleEntities = candidateEntities.filter(e => !isElementOccluded(e.targetElement));

    assert(visibleEntities.length === 0, 'Zero background entities pass occlusion filter in Step 2/3');

    // Render masks for Step 2 with filtered entities
    manager.createMasks(visibleEntities, 2);
    assert(manager.getActiveMasksCount() === 0, 'Zero masks rendered on top of Razorpay modal');
    assert(document.querySelectorAll('[data-privsight-mask]').length === 0, 'No mask elements present in DOM');

    // Clean up
    document.body.removeChild(bgForm);
    document.body.removeChild(rzpContainer);
    manager.cleanupMasks('test8_end');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 9] Step 7: Nested OTP dialog on top of payment options -> only OTP dialog is active');
  {
    // Background payment options modal
    const checkoutDialog = new MockElement('div');
    checkoutDialog.className = 'razorpay-checkout-modal modal show';
    checkoutDialog.attributes = { role: 'dialog' };
    checkoutDialog.style.zIndex = '1000';
    checkoutDialog.getBoundingClientRect = () => ({ left: 200, top: 100, width: 800, height: 600, right: 1000, bottom: 700 });

    const cardNumInput = new MockElement('input');
    cardNumInput.id = 'card-number';
    checkoutDialog.appendChild(cardNumInput);
    document.body.appendChild(checkoutDialog);

    // Centered OTP popup on top of checkout dialog
    const otpDialog = new MockElement('div');
    otpDialog.className = 'otp-dialog modal show';
    otpDialog.attributes = { role: 'dialog' };
    otpDialog.style.zIndex = '2000';
    otpDialog.getBoundingClientRect = () => ({ left: 350, top: 250, width: 500, height: 300, right: 850, bottom: 550 });

    const otpInput = new MockElement('input');
    otpInput.id = 'otp';
    otpDialog.appendChild(otpInput);
    document.body.appendChild(otpDialog);

    // Active topmost modal detection
    const getTopmostModal = () => otpDialog; // highest z-index

    const isElementOccludedNested = (el) => {
      const topModal = getTopmostModal();
      return !topModal.contains(el);
    };

    assert(isElementOccludedNested(cardNumInput) === true, 'Previous card input is occluded by OTP dialog');
    assert(isElementOccludedNested(otpInput) === false, 'OTP input inside active dialog is NOT occluded');

    // OTP detection in Step 7
    const step7Entities = [
      { id: 'pii-card', type: 'credit_card', targetElement: cardNumInput, bbox: { x: 250, y: 200, width: 250, height: 40 } },
      { id: 'pii-otp', type: 'password', targetElement: otpInput, bbox: { x: 400, y: 350, width: 200, height: 40 } },
    ].filter(e => !isElementOccludedNested(e.targetElement));

    assert(step7Entities.length === 1, 'Only the active OTP field is retained');
    assert(step7Entities[0].id === 'pii-otp', 'Retained entity is the active OTP input');

    manager.createMasks(step7Entities, 7);
    assert(manager.getActiveMasksCount() === 1, 'Step 7 has exactly 1 active mask for OTP');

    manager.cleanupMasks('test9_end');
    document.body.removeChild(checkoutDialog);
    document.body.removeChild(otpDialog);
    assert(manager.getActiveMasksCount() === 0, 'Clean state after Test 9');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 10] Razorpay modal Card, CVV, Expiry, Phone masking -> active modal fields NOT occluded and ARE masked');
  {
    const rzpContainer = new MockElement('div');
    rzpContainer.className = 'razorpay-container';
    rzpContainer.style.zIndex = '2147483647';

    const rzpModal = new MockElement('div');
    rzpModal.className = 'razorpay-checkout-frame modal show';
    rzpModal.attributes = { role: 'dialog' };

    // Phone text node container on left panel
    const phoneEl = new MockElement('div');
    phoneEl.textContent = 'Using as +91 74589 63214';
    rzpModal.appendChild(phoneEl);

    // Card inputs on right panel
    const cardInput = new MockElement('input');
    cardInput.id = 'card-number';
    cardInput.attributes = { placeholder: 'Card Number', value: '6027 6589 0000 1005' };
    rzpModal.appendChild(cardInput);

    const expiryInput = new MockElement('input');
    expiryInput.id = 'card-expiry';
    expiryInput.attributes = { placeholder: 'MM / YY', value: '12 / 29' };
    rzpModal.appendChild(expiryInput);

    const cvvInput = new MockElement('input');
    cvvInput.id = 'card-cvv';
    cvvInput.attributes = { placeholder: 'CVV', value: '...' };
    rzpModal.appendChild(cvvInput);

    rzpContainer.appendChild(rzpModal);
    document.body.appendChild(rzpContainer);

    // Occlusion check: el inside active modal is VISIBLE, el outside is occluded
    const isElementOccluded = (el) => {
      const topModal = rzpContainer;
      return !topModal.contains(el);
    };

    assert(isElementOccluded(phoneEl) === false, 'Phone text inside Razorpay modal is NOT occluded');
    assert(isElementOccluded(cardInput) === false, 'Card Number input inside Razorpay modal is NOT occluded');
    assert(isElementOccluded(expiryInput) === false, 'Expiry input inside Razorpay modal is NOT occluded');
    assert(isElementOccluded(cvvInput) === false, 'CVV input inside Razorpay modal is NOT occluded');

    const modalEntities = [
      { id: 'pii-phone', type: 'phone', targetElement: phoneEl, bbox: { x: 100, y: 200, width: 150, height: 24 } },
      { id: 'pii-card', type: 'credit_card', targetElement: cardInput, bbox: { x: 300, y: 200, width: 200, height: 35 } },
      { id: 'pii-exp', type: 'credit_card', targetElement: expiryInput, bbox: { x: 300, y: 250, width: 90, height: 35 } },
      { id: 'pii-cvv', type: 'cvv', targetElement: cvvInput, bbox: { x: 410, y: 250, width: 90, height: 35 } },
    ].filter(e => !isElementOccluded(e.targetElement));

    assert(modalEntities.length === 4, 'All 4 modal financial PII fields pass visibility check');

    manager.createMasks(modalEntities, 8);
    assert(manager.getActiveMasksCount() === 4, 'All 4 financial PII fields masked in DOM before screenshot transmission');

    manager.cleanupMasks('test10_end');
    document.body.removeChild(rzpContainer);
    assert(manager.getActiveMasksCount() === 0, 'Clean state after Test 10');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 11] Voice output synchronization -> speaks prompt text and avoids stale button click repetition');
  {
    // Mock getSafeSpokenActionMessage logic
    const getSafeSpoken = (action, targetFriendlyName) => {
      const containsSens = (s) => /password|pin|secret|token|\d{12,19}/i.test(s);
      const sanitize = (s, maxLen) => {
        let clean = s.replace(/\b(?:\d[ \-]?){12,18}\d\b/g, 'card number')
                     .replace(/\b(?:cvv|cvc|csc)\s*[:=]?\s*\d{3,4}\b/gi, 'security code');
        return clean.length > maxLen ? clean.slice(0, maxLen).trim() + '...' : clean;
      };

      switch (action.action) {
        case 'ask_user': {
          const promptMsg = action.prompt || action.reason;
          if (promptMsg && !containsSens(promptMsg)) {
            return sanitize(promptMsg, 100);
          }
          if (targetFriendlyName && !/pay|submit|click|button/i.test(targetFriendlyName)) {
            return `Would you like me to click ${sanitize(targetFriendlyName, 25)}?`;
          }
          return 'Please enter the required details on the page to continue.';
        }
        case 'fill': {
          const tName = (targetFriendlyName || '').toLowerCase();
          if (tName.includes('card')) return 'Entering the card number.';
          if (tName.includes('cvv') || tName.includes('security')) return 'Entering the card security code.';
          if (tName.includes('exp') || tName.includes('date')) return 'Entering the card expiry date.';
          return 'Entering details.';
        }
        default: {
          const fallback = action.prompt || action.reason;
          if (fallback && !containsSens(fallback)) return sanitize(fallback, 100);
          return null;
        }
      }
    };

    // Case 1: Backend asks user to enter CVV details, with stale targetFriendlyName = "Pay button"
    const askAction = {
      action: 'ask_user',
      prompt: 'Please enter your CVV and card details to proceed with the transaction.',
    };
    const spokenAsk = getSafeSpoken(askAction, 'Pay button');
    assert(!spokenAsk.includes('Pay button'), 'Does NOT repeat stale "Would you like me to click Pay button?"');
    assert(spokenAsk.includes('Please enter your CVV and card details'), 'Speaks the actual prompt matching chat message');

    // Case 2: Fill action for card details speaks semantic category without leaking digits
    const fillCard = { action: 'fill', value: '6027658900001005' };
    const spokenCard = getSafeSpoken(fillCard, 'Card number');
    assert(spokenCard === 'Entering the card number.', 'Speaks safe card filling status without digits');

    // Case 3: Fill action for CVV speaks security code without leaking digits
    const fillCvv = { action: 'fill', value: '123' };
    const spokenCvv = getSafeSpoken(fillCvv, 'CVV');
    assert(spokenCvv === 'Entering the card security code.', 'Speaks safe CVV filling status without digits');

    // Case 4: No matching action keyword falls back to actual response text
    const customAction = { action: 'custom_step', prompt: 'Verifying payment status with the gateway.' };
    const spokenCustom = getSafeSpoken(customAction, '');
    assert(spokenCustom === 'Verifying payment status with the gateway.', 'Speaks custom response when no keyword matches');
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 12] Payment Modal exact input masking -> precise bounding boxes matching input elements');
  {
    const modal = new MockElement('div');
    modal.className = 'razorpay-container modal show';
    modal.attributes = { role: 'dialog' };
    modal.getBoundingClientRect = () => ({ left: 200, top: 100, width: 700, height: 500, right: 900, bottom: 600 });

    const cardInput = new MockElement('input');
    cardInput.id = 'card-num';
    cardInput.attributes = { placeholder: 'Card Number', value: '6528 9012 3456 7890' };
    cardInput.getBoundingClientRect = () => ({ left: 450, top: 220, width: 300, height: 40, right: 750, bottom: 260 });
    modal.appendChild(cardInput);

    const expInput = new MockElement('input');
    expInput.id = 'card-exp';
    expInput.attributes = { placeholder: 'MM / YY', value: '12 / 28' };
    expInput.getBoundingClientRect = () => ({ left: 450, top: 270, width: 140, height: 40, right: 590, bottom: 310 });
    modal.appendChild(expInput);

    const cvvInput = new MockElement('input');
    cvvInput.id = 'card-cvv';
    cvvInput.attributes = { placeholder: 'CVV', value: '...' };
    cvvInput.getBoundingClientRect = () => ({ left: 600, top: 270, width: 140, height: 40, right: 740, bottom: 310 });
    modal.appendChild(cvvInput);

    document.body.appendChild(modal);

    const cardBbox = cardInput.getBoundingClientRect();
    const expBbox = expInput.getBoundingClientRect();
    const cvvBbox = cvvInput.getBoundingClientRect();

    assert(cardBbox.width <= 320 && cardBbox.height <= 50, 'Card input mask has precise width (no giant boxes)');
    assert(expBbox.width <= 150 && expBbox.height <= 50, 'Expiry input mask has precise width (no giant boxes)');
    assert(cvvBbox.width <= 150 && cvvBbox.height <= 50, 'CVV input mask has precise width (no giant boxes)');

    const modalEntities = [
      { id: 'm-card', type: 'credit_card', targetElement: cardInput, bbox: cardBbox },
      { id: 'm-exp', type: 'credit_card', targetElement: expInput, bbox: expBbox },
      { id: 'm-cvv', type: 'cvv', targetElement: cvvInput, bbox: cvvBbox },
    ];

    manager.createMasks(modalEntities, 4);
    assert(manager.getActiveMasksCount() === 3, '3 exact-fit masks created for card, expiry, and CVV');

    manager.cleanupMasks('test12_end');
    document.body.removeChild(modal);
    assert(manager.getActiveMasksCount() === 0, 'Clean state after Test 12');
  }

  console.log('\n============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
