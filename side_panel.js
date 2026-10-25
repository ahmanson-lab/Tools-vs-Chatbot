// =============================================
// STATE
// =============================================

let CONFIG = [];
const activeToggles = new Set();
const optionsValues = {};
const dropdownValues = {};
const activeButtons = new Set();
const sliderValues = {};
const activeBadges = new Set();

let currentModel = '—';
let currentTokenCount = 0;
let currentDatacenter = null;

let isEditMode = false;
let editingIndex = null;   // null = adding new, number = editing existing
let selectedType = null;

// --- Config mode ---
// 'sheet' = live-synced from Google Sheet (instructor controls)
// 'local' = student-edited in the panel
let configMode = 'local';
let sheetPollInterval = null;
let lastSheetJSON = '';       // cached JSON for diffing
let sheetPollBusy = false;    // prevent overlapping fetches

const INJECTION_PATTERN = /\s*\[PANEL INSTRUCTIONS:[\s\S]*\]/g;
const STORAGE_KEY = 'tvc-config';
const STORAGE_URL_KEY = 'tvc-sheet-url';
const STORAGE_MODE_KEY = 'tvc-config-mode';
const SHEET_POLL_MS = 30000;  // 30 seconds

// =============================================
// DATACENTER MAP
// =============================================

const DATACENTER_MAP = {
  'westus3': { name: 'West US 3', short: 'El Mirage, Arizona' },
  'westus2': { name: 'West US 2', short: 'Quincy, Washington' },
  'westus': { name: 'West US', short: 'Fresno, California' },
  'westcentralus': { name: 'West Central US', short: 'Cheyenne, Wyoming' },
  'eastus': { name: 'East US', short: 'Boydton, Virginia' },
  'eastus2': { name: 'East US 2', short: 'Boydton, Virginia' },
  'centralus': { name: 'Central US', short: 'Des Moines, Iowa' },
  'southcentralus': { name: 'South Central US', short: 'San Antonio, Texas' },
  'northcentralus': { name: 'North Central US', short: 'Northlake, Illinois' },
  'westeurope': { name: 'West Europe', short: 'Amsterdam, Netherlands' },
  'northeurope': { name: 'North Europe', short: 'Dublin, Ireland' },
  'uksouth': { name: 'UK South', short: 'London, UK' },
  'japaneast': { name: 'Japan East', short: 'Tokyo, Japan' },
  'southeastasia': { name: 'Southeast Asia', short: 'Singapore' },
  'australiaeast': { name: 'Australia East', short: 'Sydney, Australia' },
  'canadacentral': { name: 'Canada Central', short: 'Toronto, Canada' },
  'francecentral': { name: 'France Central', short: 'Paris, France' },
  'germanywestcentral': { name: 'Germany West Central', short: 'Frankfurt, Germany' },
  'swedencentral': { name: 'Sweden Central', short: 'Stockholm, Sweden' },
  'koreacentral': { name: 'Korea Central', short: 'Seoul, South Korea' },
};

function lookupDatacenter(region) {
  if (!region) return null;
  const key = region.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DATACENTER_MAP[key] || { name: region, short: region };
}

// =============================================
// CSV PARSER
// =============================================

function parseCSV(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(current.trim());
        current = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(current.trim());
        if (row.length > 0 && row.some(cell => cell !== '')) rows.push(row);
        row = [];
        current = '';
      } else {
        current += char;
      }
    }
  }
  row.push(current.trim());
  if (row.length > 0 && row.some(cell => cell !== '')) rows.push(row);
  return rows;
}

function csvToConfig(csvText) {
  const rows = parseCSV(csvText);
  return rows.slice(1)
    .filter(row => row.length >= 2 && row[0] && row[1])
    .map(row => ({
      type: row[0].toLowerCase().trim(),
      label: row[1].trim(),
      source: (row[2] || '').trim(),
      instruction: (row[3] || '').trim(),
      options: (row[4] || '').split(',').map(o => o.trim()).filter(o => o),
      color: (row[5] || '').toLowerCase().trim()
    }));
}

// =============================================
// LOCALSTORAGE PERSISTENCE
// =============================================

function saveConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
  } catch (e) {
    console.log('Tool vs Chat: could not save config', e);
  }
}

function loadSavedConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      CONFIG = JSON.parse(raw);
      return true;
    }
  } catch (e) {
    console.log('Tool vs Chat: could not load saved config', e);
  }
  return false;
}

function saveSheetUrl(url) {
  try { localStorage.setItem(STORAGE_URL_KEY, url); } catch (e) {}
}

function getSavedSheetUrl() {
  try { return localStorage.getItem(STORAGE_URL_KEY) || ''; } catch (e) { return ''; }
}

function saveConfigMode(mode) {
  try { localStorage.setItem(STORAGE_MODE_KEY, mode); } catch (e) {}
}

function loadConfigMode() {
  try { return localStorage.getItem(STORAGE_MODE_KEY) || 'local'; } catch (e) { return 'local'; }
}

function clearSavedConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_URL_KEY);
    localStorage.removeItem(STORAGE_MODE_KEY);
  } catch (e) {}
}

// =============================================
// PRESETS
// =============================================

const STORAGE_PRESETS_KEY = 'tvc-presets';

function getPresets() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PRESETS_KEY)) || [];
  } catch (e) { return []; }
}

function savePresets(presets) {
  try { localStorage.setItem(STORAGE_PRESETS_KEY, JSON.stringify(presets)); } catch (e) {}
}

function saveCurrentAsPreset(name) {
  const presets = getPresets();
  const preset = {
    name: name,
    config: JSON.parse(JSON.stringify(CONFIG)),
    states: snapshotActiveStates(),
    mode: configMode,
    sheetUrl: getSavedSheetUrl(),
    savedAt: Date.now()
  };
  presets.push(preset);
  savePresets(presets);
  renderPresetsPanel();
}

function loadPreset(index) {
  const presets = getPresets();
  const preset = presets[index];
  if (!preset) return;

  CONFIG = preset.config;
  saveConfig();
  restoreActiveStates(preset.states);

  if (preset.mode === 'sheet' && preset.sheetUrl) {
    saveSheetUrl(preset.sheetUrl);
    setConfigMode('sheet');
  } else {
    setConfigMode('local');
  }

  lastSheetJSON = JSON.stringify(CONFIG);
  isEditMode = false;
  const panel = document.getElementById('tvc-panel');
  const et = document.getElementById('tvc-edit-toggle');
  if (panel) panel.classList.remove('editing');
  if (et) et.classList.remove('active');
  updateModeBar();
  renderControls();
  togglePresetsPanel(false);
}

