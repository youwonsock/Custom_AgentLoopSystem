(function () {
  const vscode = acquireVsCodeApi();

  let state = {
    registry: null,
    selectedSessionId: null,
    state: null,
    progressNotes: "",
    history: [],
    finalSummary: null,
    isRunning: false,
    defaultTargetPath: "",
  };

  let logBuffer = "";
  const maxLogSize = 100000;

  const agentRoles = ["planner", "implementer", "tester", "qa_lead", "master", "interrupter"];
  const agentRoleLabels = {
    planner: "Planner",
    implementer: "Implementer",
    tester: "Tester",
    qa_lead: "QA Lead",
    master: "Master",
    interrupter: "Interrupter",
  };
  let modelSelections = {};

  // Compose mode: when the user explicitly starts a "New Session" flow,
  // lock the view to the composer regardless of existing sessions so typing
  // is not interrupted by polling-driven re-renders switching to the control panel.
  let composingNew = false;

  // Composer state persisted across re-renders so user input is not lost.
  let composerGoal = "";
  let composerTarget = "";
  let composerInitialized = false;

  // Re-render guard: while the user is interacting with a form control
  // (select/input/textarea), defer re-renders so open dropdowns are not destroyed.
  let isInteracting = false;
  let renderQueued = false;
  let lastStateSig = "";

  function stateSignature() {
    const st = state.state;
    return JSON.stringify({
      s: st ? [st.status, st.phase, st.loopCount, st.updatedAt, st.maxIterations] : null,
      sel: state.selectedSessionId,
      run: state.isRunning,
      metas: (state.registry?.sessionMetas || []).map((m) => [m.sessionId, m.status]),
      models: state.registry?.availableModels?.length ?? 0,
      disc: state.registry?.modelsDiscoveredAt,
      notesLen: state.progressNotes.length,
      histLen: (state.history || []).length,
      hasSummary: !!state.finalSummary,
      defTarget: state.defaultTargetPath,
    });
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;

    const hasRegistry = !!state.registry;
    const hasSession = !!state.selectedSessionId || (state.registry?.sessionMetas?.length ?? 0) > 0;

    if (composingNew || (!hasRegistry && !hasSession)) {
      renderEmpty(root);
      return;
    }
    renderActive(root);
  }

  function buildGroupedModels() {
    const availableModels = state.registry?.availableModels || [];
    const grouped = {};
    for (const m of availableModels) {
      const slashIdx = m.indexOf("/");
      const provider = slashIdx > 0 ? m.slice(0, slashIdx) : "other";
      const name = slashIdx > 0 ? m.slice(slashIdx + 1) : m;
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push({ value: m, name });
    }
    return { grouped, providerNames: Object.keys(grouped).sort() };
  }

  function buildModelOptions(current, grouped, providerNames) {
    let html = `<option value="">(auto)</option>`;
    for (const provider of providerNames) {
      const items = grouped[provider]
        .map((it) => `<option value="${escapeHtml(it.value)}"${it.value === current ? " selected" : ""}>${escapeHtml(it.name)}</option>`)
        .join("");
      html += `<optgroup label="${escapeHtml(provider)}">${items}</optgroup>`;
    }
    return html;
  }

  function buildModelGrid(st) {
    const { grouped, providerNames } = buildGroupedModels();
    return agentRoles
      .map((role) => {
        const current = st?.modelMapping?.[role] || modelSelections[role] || "";
        const label = agentRoleLabels[role] || role;
        return `
          <div class="model-row">
            <label class="model-role">${escapeHtml(label)}</label>
            <select data-role="${escapeHtml(role)}" class="model-select">
              ${buildModelOptions(current, grouped, providerNames)}
            </select>
          </div>`;
      })
      .join("");
  }

  function composerHtml(compact) {
    const goalVal = escapeHtml(composerGoal);
    const targetVal = escapeHtml(composerTarget || composerTargetDefault());
    const wrapClass = compact ? "composer composer-bar" : "composer composer-large";
    const textareaClass = compact ? "composer-goal" : "composer-goal composer-goal-large";
    const rows = compact ? 2 : 4;
    const cancelBtn = composingNew ? `<button class="btn secondary" id="composer-cancel">Cancel</button>` : "";
    return `
      <div class="${wrapClass}" id="composer">
        <textarea id="composer-goal" class="${textareaClass}" rows="${rows}" placeholder="Describe the goal for the agent loop to achieve... (Ctrl+Enter to start)">${goalVal}</textarea>
        <div class="composer-meta">
          <input type="text" id="composer-target" class="composer-input" placeholder="Target project path" value="${targetVal}" />
          <button class="btn" id="composer-start">Start Session</button>
          ${cancelBtn}
        </div>
      </div>`;
  }

  function composerTargetDefault() {
    return state.defaultTargetPath || state.state?.targetProjectPath || "";
  }

  function renderEmpty(root) {
    const { grouped, providerNames } = buildGroupedModels();
    const modelGrid = agentRoles
      .map((role) => {
        const current = modelSelections[role] || "";
        const label = agentRoleLabels[role] || role;
        return `
          <div class="model-row">
            <label class="model-role">${escapeHtml(label)}</label>
            <select data-role="${escapeHtml(role)}" class="model-select">
              ${buildModelOptions(current, grouped, providerNames)}
            </select>
          </div>`;
      })
      .join("");

    root.innerHTML = `
      <div class="empty-wrap">
        <div class="empty-hero">
          <div class="empty-icon">&#9881;</div>
          <h2>Agent Loop Orchestrator</h2>
          <p class="empty-sub">Describe a coding goal below. The orchestrator will plan, implement, test, verify, and seek master approval autonomously.</p>
        </div>
        ${composerHtml(false)}
        <div class="card model-card empty-model-card">
          <h3>Model Mapping (${(state.registry?.availableModels || []).length} models available)</h3>
          <div class="model-grid">${modelGrid}</div>
          <div class="composer-actions">
            <button class="btn secondary" id="btn-discover">Discover Models</button>
            <span class="composer-hint">${state.registry?.modelsDiscoveredAt ? "Last discovered: " + escapeHtml(formatDate(state.registry.modelsDiscoveredAt)) : "No models discovered yet."}</span>
          </div>
        </div>
      </div>`;
    bindComposer();
    bindModelSelects();
    const btnDiscover = document.getElementById("btn-discover");
    if (btnDiscover) btnDiscover.onclick = () => vscode.postMessage({ command: "discoverModels" });
  }

  function renderActive(root) {
    const sessionOptions = (state.registry?.sessionMetas || [])
      .map(
        (m) => `<option value="${escapeHtml(m.sessionId)}" ${m.sessionId === state.selectedSessionId ? "selected" : ""}>${escapeHtml(m.sessionId)} [${escapeHtml(m.status)}]</option>`
      )
      .join("");

    const st = state.state;
    const statusBadge = st
      ? `<span class="badge ${escapeHtml(st.status.toLowerCase())}">${escapeHtml(st.status)}</span>`
      : "<span class=\"badge\">NONE</span>";

    const summaryBanner = state.finalSummary
      ? `<div class="summary-banner">
           <span>Session achieved SUCCESS at ${escapeHtml(formatDate(state.finalSummary.achievedAt))}</span>
           <button id="btn-open-summary">View Summary</button>
         </div>`
      : "";

    const modelGrid = buildModelGrid(st);

    const statusRows = st
      ? `
        <div class="status-row"><span class="label">Session</span><span class="value">${escapeHtml(st.sessionId)}</span></div>
        <div class="status-row"><span class="label">Status</span>${statusBadge}</div>
        <div class="status-row"><span class="label">Phase</span><span class="value">${escapeHtml(st.phase)}</span></div>
        <div class="status-row"><span class="label">Loop</span><span class="value">${st.loopCount} / ${st.maxIterations}</span></div>
        <div class="status-row"><span class="label">Goal</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.goal).slice(0, 80))}</span></div>
        <div class="status-row"><span class="label">Target</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.targetProjectPath).slice(0, 60))}</span></div>
        ${st.errorQueue && st.errorQueue.length > 0 ? `<div class="error-queue"><div class="status-row" style="display:block"><span class="label">Error Queue (Lookback-5):</span></div>${st.errorQueue
          .map((e) => `<div class="error-queue-item">[${escapeHtml(e.phase)}] ${escapeHtml(e.signature)}</div>`)
          .join("")}</div>` : ""}
      `
      : `<div class="notes-empty">No session selected.</div>`;

    const historyList = (state.history || [])
      .map(
        (h) => `<li class="history-item">
          <span><span class="phase">${escapeHtml(h.phase)}</span> &middot; ${escapeHtml(h.agentRole)} &middot; loop ${h.loopNumber}</span>
          <span class="result ${escapeHtml(h.result)}">${escapeHtml(h.result)} (${h.exitCode})</span>
        </li>`
      )
      .join("");

    const notesContent = state.progressNotes
      ? escapeHtml(state.progressNotes)
      : '<span class="notes-empty">(no notes yet)</span>';

    const logContent = logBuffer
      ? `<div class="log-content">${escapeHtml(logBuffer)}</div>`
      : '<div class="log-empty">(no log output yet)</div>';

    root.innerHTML = `
      ${summaryBanner}
      <div class="toolbar">
        <select id="session-select">${sessionOptions}</select>
        <button class="btn secondary" id="btn-resume" ${state.isRunning ? "disabled" : ""}>Resume</button>
        <button class="btn danger" id="btn-stop" ${!state.isRunning ? "disabled" : ""}>Stop</button>
        <button class="btn secondary" id="btn-discover">Models</button>
        <button class="btn secondary" id="btn-open-notes">Notes</button>
      </div>
      <div class="main-grid">
        <div class="card status-card">
          <h3>Status</h3>
          ${statusRows}
        </div>
        <div class="card model-card">
          <h3>Model Mapping (${(state.registry?.availableModels || []).length} available)</h3>
          <div class="model-grid">${modelGrid}</div>
        </div>
        <div class="card notes-card">
          <h3>Progress Notes (Rolling Summary)</h3>
          <div class="notes-content">${notesContent}</div>
        </div>
        <div class="card history-card">
          <h3>Loop History (${(state.history || []).length})</h3>
          <ul class="history-list">${historyList || '<li class="notes-empty">(no history)</li>'}</ul>
        </div>
        <div class="card log-card">
          <h3>Live Log Stream</h3>
          ${logContent}
        </div>
      </div>
      ${composerHtml(true)}
    `;

    bindToolbar();
    bindModelSelects();
    bindComposer();
    scrollLogToBottom();
  }

  function bindToolbar() {
    const sessionSelect = document.getElementById("session-select");
    const btnResume = document.getElementById("btn-resume");
    const btnStop = document.getElementById("btn-stop");
    const btnDiscover = document.getElementById("btn-discover");
    const btnOpenNotes = document.getElementById("btn-open-notes");
    const btnOpenSummary = document.getElementById("btn-open-summary");

    if (sessionSelect) sessionSelect.onchange = (e) => {
      vscode.postMessage({ command: "selectSession", sessionId: e.target.value });
    };
    if (btnResume) btnResume.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "resumeSession", sessionId: state.selectedSessionId });
    };
    if (btnStop) btnStop.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "stopSession", sessionId: state.selectedSessionId });
    };
    if (btnDiscover) btnDiscover.onclick = () => vscode.postMessage({ command: "discoverModels" });
    if (btnOpenNotes) btnOpenNotes.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "openProgressNotes", sessionId: state.selectedSessionId });
    };
    if (btnOpenSummary) btnOpenSummary.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "openFinalSummary", sessionId: state.selectedSessionId });
    };
  }

  function bindModelSelects() {
    document.querySelectorAll("select[data-role]").forEach((sel) => {
      sel.onchange = (e) => {
        const role = e.target.getAttribute("data-role");
        modelSelections[role] = e.target.value;
      };
    });
  }

  function bindComposer() {
    const goalEl = document.getElementById("composer-goal");
    const targetEl = document.getElementById("composer-target");
    const startBtn = document.getElementById("composer-start");
    const cancelBtn = document.getElementById("composer-cancel");

    if (!composerInitialized) {
      if (!composerTarget) composerTarget = composerTargetDefault();
    }

    if (goalEl) {
      goalEl.value = composerGoal;
      goalEl.oninput = (e) => { composerGoal = e.target.value; };
      goalEl.onkeydown = (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendNewSession();
        }
        if (e.key === "Escape" && composingNew) {
          e.preventDefault();
          cancelCompose();
        }
      };
    }
    if (targetEl) {
      targetEl.value = composerTarget;
      targetEl.oninput = (e) => { composerTarget = e.target.value; };
    }
    if (startBtn) startBtn.onclick = () => sendNewSession();
    if (cancelBtn) cancelBtn.onclick = () => cancelCompose();
    composerInitialized = true;
  }

  function cancelCompose() {
    composingNew = false;
    lastStateSig = "";
    tryRender();
  }

  function sendNewSession() {
    const goal = composerGoal;
    if (!goal || goal.trim().length === 0) return;
    const mapping = {};
    for (const role of agentRoles) {
      if (modelSelections[role]) mapping[role] = modelSelections[role];
    }
    vscode.postMessage({
      command: "newSession",
      goal: goal.trim(),
      targetProjectPath: (composerTarget || composerTargetDefault()).trim(),
      modelMapping: mapping,
    });
    composingNew = false;
    composerGoal = "";
    const goalEl = document.getElementById("composer-goal");
    if (goalEl) goalEl.value = "";
  }

  function focusComposer() {
    const goalEl = document.getElementById("composer-goal");
    if (goalEl) goalEl.focus();
  }

  function scrollLogToBottom() {
    const logEl = document.querySelector(".log-content");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(str) {
    if (!str) return "";
    const d = new Date(str);
    if (isNaN(d.getTime())) return escapeHtml(str);
    return d.toLocaleString();
  }

  // Global interaction guard: track focus within form controls to defer re-renders.
  function setupInteractionGuard() {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t && (t.tagName === "SELECT" || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        isInteracting = true;
      }
    });
    document.addEventListener("focusout", (e) => {
      const t = e.target;
      if (t && (t.tagName === "SELECT" || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        isInteracting = false;
        if (renderQueued) {
          renderQueued = false;
          tryRender();
        }
      }
    });
  }

  function tryRender() {
    const sig = stateSignature();
    if (sig === lastStateSig) return;
    lastStateSig = sig;
    render();
  }

  function requestRender() {
    if (isInteracting) {
      renderQueued = true;
      return;
    }
    tryRender();
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.command) return;

    if (msg.command === "stateUpdate") {
      state = msg.payload;
      requestRender();
    } else if (msg.command === "logAppend") {
      const text = msg.entry.text;
      logBuffer += text;
      if (logBuffer.length > maxLogSize) {
        logBuffer = logBuffer.slice(-maxLogSize);
      }
      const logEl = document.querySelector(".log-content");
      if (logEl) {
        logEl.textContent = logBuffer;
        scrollLogToBottom();
      } else if (!isInteracting) {
        tryRender();
      }
    } else if (msg.command === "focusComposer") {
      composingNew = true;
      lastStateSig = "";
      tryRender();
      focusComposer();
    }
  });

  setupInteractionGuard();
  vscode.postMessage({ command: "requestState" });
  render();
})();
