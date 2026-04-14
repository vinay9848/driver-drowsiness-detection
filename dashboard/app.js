const STAGE_GAUGE = {
  idle: 0,
  watching: 10,
  soft: 35,
  hard: 70,
  external: 100,
};

const STAGE_SUB = {
  idle: 'No driver session active',
  watching: 'Driver alert',
  soft: 'Mild fatigue detected',
  hard: 'Strong fatigue — alarm sounding',
  external: 'EMERGENCY — driver unresponsive',
};

let map = null;
let marker = null;
let mapCentered = false;

const elBigStatus  = document.getElementById('bigStatus');
const elStatusSub  = document.getElementById('statusSub');
const elStatusCard = document.getElementById('statusCard');
const elStageVal   = document.getElementById('stageVal');
const elEarVal     = document.getElementById('earVal');
const elMarVal     = document.getElementById('marVal');
const elSessionVal = document.getElementById('sessionVal');
const elGaugeFill  = document.getElementById('gaugeFill');
const elGaugeText  = document.getElementById('gaugeText');
const elGpsInfo    = document.getElementById('gpsInfo');
const elIncidents  = document.getElementById('incidentList');
const elConn       = document.getElementById('connection');

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([20.5937, 78.9629], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
}

function setConnection(state) {
  elConn.textContent = state;
  elConn.className = `connection ${state === 'connected' ? 'online' : 'offline'}`;
}

function fmtSession(seconds) {
  if (!seconds) return '—';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function updateGauge(value) {
  const max = 251;
  const fill = (value / 100) * max;
  elGaugeFill.setAttribute('stroke-dasharray', `${fill} ${max}`);
  const color = value < 30 ? '#4ade80' : value < 70 ? '#fbbf24' : '#f87171';
  elGaugeFill.setAttribute('stroke', color);
  elGaugeText.textContent = value;
}

function fmtNum(v) {
  return (v === null || v === undefined) ? '—' : v.toFixed(3);
}

function applyState(state) {
  const stage = state.stage || 'idle';
  elStageVal.textContent = stage;
  elEarVal.textContent   = fmtNum(state.ear);
  elMarVal.textContent   = fmtNum(state.mar);
  elSessionVal.textContent = fmtSession(state.sessionTime);

  elBigStatus.textContent = stage.toUpperCase();
  elStatusSub.textContent = STAGE_SUB[stage] || '';
  elStatusCard.className = `status-card stage-${stage}`;

  updateGauge(STAGE_GAUGE[stage] ?? 0);

  if (state.gps && state.gps.lat) {
    const ll = [state.gps.lat, state.gps.lon];
    if (!marker) {
      marker = L.marker(ll).addTo(map);
    } else {
      marker.setLatLng(ll);
    }
    if (!mapCentered) {
      map.setView(ll, 15);
      mapCentered = true;
    }
    elGpsInfo.textContent = `${state.gps.lat.toFixed(5)}, ${state.gps.lon.toFixed(5)} (±${Math.round(state.gps.accuracy || 0)}m)`;
  }
}

function renderIncident(inc) {
  const date = new Date((inc.timestamp || 0) * 1000).toLocaleTimeString();
  const snapshotHtml = inc.snapshot
    ? `<img class="snapshot" src="${inc.snapshot}" alt="snapshot">`
    : `<div class="snapshot placeholder">no image</div>`;
  const gpsLine = inc.gps
    ? ` · GPS: ${inc.gps.lat.toFixed(4)}, ${inc.gps.lon.toFixed(4)}`
    : '';

  const div = document.createElement('div');
  div.className = 'incident';
  div.innerHTML = `
    ${snapshotHtml}
    <div class="incident-body">
      <div class="header-row">
        <span class="badge">External alert</span>
        <span class="time">${date}</span>
      </div>
      <div class="details">
        EAR: ${fmtNum(inc.ear)} · MAR: ${fmtNum(inc.mar)}${gpsLine}
      </div>
    </div>
  `;
  return div;
}

function addIncident(inc) {
  const empty = elIncidents.querySelector('.empty');
  if (empty) empty.remove();
  elIncidents.prepend(renderIncident(inc));
}

function loadInitial(snapshot) {
  applyState(snapshot.state);
  if (snapshot.incidents && snapshot.incidents.length > 0) {
    elIncidents.innerHTML = '';
    snapshot.incidents.forEach(addIncident);
  }
}

let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.onopen = () => setConnection('connected');
  es.onerror = () => {
    setConnection('disconnected');
    es.close();
    setTimeout(connect, 3000);
  };
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'snapshot')      loadInitial(msg.data);
      else if (msg.type === 'state')    applyState(msg.data);
      else if (msg.type === 'incident') addIncident(msg.data);
      else if (msg.type === 'reset') {
        elIncidents.innerHTML = '<div class="empty">No incidents recorded.</div>';
        applyState({ stage: 'idle' });
      }
    } catch (err) {
      console.warn('bad message', err);
    }
  };
}

initMap();
connect();