function deletePreset(index) {
  const presets = getPresets();
  const name = presets[index]?.name || 'this preset';
  if (!confirm(`Delete "${name}"?`)) return;
  presets.splice(index, 1);
  savePresets(presets);
  renderPresetsPanel();
}

function renamePreset(index) {
  const presets = getPresets();
  const current = presets[index]?.name || '';
  const newName = prompt('Rename preset:', current);
  if (!newName || newName.trim() === '') return;
  presets[index].name = newName.trim();
  savePresets(presets);
  renderPresetsPanel();
}

function togglePresetsPanel(forceState) {
  const panel = document.getElementById('tvc-presets-panel');
  if (!panel) return;
  const show = forceState !== undefined ? forceState : !panel.classList.contains('visible');
  panel.classList.toggle('visible', show);
  const btn = document.getElementById('tvc-presets-toggle');
  if (btn) btn.classList.toggle('active', show);
  if (show) renderPresetsPanel();
}

function renderPresetsPanel() {
  const list = document.getElementById('tvc-presets-list');
  if (!list) return;

  const presets = getPresets();

  if (presets.length === 0) {
    list.innerHTML = '<div class="tvc-presets-empty">No saved presets yet.</div>';
    return;
  }

  list.innerHTML = '';
  presets.forEach((preset, i) => {
    const item = document.createElement('div');
    item.className = 'tvc-preset-item';

    const info = document.createElement('div');
    info.className = 'tvc-preset-info';
    info.addEventListener('click', () => loadPreset(i));

    const name = document.createElement('span');
    name.className = 'tvc-preset-name';
    name.textContent = preset.name;
    info.appendChild(name);

    const count = preset.config ? preset.config.length : 0;
    const meta = document.createElement('span');
    meta.className = 'tvc-preset-meta';
    meta.textContent = count + ' control' + (count !== 1 ? 's' : '');
    info.appendChild(meta);

    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'tvc-preset-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'tvc-preset-action';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renamePreset(i); });
    actions.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'tvc-preset-action tvc-preset-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deletePreset(i); });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    list.appendChild(item);
  });
}

// =============================================
// ACTIVE STATE SNAPSHOT (for preserving across sheet refreshes)
// =============================================

// Build a map keyed by "type:label" so state survives index shifts
// when the instructor adds/removes/reorders rows in the sheet.

function snapshotActiveStates() {
  const snap = {};
  CONFIG.forEach((item, i) => {
    const key = `${item.type}:${item.label}`;
    if (item.type === 'toggle' && activeToggles.has(i))       snap[key] = { kind: 'on' };
    if (item.type === 'options' && optionsValues[i] !== undefined) snap[key] = { kind: 'value', v: optionsValues[i] };
    if (item.type === 'dropdown' && dropdownValues[i] !== undefined) snap[key] = { kind: 'value', v: dropdownValues[i] };
    if (item.type === 'button' && activeButtons.has(i))       snap[key] = { kind: 'on' };
    if (item.type === 'slider' && sliderValues[i] !== undefined) snap[key] = { kind: 'value', v: sliderValues[i] };
    if (item.type === 'badge' && activeBadges.has(i))         snap[key] = { kind: 'on' };
  });
  return snap;
}

function restoreActiveStates(snap) {
  clearActiveStates();
  CONFIG.forEach((item, i) => {
    const key = `${item.type}:${item.label}`;
    const saved = snap[key];
    if (!saved) return;
    switch (item.type) {
      case 'toggle':   activeToggles.add(i); break;
      case 'options':  if (item.options.includes(saved.v)) optionsValues[i] = saved.v; break;
      case 'dropdown': if (item.options.includes(saved.v)) dropdownValues[i] = saved.v; break;
      case 'button':   activeButtons.add(i); break;
      case 'slider':   sliderValues[i] = saved.v; break;
      case 'badge':    activeBadges.add(i); break;
    }
  });
}

// =============================================
// SHEET IMPORT & LIVE SYNC
// =============================================

function fetchSheetCSV(url) {
  return new Promise((resolve, reject) => {
    const old = document.getElementById('tvc-fetch-request');
    if (old) old.remove();

    const el = document.createElement('div');
    el.id = 'tvc-fetch-request';
    el.style.display = 'none';
    el.dataset.url = url;
    document.body.appendChild(el);

    let attempts = 0;
    const poll = setInterval(() => {
      if (el.dataset.status === 'ok') {
        clearInterval(poll);
        const csv = el.dataset.csv;
        el.remove();
        resolve(csv);
      } else if (el.dataset.status === 'error') {
        clearInterval(poll);
        el.remove();
        reject(new Error('Failed to fetch sheet'));
      } else if (++attempts > 50) {
        clearInterval(poll);
        el.remove();
        reject(new Error('Timed out waiting for sheet'));
      }
    }, 200);
  });
}

async function importFromSheet(url) {
  const csv = await fetchSheetCSV(url);
  const newConfig = csvToConfig(csv);
  if (newConfig.length === 0) throw new Error('No valid controls found in sheet');

  CONFIG = newConfig;
  clearActiveStates();
  saveConfig();
  saveSheetUrl(url);
  lastSheetJSON = JSON.stringify(newConfig);
  return newConfig.length;
}

// Called by the poll loop — re-fetches and only re-renders if config actually changed.
async function refreshFromSheet() {
  if (sheetPollBusy) return;
  sheetPollBusy = true;

  const url = getSavedSheetUrl();
  if (!url) { sheetPollBusy = false; return; }

  try {
    const csv = await fetchSheetCSV(url);
    const newConfig = csvToConfig(csv);
    const newJSON = JSON.stringify(newConfig);

    if (newJSON === lastSheetJSON) {
      // No change — done.
      updateModeBar();          // keep the timestamp fresh
      sheetPollBusy = false;
      return;
    }

    // Config changed — preserve student's active states, swap config, restore.
    const snap = snapshotActiveStates();
    CONFIG = newConfig;
    lastSheetJSON = newJSON;
    saveConfig();
    restoreActiveStates(snap);
    renderControls();
    updateModeBar('updated');
  } catch (e) {
    console.log('Tool vs Chat: sheet refresh failed', e);
    updateModeBar('error');
  }

  sheetPollBusy = false;
}

// =============================================
// CONFIG MODE MANAGEMENT
// =============================================

function setConfigMode(mode) {
  configMode = mode;
  saveConfigMode(mode);

  if (mode === 'sheet') {
    startSheetPolling();
  } else {
    stopSheetPolling();
  }

  updateModeBar();
  renderControls();
}

function startSheetPolling() {
  stopSheetPolling();
  sheetPollInterval = setInterval(refreshFromSheet, SHEET_POLL_MS);
}

