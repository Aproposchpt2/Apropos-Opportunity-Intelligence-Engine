(() => {
  const TEAM_SUMMARIES = Object.freeze({
    ACQUISITION_DISCOVERY: {
      label: 'APIE Acquisition Task Force',
      count: 7,
      agents: ['Mission Orchestration','Publisher Access','Acquisition Operations','Normalization & Qualification','Persistence & Reconciliation','Mission QA','Mission Reporting']
    },
    PUBLISHER_DISCOVERY: {
      label: 'APIE Publisher Discovery Task Force',
      count: 6,
      agents: ['Mission Orchestration','Publisher Research','Platform Classification','Publisher Admission','Mission QA','Mission Reporting']
    },
    VERIFY_PUBLISHER_CONNECTION: {
      label: 'APIE Publisher Engineering Task Force',
      count: 4,
      agents: ['Mission Orchestration','Publisher Access','Connector QA','Mission Reporting']
    },
    CONTRACT_PACKAGE_ACQUISITION: {
      label: 'APIE Contract Package Task Force',
      count: 5,
      agents: ['Mission Orchestration','Package Acquisition','Document Persistence','Package QA','Mission Reporting']
    }
  });

  const style = document.createElement('style');
  style.textContent = `
    .ecc-agent-team-panel{display:grid;gap:.5rem;margin-top:.45rem;padding:.72rem;border:1px solid rgba(125,211,252,.22);border-radius:6px;background:rgba(2,8,20,.22);text-transform:none;letter-spacing:normal}
    .ecc-agent-team-panel strong{color:#eef4fb;font-size:.78rem;line-height:1.35}
    .ecc-agent-team-panel small{color:#8996a7!important;font-size:.7rem!important;line-height:1.4!important}
    .ecc-agent-team-chips{display:flex;flex-wrap:wrap;gap:.32rem}
    .ecc-agent-team-chip{padding:.25rem .42rem;border:1px solid rgba(125,211,252,.18);border-radius:999px;color:#aebccf;font-size:.64rem;line-height:1.2}
  `;
  document.head.appendChild(style);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.includes('/.netlify/functions/command-mission-control')) {
      const nextUrl = url.replace('/.netlify/functions/command-mission-control', '/.netlify/functions/command-mission-control-team');
      if (typeof input === 'string') return nativeFetch(nextUrl, init);
      return nativeFetch(new Request(nextUrl, input), init);
    }
    return nativeFetch(input, init);
  };

  function renderTeam() {
    const task = document.getElementById('eccMissionType');
    const agent = document.getElementById('eccAgentDisplay');
    if (!task || !agent) return;
    const team = TEAM_SUMMARIES[task.value] || {
      label: 'APIE Multi-Agent Task Force',
      count: 4,
      agents: ['Mission Orchestration','Mission Execution','Mission QA','Mission Reporting']
    };
    if (!task.value) return;
    agent.value = `${team.label} · ${team.count} specialized agents`;
    const label = agent.closest('label');
    if (!label) return;
    let panel = label.querySelector('.ecc-agent-team-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ecc-agent-team-panel';
      label.appendChild(panel);
    }
    panel.innerHTML = `<strong>${team.label}</strong><small>PostgreSQL owns mission state. Specialized agents own bounded execution stages and exchange responsibility through persisted checkpoints.</small><div class="ecc-agent-team-chips">${team.agents.map(name => `<span class="ecc-agent-team-chip">${name}</span>`).join('')}</div>`;
  }

  window.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('eccLaunchForm');
    const task = document.getElementById('eccMissionType');
    if (!form || !task) return;
    task.addEventListener('change', () => setTimeout(renderTeam, 0));
    form.addEventListener('change', () => setTimeout(renderTeam, 0));
    window.addEventListener('apie:authenticated', () => setTimeout(renderTeam, 0));
    setTimeout(renderTeam, 0);
  });
})();
