/*
 * Legacy APIE Command Center runtime — RETIRED BY VAR CYCLE 2.
 *
 * The authoritative browser experience is now:
 *   assets/executive-core.js
 *   assets/executive-command-center.js
 *   assets/executive-launch.js
 *
 * This file intentionally contains no readiness, connector-health, publisher-health,
 * database-health, provider-health, or mission-launch logic. The former implementation
 * inferred operational truth from browser configuration and static publisher objects,
 * which violated the APIOS evidence model (VAR-DEF-002).
 *
 * Keeping a non-operational compatibility marker is safer than leaving an alternate
 * execution path that could be accidentally reintroduced by an old page or script tag.
 */
(() => {
  'use strict';
  window.APIE_LEGACY_COMMAND_CENTER_RETIRED = true;
  console.warn('Legacy APIE Command Center runtime is retired. Use the Executive Command Center.');
})();