function stopSheetPolling() {
  if (sheetPollInterval) {
    clearInterval(sheetPollInterval);
    sheetPollInterval = null;
  }
}

function disconnectFromSheet() {
  if (!confirm('Disconnect from the Google Sheet? Your current controls will be kept and you can edit them locally.')) return;
  setConfigMode('local');
  setEditMode(true);
}

function reconnectToSheet() {
  const url = prompt('Paste the published Google Sheet CSV URL:', getSavedSheetUrl());
  if (!url) return;

  updateModeBar('loading');

  importFromSheet(url)
    .then(() => {
      setConfigMode('sheet');
      setEditMode(false);
    })
    .catch(err => {
      alert('Import failed: ' + err.message);
      updateModeBar();
    });
}

// =============================================
// MODE BAR UI
// =============================================

function updateModeBar(status) {
  const bar = document.getElementById('tvc-mode-bar');
  if (!bar) return;

  if (configMode === 'sheet') {
    bar.classList.add('visible');
    bar.classList.remove('local');

    const dot = bar.querySelector('.tvc-mode-dot');
    const label = bar.querySelector('.tvc-mode-label');
    const refreshBtn = bar.querySelector('.tvc-mode-refresh');

    if (status === 'loading') {
      dot.className = 'tvc-mode-dot loading';
      label.textContent = 'Syncing…';
      if (refreshBtn) refreshBtn.disabled = true;
    } else if (status === 'error') {
      dot.className = 'tvc-mode-dot error';
      label.textContent = 'Sync error';
      if (refreshBtn) refreshBtn.disabled = false;
    } else if (status === 'updated') {
      dot.className = 'tvc-mode-dot connected';
      label.textContent = 'Updated just now';
      if (refreshBtn) refreshBtn.disabled = false;
      // Reset label after a few seconds
      setTimeout(() => {
        if (label.textContent === 'Updated just now') {
          label.textContent = 'Linked to Sheet';
        }
      }, 3000);
    } else {
      dot.className = 'tvc-mode-dot connected';
      label.textContent = 'Linked to Sheet';
      if (refreshBtn) refreshBtn.disabled = false;
    }
  } else {
    bar.classList.remove('visible');
    bar.classList.add('local');
  }
}

// =============================================
// BADGE & INJECTION
// =============================================

const BADGE_COLORS = {
  red:    { bg: '#fee2e2', text: '#991b1b' },
  green:  { bg: '#dcfce7', text: '#166534' },
  yellow: { bg: '#fef9c3', text: '#854d0e' },
  blue:   { bg: '#dbeafe', text: '#1e40af' },
  grey:   { bg: '#f3f4f6', text: '#374151' },
  orange: { bg: '#ffedd5', text: '#9a3412' },
  purple: { bg: '#f3e8ff', text: '#6b21a8' }
};

function buildBadgeLatex(label, color) {
  const colors = BADGE_COLORS[color] || BADGE_COLORS.green;
  return `\\(\\colorbox{${colors.bg}}{\\textcolor{${colors.text}}{\\textsf{\\kern4pt ${label} \\kern4pt}}}\\)`;
}

function buildInjectionText() {
  const parts = [];
  let n = 1;

  CONFIG.forEach((item, i) => {
    if (item.type === 'toggle' && activeToggles.has(i)) {
      parts.push(`${n}) "${item.label}": ${item.instruction}`);
      n++;
    }
    if (item.type === 'options' && optionsValues[i] !== undefined) {
      parts.push(`${n}) "${item.label}": ${item.instruction.replace(/\{value\}/g, optionsValues[i])}`);
      n++;
    }
    if (item.type === 'dropdown' && dropdownValues[i] !== undefined) {
      parts.push(`${n}) "${item.label}": ${item.instruction.replace(/\{value\}/g, dropdownValues[i])}`);
      n++;
    }
    if (item.type === 'button' && activeButtons.has(i)) {
      parts.push(`${n}) "${item.label}": ${item.instruction}`);
      n++;
    }
    if (item.type === 'slider' && sliderValues[i] !== undefined) {
      parts.push(`${n}) "${item.label}": ${item.instruction.replace(/\{value\}/g, sliderValues[i])}`);
      n++;
    }
    if (item.type === 'badge' && activeBadges.has(i)) {
      const latex = buildBadgeLatex(item.label, item.color);
      parts.push(`${n}) Badge "${item.label}": If ${item.instruction}, end your response with the following on its own line: ${latex} — do not modify this formatting. If the condition is not met, do not include it.`);
      n++;
    }
  });

  if (parts.length === 0) {
    return `[PANEL INSTRUCTIONS: No style instructions are active. Ignore any panel instructions from previous messages in this conversation and respond normally.]`;
  }
  return `[PANEL INSTRUCTIONS: Follow ONLY these instructions, ignoring any panel instructions from previous messages. ${parts.join(' ')}]`;
}

function hasInjectableControls() {
  return CONFIG.some(item =>
    item.type === 'toggle' || item.type === 'options' || item.type === 'dropdown' ||
    item.type === 'button' || item.type === 'slider' || item.type === 'badge'
  );
}

// =============================================
// FETCH INTERCEPTOR
// =============================================

const originalFetch = window.fetch;

window.fetch = async function(resource, init) {
  const url = resource instanceof Request ? resource.url : resource;

  if (typeof url === 'string' && url.includes('/conversation') && init && init.method === 'POST' && init.body) {
    try {
      if (hasInjectableControls()) {
        let body = JSON.parse(init.body);
        if (body.messages && body.messages.length > 0) {
          const lastMessage = body.messages[body.messages.length - 1];
          if (lastMessage.content && lastMessage.content.parts && lastMessage.content.parts.length > 0) {
            const injection = buildInjectionText();
            if (injection) {
              for (let i = 0; i < lastMessage.content.parts.length; i++) {
                if (typeof lastMessage.content.parts[i] === 'string') {
                  lastMessage.content.parts[i] += '\n\n' + injection;
                  break;
                }
              }
            }
          }
        }
        init.body = JSON.stringify(body);
      }
    } catch (e) {
      console.log('Tool vs Chat: could not modify request', e);
    }
  }

  const response = await originalFetch.apply(this, arguments);

  if (typeof url === 'string' && url.includes('/conversation') &&
      response.headers.get('content-type')?.includes('text/event-stream')) {
    const clonedResponse = response.clone();
    (async () => {
      try {
        const reader = clonedResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.v?.message?.metadata?.model_slug) {
                currentModel = parsed.v.message.metadata.model_slug;
                updateDisplays();
              }
              if (parsed.v && Array.isArray(parsed.v)) {
                for (const patch of parsed.v) {
                  if (patch.p === '/message/metadata/token_count') {
                    currentTokenCount = patch.v;
                    updateDisplays();
                  }
                }
              }
              if (parsed.type === 'server_ste_metadata' && parsed.metadata?.cluster_region) {
                currentDatacenter = lookupDatacenter(parsed.metadata.cluster_region);
                currentModel = parsed.metadata.model_slug || currentModel;
                updateDisplays();
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    })();
  }

  return response;
};

// =============================================
// DOM CLEANER
// =============================================

function cleanUserMessages() {
  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
  userMessages.forEach(msg => {
    const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
      if (INJECTION_PATTERN.test(node.textContent)) {
        node.textContent = node.textContent.replace(INJECTION_PATTERN, '');
      }
    }
  });
}

