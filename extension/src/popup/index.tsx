/**
 * PrivSight — Extension Popup Entry Point
 *
 * Renders UnifiedLiveConsole:
 * - Unified Live Session Chat + Inspector & Real-time Stats in a single cohesive screen
 * - Total Redaction tracking and Sanitized Screenshot previews integrated inside the chat feed
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { UnifiedLiveConsole } from './UnifiedLiveConsole';

function Popup() {
  return <UnifiedLiveConsole />;
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
);

export { UnifiedLiveConsole };
