window.AP_COMMAND_CONFIG = Object.freeze({
  supabaseUrl: '',
  anonKey: ''
});

(() => {
  const style = document.createElement('style');
  style.textContent = `
    .primary-action.apie-cta-initiated {
      background: linear-gradient(135deg,#f59e0b,#facc15) !important;
      color:#1f1300 !important;
      box-shadow:0 0 0 3px rgba(245,158,11,.18),0 10px 24px rgba(245,158,11,.22) !important;
      filter:none !important;
      transform:none !important;
    }
  `;
  document.head.appendChild(style);

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!['eccLaunchForm','gateForm'].includes(form.id)) return;
    const button = form.querySelector('button[type="submit"].primary-action');
    if (!button) return;
    button.classList.add('apie-cta-initiated');
    button.setAttribute('data-cta-initiated','true');
    button.setAttribute('aria-busy','true');
  }, true);

  document.addEventListener('input', event => {
    const form = event.target?.closest?.('form');
    if (!form || !['eccLaunchForm','gateForm'].includes(form.id)) return;
    const button = form.querySelector('button[type="submit"].primary-action');
    if (!button) return;
    button.classList.remove('apie-cta-initiated');
    button.removeAttribute('data-cta-initiated');
    button.removeAttribute('aria-busy');
  });
})();