function startCleaning() {
  const observer = new MutationObserver(() => cleanUserMessages());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  let lastUrl = window.location.href;
  setInterval(() => {
    if (lastUrl !== window.location.href) {
      lastUrl = window.location.href;
      setTimeout(cleanUserMessages, 2000);
    }
  }, 1000);
}

// =============================================
// WORD COUNTING & DISPLAY
// =============================================

function countWords() {
  const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
  let total = 0;
  assistantMessages.forEach(msg => {
    const text = msg.textContent.trim();
    if (text) total += text.split(/\s+/).length;
  });
  return total;
}

function getDisplayValue(source) {
  switch (source) {
    case 'model_slug': return currentModel;
    case 'token_count': return currentTokenCount.toLocaleString();
    case 'datacenter': return currentDatacenter ? `${currentDatacenter.name} (${currentDatacenter.short})` : '—';
    case 'word_count': return countWords().toLocaleString();
    default: return '—';
  }
}

function updateDisplays() {
  CONFIG.forEach((item, i) => {
    if (item.type === 'display') {
      const valueEl = document.getElementById(`tvc-display-value-${i}`);
      if (valueEl) valueEl.textContent = getDisplayValue(item.source);
    }
  });
}

// =============================================
// CONTROL UI BUILDERS
// =============================================

function buildToggle(item, index) {
  const el = document.createElement('div');
  el.className = 'tvc-control tvc-toggle-row' + (activeToggles.has(index) ? ' active' : '');
  el.innerHTML = `
    <div class="tvc-slider"><div class="tvc-slider-knob"></div></div>
    <span class="tvc-label">${item.label}</span>
    <div class="tvc-tooltip">${item.instruction}</div>
  `;
  el.addEventListener('click', () => {
    if (isEditMode) return;
    if (activeToggles.has(index)) { activeToggles.delete(index); el.classList.remove('active'); }
    else { activeToggles.add(index); el.classList.add('active'); }
  });
  return el;
}

function buildOptions(item, index) {
  const el = document.createElement('div');
  el.className = 'tvc-control tvc-options-row';
  const currentVal = optionsValues[index];

  const header = document.createElement('div');
  header.className = 'tvc-control-header';
  header.innerHTML = `
    <span class="tvc-label">${item.label}</span>
    <span class="tvc-options-value" id="tvc-options-val-${index}">${currentVal || 'Off'}</span>
    <div class="tvc-tooltip">${item.instruction.replace(/\{value\}/g, '___')}</div>
  `;
  el.appendChild(header);

  const track = document.createElement('div');
  track.className = 'tvc-options-track';

  ['off', ...item.options].forEach(opt => {
    const stop = document.createElement('button');
    stop.className = 'tvc-options-stop';
    if ((opt === 'off' && !currentVal) || currentVal === opt) stop.classList.add('active');
    stop.textContent = opt === 'off' ? 'Off' : opt;
    stop.addEventListener('click', () => {
      if (isEditMode) return;
      track.querySelectorAll('.tvc-options-stop').forEach(s => s.classList.remove('active'));
      stop.classList.add('active');
      if (opt === 'off') delete optionsValues[index];
      else optionsValues[index] = opt;
      document.getElementById(`tvc-options-val-${index}`).textContent = optionsValues[index] || 'Off';
    });
    track.appendChild(stop);
  });

  el.appendChild(track);
  return el;
}

function buildDropdown(item, index) {
  const el = document.createElement('div');
  el.className = 'tvc-control tvc-dropdown-row';
  el.innerHTML = `
    <span class="tvc-label">${item.label}</span>
    <div class="tvc-tooltip">${item.instruction.replace(/\{value\}/g, '___')}</div>
  `;
  const select = document.createElement('select');
  select.className = 'tvc-select';
  select.innerHTML = `<option value="">Off</option>` +
    item.options.map(o => `<option value="${o}" ${dropdownValues[index] === o ? 'selected' : ''}>${o}</option>`).join('');
  select.addEventListener('change', () => {
    if (isEditMode) return;
    if (select.value === '') delete dropdownValues[index];
    else dropdownValues[index] = select.value;
  });
  el.appendChild(select);
  return el;
}

function buildButton(item, index) {
  const el = document.createElement('button');
  el.className = 'tvc-control tvc-button' + (activeButtons.has(index) ? ' active' : '');
  el.innerHTML = `
    <span>${item.label}</span>
    <div class="tvc-tooltip">${item.instruction}</div>
  `;
  el.addEventListener('click', () => {
    if (isEditMode) return;
    if (activeButtons.has(index)) { activeButtons.delete(index); el.classList.remove('active'); }
    else { activeButtons.add(index); el.classList.add('active'); }
  });
  return el;
}

function buildSlider(item, index) {
  const min = parseFloat(item.options[0]) || 0;
  const max = parseFloat(item.options[1]) || 100;
  const step = parseFloat(item.options[2]) || 1;
  let isOff = sliderValues[index] === undefined;

  const el = document.createElement('div');
  el.className = 'tvc-control tvc-slider-row';

  const labelRow = document.createElement('div');
  labelRow.className = 'tvc-control-header';
  labelRow.innerHTML = `
    <span class="tvc-label">${item.label}</span>
    <span class="tvc-slider-value" id="tvc-slider-val-${index}">${isOff ? 'Off' : sliderValues[index]}</span>
    <div class="tvc-tooltip">${item.instruction.replace(/\{value\}/g, '___')}</div>
  `;
  el.appendChild(labelRow);

  const row = document.createElement('div');
  row.className = 'tvc-slider-input-row';

  const offBtn = document.createElement('button');
  offBtn.className = 'tvc-slider-off' + (isOff ? ' active' : '');
  offBtn.textContent = 'Off';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'tvc-slider-input' + (isOff ? ' inactive' : '');
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = isOff ? min : sliderValues[index];

  function activate() {
    isOff = false;
    offBtn.classList.remove('active');
    input.classList.remove('inactive');
    sliderValues[index] = input.value;
    document.getElementById(`tvc-slider-val-${index}`).textContent = input.value;
  }

  function deactivate() {
    isOff = true;
    delete sliderValues[index];
    offBtn.classList.add('active');
    input.classList.add('inactive');
    input.value = min;
    document.getElementById(`tvc-slider-val-${index}`).textContent = 'Off';
  }

  offBtn.addEventListener('click', () => { if (!isEditMode) deactivate(); });
  input.addEventListener('input', () => {
    if (isEditMode) return;
    if (isOff) activate();
    sliderValues[index] = input.value;
    document.getElementById(`tvc-slider-val-${index}`).textContent = input.value;
  });
  input.addEventListener('mousedown', () => { if (!isEditMode && isOff) activate(); });

  row.appendChild(offBtn);
  row.appendChild(input);
  el.appendChild(row);

  const bounds = document.createElement('div');
  bounds.className = 'tvc-slider-bounds';
  bounds.innerHTML = `<span>${min}</span><span>${max}</span>`;
  el.appendChild(bounds);

  return el;
}

