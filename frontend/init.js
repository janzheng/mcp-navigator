import mcpNavApp from './mcpNavApp.js';

window.mcpNavApp = mcpNavApp;

// Register with Alpine when ready
if (window.Alpine && typeof window.Alpine.data === 'function') {
  window.Alpine.data('mcpNavApp', mcpNavApp);
} else {
  document.addEventListener('alpine:init', () => {
    try {
      if (window.Alpine && typeof window.Alpine.data === 'function') {
        window.Alpine.data('mcpNavApp', mcpNavApp);
      }
    } catch (_) { /* no-op */ }
  });
}

// If Alpine was deferred via window.deferLoadingAlpine, start it now
try { if (typeof window._startAlpine === 'function') window._startAlpine(); } catch (_) {}