function buildDisplay(item, index) {
  const el = document.createElement('div');
  el.className = 'tvc-control tvc-display-row';
  el.innerHTML = `
    <span class="tvc-display-label">${item.label}</span>
    <span class="tvc-display-value" id="tvc-display-value-${index}">${getDisplayValue(item.source)}</span>
  `;
  return el;
}

function buildBadge(item, index) {
  const colors = BADGE_COLORS[item.color] || BADGE_COLORS.green;
  const el = document.createElement('div');
  el.className = 'tvc-control tvc-toggle-row tvc-badge-toggle' + (activeBadges.has(index) ? ' active' : '');
  el.innerHTML = `
    <div class="tvc-slider"><div class="tvc-slider-knob"></div></div>
    <span class="tvc-badge-pill" style="background:${colors.bg}; color:${colors.text}">${item.label}</span>
    <div class="tvc-tooltip">Appears if: ${item.instruction}</div>
  `;
  el.addEventListener('click', () => {
    if (isEditMode) return;
    if (activeBadges.has(index)) { activeBadges.delete(index); el.classList.remove('active'); }
    else { activeBadges.add(index); el.classList.add('active'); }
  });
  return el;
}

// =============================================
// CONTROL MANAGEMENT
// =============================================

function clearActiveStates() {
  activeToggles.clear();
  activeButtons.clear();
  activeBadges.clear();
  Object.keys(optionsValues).forEach(k => delete optionsValues[k]);
  Object.keys(dropdownValues).forEach(k => delete dropdownValues[k]);
  Object.keys(sliderValues).forEach(k => delete sliderValues[k]);
}

function deleteControl(index) {
  CONFIG.splice(index, 1);
  clearActiveStates();
  saveConfig();
  renderControls();
}

function moveControl(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= CONFIG.length) return;
  const temp = CONFIG[index];
  CONFIG[index] = CONFIG[newIndex];
  CONFIG[newIndex] = temp;
  clearActiveStates();
  saveConfig();
  renderControls();
}

// =============================================
// EDIT MODAL
// =============================================

let modalEl = null;

function createModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'tvc-modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'tvc-modal';
  modal.addEventListener('click', e => e.stopPropagation());

  modal.innerHTML = `
    <h3 id="tvc-modal-title">Add Control</h3>

    <div class="tvc-form-group" id="tvc-field-type">
      <label>Type</label>
      <div class="tvc-type-grid">
        <div class="tvc-type-card" data-type="toggle"><div class="tvc-type-icon">⇅</div><div class="tvc-type-name">Toggle</div></div>
        <div class="tvc-type-card" data-type="options"><div class="tvc-type-icon">◧</div><div class="tvc-type-name">Options</div></div>
        <div class="tvc-type-card" data-type="dropdown"><div class="tvc-type-icon">▾</div><div class="tvc-type-name">Dropdown</div></div>
        <div class="tvc-type-card" data-type="slider"><div class="tvc-type-icon">─●─</div><div class="tvc-type-name">Slider</div></div>
        <div class="tvc-type-card" data-type="display"><div class="tvc-type-icon">◉</div><div class="tvc-type-name">Display</div></div>
        <div class="tvc-type-card" data-type="badge"><div class="tvc-type-icon">●</div><div class="tvc-type-name">Badge</div></div>
      </div>
    </div>

    <div class="tvc-form-group" id="tvc-field-label" style="display:none">
      <label>Label</label>
      <input type="text" id="tvc-input-label" placeholder="e.g. Be Funny">
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-instruction">
      <label>Instruction</label>
      <textarea id="tvc-input-instruction" placeholder="e.g. Always be really funny and tell jokes."></textarea>
      <span class="tvc-form-hint" id="tvc-instruction-hint"></span>
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-options">
      <label>Options</label>
      <input type="text" id="tvc-input-options" placeholder="e.g. casual, neutral, formal">
      <span class="tvc-form-hint">Comma-separated choices</span>
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-source">
      <label>Data Source</label>
      <select id="tvc-input-source">
        <option value="model_slug">Model</option>
        <option value="token_count">Token Count</option>
        <option value="datacenter">Datacenter</option>
        <option value="word_count">Word Count</option>
      </select>
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-color">
      <label>Color</label>
      <select id="tvc-input-color">
        <option value="yellow">Yellow</option>
        <option value="green">Green</option>
        <option value="red">Red</option>
        <option value="blue">Blue</option>
        <option value="orange">Orange</option>
        <option value="purple">Purple</option>
        <option value="grey">Grey</option>
      </select>
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-slider-range">
      <label>Range</label>
      <div class="tvc-form-row">
        <div class="tvc-form-group"><input type="number" id="tvc-input-min" placeholder="Min" value="1"></div>
        <div class="tvc-form-group"><input type="number" id="tvc-input-max" placeholder="Max" value="12"></div>
        <div class="tvc-form-group"><input type="number" id="tvc-input-step" placeholder="Step" value="1"></div>
      </div>
    </div>

    <div class="tvc-form-group tvc-conditional" id="tvc-field-preview">
      <label>Preview — what gets injected</label>
      <div class="tvc-preview-box" id="tvc-preview-box"></div>
    </div>

    <div class="tvc-modal-actions">
      <button class="tvc-modal-btn cancel" id="tvc-modal-cancel">Cancel</button>
      <button class="tvc-modal-btn save" id="tvc-modal-save">Add</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modalEl = backdrop;

  // Type card clicks
  modal.querySelectorAll('.tvc-type-card').forEach(card => {
    card.addEventListener('click', () => selectModalType(card.dataset.type));
  });

  // Live preview on input
  ['tvc-input-label', 'tvc-input-instruction', 'tvc-input-options', 'tvc-input-min'].forEach(id => {
    modal.querySelector('#' + id).addEventListener('input', updateModalPreview);
  });

  modal.querySelector('#tvc-modal-cancel').addEventListener('click', closeModal);
  modal.querySelector('#tvc-modal-save').addEventListener('click', saveModalControl);
}

function selectModalType(type) {
  selectedType = type;
  modalEl.querySelectorAll('.tvc-type-card').forEach(c => c.classList.toggle('selected', c.dataset.type === type));

  document.getElementById('tvc-field-label').style.display = 'flex';

  const fields = {
    toggle:   ['tvc-field-instruction'],
    options:  ['tvc-field-instruction', 'tvc-field-options'],
    dropdown: ['tvc-field-instruction', 'tvc-field-options'],
    slider:   ['tvc-field-instruction', 'tvc-field-slider-range'],
    display:  ['tvc-field-source'],
    badge:    ['tvc-field-instruction', 'tvc-field-color'],
  };

  modalEl.querySelectorAll('.tvc-conditional').forEach(c => c.classList.remove('visible'));
  (fields[type] || []).forEach(id => document.getElementById(id).classList.add('visible'));

  const hints = {
    toggle: 'This instruction is injected when the toggle is on.',
    options: 'Use {value} where the selected option should appear.',
    dropdown: 'Use {value} where the selected option should appear.',
    slider: 'Use {value} where the slider number should appear.',
    badge: 'Describe the condition (e.g. "your response contains the word happy").',
    display: '',
  };
  document.getElementById('tvc-instruction-hint').textContent = hints[type] || '';

  if (type !== 'display') document.getElementById('tvc-field-preview').classList.add('visible');

  updateModalPreview();
}

function updateModalPreview() {
  const box = document.getElementById('tvc-preview-box');
  if (!selectedType || selectedType === 'display') { box.textContent = ''; return; }

  const label = document.getElementById('tvc-input-label').value || '(label)';
  const instruction = document.getElementById('tvc-input-instruction').value || '(instruction)';

  let preview;
  if (selectedType === 'toggle' || selectedType === 'badge') {
    preview = `"${label}": ${instruction}`;
  } else if (selectedType === 'options' || selectedType === 'dropdown') {
    const first = (document.getElementById('tvc-input-options').value.split(',')[0] || '').trim() || '___';
    preview = `"${label}": ${instruction.replace(/\{value\}/g, first)}`;
  } else if (selectedType === 'slider') {
    const min = document.getElementById('tvc-input-min').value || '1';
    preview = `"${label}": ${instruction.replace(/\{value\}/g, min)}`;
  } else {
    preview = `"${label}": ${instruction}`;
  }

  box.innerHTML = `<strong>Injected text:</strong> ${preview}`;
}

function resetModalFields() {
  selectedType = null;
  modalEl.querySelectorAll('.tvc-type-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('tvc-field-label').style.display = 'none';
  modalEl.querySelectorAll('.tvc-conditional').forEach(c => c.classList.remove('visible'));
  document.getElementById('tvc-input-label').value = '';
  document.getElementById('tvc-input-instruction').value = '';
  document.getElementById('tvc-input-options').value = '';
  document.getElementById('tvc-input-min').value = '1';
  document.getElementById('tvc-input-max').value = '12';
  document.getElementById('tvc-input-step').value = '1';
  document.getElementById('tvc-input-source').value = 'model_slug';
  document.getElementById('tvc-input-color').value = 'yellow';
  document.getElementById('tvc-preview-box').textContent = '';
}

function openAddModal() {
  editingIndex = null;
  resetModalFields();
  document.getElementById('tvc-modal-title').textContent = 'Add Control';
  document.getElementById('tvc-modal-save').textContent = 'Add';
  modalEl.classList.add('open');
}

function openEditModal(index) {
  editingIndex = index;
  const item = CONFIG[index];
  resetModalFields();
  document.getElementById('tvc-modal-title').textContent = 'Edit Control';
  document.getElementById('tvc-modal-save').textContent = 'Save';

  selectModalType(item.type);
  document.getElementById('tvc-input-label').value = item.label;
  document.getElementById('tvc-input-instruction').value = item.instruction;
  document.getElementById('tvc-input-source').value = item.source;
  document.getElementById('tvc-input-color').value = item.color || 'yellow';

  if (item.type === 'slider') {
    document.getElementById('tvc-input-min').value = item.options[0] || 0;
    document.getElementById('tvc-input-max').value = item.options[1] || 100;
    document.getElementById('tvc-input-step').value = item.options[2] || 1;
  } else {
    document.getElementById('tvc-input-options').value = item.options.join(', ');
  }

  updateModalPreview();
  modalEl.classList.add('open');
}

function closeModal() {
  modalEl.classList.remove('open');
}

function saveModalControl() {
  if (!selectedType) return;
  const label = document.getElementById('tvc-input-label').value.trim();
  if (!label) { document.getElementById('tvc-input-label').focus(); return; }

  const item = {
    type: selectedType,
    label: label,
    source: selectedType === 'display' ? document.getElementById('tvc-input-source').value : '',
    instruction: document.getElementById('tvc-input-instruction').value.trim(),
    options: [],
    color: selectedType === 'badge' ? document.getElementById('tvc-input-color').value : '',
  };

  if (selectedType === 'options' || selectedType === 'dropdown') {
    item.options = document.getElementById('tvc-input-options').value.split(',').map(o => o.trim()).filter(o => o);
  } else if (selectedType === 'slider') {
    item.options = [
      document.getElementById('tvc-input-min').value,
      document.getElementById('tvc-input-max').value,
      document.getElementById('tvc-input-step').value,
    ];
  }

  if (editingIndex !== null) {
    CONFIG[editingIndex] = item;
  } else {
    CONFIG.push(item);
  }

  saveConfig();
  closeModal();
  renderControls();
}

// =============================================
// IMPORT MODAL
// =============================================

function showImportUI() {
  const url = prompt('Paste the published Google Sheet CSV URL:', getSavedSheetUrl());
  if (!url) return;

  const statusEl = document.createElement('div');
  statusEl.className = 'tvc-import-status loading';
  statusEl.textContent = 'Loading from Google Sheet…';

  const controls = document.getElementById('tvc-controls');
  controls.appendChild(statusEl);

  importFromSheet(url)
    .then(count => {
      statusEl.remove();
      setConfigMode('sheet');
      setEditMode(false);
    })
    .catch(err => {
      statusEl.className = 'tvc-import-status error';
      statusEl.textContent = 'Import failed: ' + err.message;
      setTimeout(() => statusEl.remove(), 4000);
    });
}

// =============================================
// RENDER
// =============================================

function renderControls() {
  const controls = document.getElementById('tvc-controls');
  const clearBtn = document.getElementById('tvc-clear');
  const addBtn = document.getElementById('tvc-add-control');
  const importBtn = document.getElementById('tvc-edit-import');
  controls.innerHTML = '';

  // In sheet mode, hide local-edit-only buttons; show sheet-specific ones
  const isSheet = configMode === 'sheet';

  if (addBtn)    addBtn.style.display = (isEditMode && !isSheet) ? 'block' : 'none';
  if (importBtn) importBtn.style.display = isEditMode ? 'block' : 'none';

  // Update import button text based on mode
  if (importBtn) {
    importBtn.textContent = isSheet ? 'Re-import from Sheet' : 'Import from Google Sheet';
  }

  // Empty state
  if (CONFIG.length === 0 && !isEditMode) {
    clearBtn.style.display = 'none';
    // Hide header buttons on the initial setup screen
    document.getElementById('tvc-edit-toggle').style.display = 'none';
    document.getElementById('tvc-presets-toggle').style.display = 'none';
    controls.innerHTML = `
      <div class="tvc-empty-state">
        <div class="tvc-empty-title">No controls configured</div>
        <div class="tvc-empty-text">Paste a Google Sheet URL from your instructor to load controls, or start from scratch.</div>
        <input type="text" class="tvc-sheet-input" id="tvc-empty-url" placeholder="https://docs.google.com/spreadsheets/d/e/...">
        <button class="tvc-import-btn" id="tvc-empty-import">Load from Sheet</button>
        <div class="tvc-import-error" id="tvc-empty-error"></div>
        <div class="tvc-empty-divider"><span>or</span></div>
        <button class="tvc-start-blank" id="tvc-empty-blank">Start from scratch</button>
      </div>
    `;

    document.getElementById('tvc-empty-import').addEventListener('click', handleEmptyImport);
    document.getElementById('tvc-empty-url').addEventListener('keydown', e => {
      if (e.key === 'Enter') handleEmptyImport();
    });
    document.getElementById('tvc-empty-blank').addEventListener('click', () => {
      setConfigMode('local');
      setEditMode(true);
    });
    return;
  }

  clearBtn.style.display = '';
  // Show header buttons when controls are loaded
  document.getElementById('tvc-edit-toggle').style.display = '';
  document.getElementById('tvc-presets-toggle').style.display = '';

  // Empty edit mode (no controls yet but in edit mode)
  if (CONFIG.length === 0 && isEditMode) {
    const hint = document.createElement('div');
    hint.className = 'tvc-empty-text';
    hint.style.padding = '12px 8px';
    hint.textContent = 'Click "+ Add Control" below to create your first control.';
    controls.appendChild(hint);
    return;
  }

  // Sheet-mode edit info
  if (isSheet && isEditMode) {
    // Hide the fixed banner — we'll show an inline one after the disconnect box
    const banner = document.querySelector('.tvc-mode-banner');
    if (banner) banner.style.display = 'none';

    const info = document.createElement('div');
    info.className = 'tvc-sheet-edit-info';
    info.innerHTML = `
      <span>Controls are managed by the linked Google Sheet. To edit controls locally, disconnect first.</span>
      <button class="tvc-disconnect-btn" id="tvc-disconnect-btn">Disconnect from Sheet</button>
    `;
    controls.appendChild(info);
    document.getElementById('tvc-disconnect-btn').addEventListener('click', disconnectFromSheet);

    // Inline edit banner below the disconnect box
    const inlineBanner = document.createElement('div');
    inlineBanner.className = 'tvc-mode-banner';
    inlineBanner.style.display = 'block';
    inlineBanner.textContent = 'EDITING CONTROLS';
    controls.appendChild(inlineBanner);
  } else {
    // Restore the fixed banner's normal CSS-driven visibility
    const banner = document.querySelector('.tvc-mode-banner');
    if (banner) banner.style.display = '';
  }

  // Render controls
  let lastType = null;
  CONFIG.forEach((item, index) => {
    if (item.type === 'display' && lastType && lastType !== 'display') {
      const sep = document.createElement('div');
      sep.className = 'tvc-separator';
      controls.appendChild(sep);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tvc-control-wrapper';

    // Edit overlay — only for local mode
    if (!isSheet) {
      const overlay = document.createElement('div');
      overlay.className = 'tvc-edit-overlay';
      wrapper.appendChild(overlay);

      // Edit action buttons
      const actions = document.createElement('div');
      actions.className = 'tvc-edit-actions';

      if (index > 0) {
        const upBtn = document.createElement('button');
        upBtn.className = 'tvc-edit-action tvc-act-move';
        upBtn.textContent = '▲';
        upBtn.title = 'Move up';
        upBtn.addEventListener('click', e => { e.stopPropagation(); moveControl(index, -1); });
        actions.appendChild(upBtn);
      }
      if (index < CONFIG.length - 1) {
        const dnBtn = document.createElement('button');
        dnBtn.className = 'tvc-edit-action tvc-act-move';
        dnBtn.textContent = '▼';
        dnBtn.title = 'Move down';
        dnBtn.addEventListener('click', e => { e.stopPropagation(); moveControl(index, 1); });
        actions.appendChild(dnBtn);
      }

      const editBtn = document.createElement('button');
      editBtn.className = 'tvc-edit-action tvc-act-edit';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', e => { e.stopPropagation(); openEditModal(index); });
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'tvc-edit-action tvc-act-delete';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', e => { e.stopPropagation(); deleteControl(index); });
      actions.appendChild(delBtn);

      wrapper.appendChild(actions);
    }

    // Build the actual control
    let control;
    switch (item.type) {
      case 'toggle':   control = buildToggle(item, index); break;
      case 'options':  control = buildOptions(item, index); break;
      case 'dropdown': control = buildDropdown(item, index); break;
      case 'button':   control = buildButton(item, index); break;
      case 'slider':   control = buildSlider(item, index); break;
      case 'display':  control = buildDisplay(item, index); break;
      case 'badge':    control = buildBadge(item, index); break;
      default:
        control = document.createElement('div');
        control.className = 'tvc-unknown';
        control.textContent = `Unknown type: ${item.type}`;
    }

    wrapper.appendChild(control);
    controls.appendChild(wrapper);
    lastType = item.type;
  });
}

function handleEmptyImport() {
  const urlInput = document.getElementById('tvc-empty-url');
  const errorEl = document.getElementById('tvc-empty-error');
  const btn = document.getElementById('tvc-empty-import');
  const url = urlInput.value.trim();

  if (!url) { urlInput.focus(); return; }

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Loading…';

  importFromSheet(url)
    .then(() => {
      setConfigMode('sheet');
      setEditMode(false);
    })
    .catch(err => {
      errorEl.textContent = 'Import failed: ' + err.message;
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Load from Sheet';
    });
}

// =============================================
// EDIT MODE
// =============================================

function setEditMode(on) {
  isEditMode = on;
  const panel = document.getElementById('tvc-panel');
  const btn = document.getElementById('tvc-edit-toggle');
  if (on) {
    panel.classList.add('editing');
    btn.classList.add('active');
    togglePresetsPanel(false);
  } else {
    panel.classList.remove('editing');
    btn.classList.remove('active');
  }
  renderControls();
}

function toggleEditMode() {
  setEditMode(!isEditMode);
}

// =============================================
// MAIN UI
// =============================================

function createUI() {
  const panel = document.createElement('div');
  panel.id = 'tvc-panel';

  // Tab
  const tab = document.createElement('button');
  tab.id = 'tvc-tab';
  tab.textContent = '›';
  tab.addEventListener('click', () => {
    const isOpen = !panel.classList.contains('closed');
    if (isOpen) {
      panel.classList.add('closed');
      tab.textContent = '‹';
    } else {
      panel.classList.remove('closed');
      tab.textContent = '›';
    }
  });
  panel.appendChild(tab);

  // Header
  const header = document.createElement('div');
  header.id = 'tvc-header';

  const title = document.createElement('span');
  title.id = 'tvc-title';
  title.textContent = 'Tool vs Chat';
  header.appendChild(title);

  const headerButtons = document.createElement('div');
  headerButtons.className = 'tvc-header-buttons';

  const editBtn = document.createElement('button');
  editBtn.className = 'tvc-header-btn';
  editBtn.id = 'tvc-edit-toggle';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit controls';
  editBtn.addEventListener('click', toggleEditMode);
  headerButtons.appendChild(editBtn);

  const presetsBtn = document.createElement('button');
  presetsBtn.className = 'tvc-header-btn';
  presetsBtn.id = 'tvc-presets-toggle';
  presetsBtn.textContent = '☆';
  presetsBtn.title = 'Presets';
  presetsBtn.addEventListener('click', () => togglePresetsPanel());
  headerButtons.appendChild(presetsBtn);

  header.appendChild(headerButtons);
  panel.appendChild(header);

  // Mode bar (sheet sync indicator)
  const modeBar = document.createElement('div');
  modeBar.id = 'tvc-mode-bar';
  modeBar.innerHTML = `
    <div class="tvc-mode-bar-left">
      <span class="tvc-mode-dot connected"></span>
      <span class="tvc-mode-label">Linked to Sheet</span>
    </div>
    <button class="tvc-mode-refresh" title="Refresh now">↻</button>
  `;
  modeBar.querySelector('.tvc-mode-refresh').addEventListener('click', () => {
    updateModeBar('loading');
    refreshFromSheet();
  });
  panel.appendChild(modeBar);

  // Presets panel (toggles open/closed)
  const presetsPanel = document.createElement('div');
  presetsPanel.id = 'tvc-presets-panel';
  presetsPanel.innerHTML = `
    <div class="tvc-presets-header">
      <span class="tvc-presets-title">Presets</span>
      <button class="tvc-presets-save" id="tvc-presets-save-btn">Save current ＋</button>
    </div>
    <div class="tvc-presets-list" id="tvc-presets-list"></div>
  `;
  panel.appendChild(presetsPanel);

  // Wire up save button after panel is in DOM
  setTimeout(() => {
    const saveBtn = document.getElementById('tvc-presets-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const name = prompt('Name this preset:');
        if (!name || name.trim() === '') return;
        saveCurrentAsPreset(name.trim());
      });
    }
  }, 0);

  // Mode banner (edit mode)
  const banner = document.createElement('div');
  banner.className = 'tvc-mode-banner';
  banner.textContent = 'EDITING CONTROLS';
  panel.appendChild(banner);

  // Controls container
  const controls = document.createElement('div');
  controls.id = 'tvc-controls';
  panel.appendChild(controls);

  // Add control button (visible in edit mode, local only)
  const addBtn = document.createElement('button');
  addBtn.id = 'tvc-add-control';
  addBtn.textContent = '+ Add Control';
  addBtn.addEventListener('click', openAddModal);
  panel.appendChild(addBtn);

  // Import from sheet (visible in edit mode)
  const importBtn = document.createElement('button');
  importBtn.id = 'tvc-edit-import';
  importBtn.textContent = 'Import from Google Sheet';
  importBtn.addEventListener('click', () => {
    if (configMode === 'sheet') {
      // Re-import: just refresh
      reconnectToSheet();
    } else {
      if (CONFIG.length > 0) {
        if (!confirm('This will replace all your current controls with the sheet. Continue?')) return;
      }
      showImportUI();
    }
  });
  panel.appendChild(importBtn);

  // Reset controls (always visible when controls exist)
  const clearBtn = document.createElement('button');
  clearBtn.id = 'tvc-clear';
  clearBtn.textContent = 'Reset Controls';
  clearBtn.addEventListener('click', () => {
    if (!confirm('This will remove all controls, saved data, and any linked Google Sheet. Are you sure?')) return;
    CONFIG = [];
    clearActiveStates();
    clearSavedConfig();
    stopSheetPolling();
    configMode = 'local';
    isEditMode = false;
    const p = document.getElementById('tvc-panel');
    const et = document.getElementById('tvc-edit-toggle');
    if (p) p.classList.remove('editing');
    if (et) et.classList.remove('active');
    updateModeBar();
    renderControls();
  });
  panel.appendChild(clearBtn);

  // Inject DM Mono font
  if (!document.querySelector('link[href*="DM+Mono"]')) {
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&display=swap';
    document.head.appendChild(fontLink);
  }

  document.body.appendChild(panel);

  // Create the edit modal
  createModal();

  // Start DOM cleaner
  startCleaning();

  // Word count updater
  setInterval(() => {
    if (CONFIG.some(c => c.type === 'display' && c.source === 'word_count')) updateDisplays();
  }, 2000);

  // Load saved config and mode
  loadSavedConfig();
  configMode = loadConfigMode();
  lastSheetJSON = JSON.stringify(CONFIG);

  // If in sheet mode, start polling
  if (configMode === 'sheet' && getSavedSheetUrl()) {
    startSheetPolling();
    // Do an immediate refresh to pick up any changes since last session
    setTimeout(refreshFromSheet, 2000);
  }

  updateModeBar();
  renderControls();
}

// =============================================
// INIT
// =============================================

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(createUI, 1000);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(createUI, 1000));
}
