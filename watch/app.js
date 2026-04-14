import { firebaseConfig } from '../firebase-config.js';

const STAGE_COLORS = {
  idle:     '#9aa3b8',
  watching: '#4ade80',
  soft:     '#fbbf24',
  hard:     '#f87171',
  external: '#ef4444',
  offline:  '#6b7280',
};

const elFleetStats = document.getElementById('fleetStats');
const elCardsGrid  = document.getElementById('cardsGrid');
const elEmptyCards = document.getElementById('emptyCards');
const elIncidents  = document.getElementById('incidentList');

const drivers = new Map();
const markers = new Map();
const subscribedSessions = new Set();

let map = null;
let mapAutoFitDone = false;

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([20.5937, 78.9629], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
}

function fmtSession(seconds) {
  if (!seconds) return '—';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function fmtNum(v) {
  return (v === null || v === undefined) ? '—' : v.toFixed(3);
}

function getEffectiveStage(state) {
  if (!state) return 'idle';
  if (state.driverOffline || state.stage === 'offline') return 'offline';
  return state.stage || 'idle';
}

function getOrCreateCard(sessionId) {
  let card = document.getElementById(`card-${sessionId}`);
  if (card) return card;

  if (elEmptyCards) elEmptyCards.style.display = 'none';

  card = document.createElement('div');
  card.id = `card-${sessionId}`;
  card.className = 'driver-card stage-idle';
  card.innerHTML = `
    <div class="card-header">
      <span class="vehicle-name">—</span>
      <span class="card-status">IDLE</span>
    </div>
    <div class="session-id">id: ${sessionId}</div>
    <div class="card-metrics">
      <div class="card-metric"><span class="label">EAR</span><span class="value ear-val">—</span></div>
      <div class="card-metric"><span class="label">MAR</span><span class="value mar-val">—</span></div>
      <div class="card-metric"><span class="label">Time</span><span class="value time-val">—</span></div>
    </div>
    <div class="card-gps no-gps">no location</div>
  `;
  card.addEventListener('click', () => {
    if (markers.has(sessionId)) {
      const m = markers.get(sessionId);
      map.setView(m.getLatLng(), 14);
      m.openPopup();
    }
  });
  elCardsGrid.appendChild(card);
  return card;
}

function updateCard(sessionId, state) {
  const card = getOrCreateCard(sessionId);
  const stage = getEffectiveStage(state);
  card.className = `driver-card stage-${stage}`;

  const name = state.name || `Vehicle ${sessionId}`;
  card.querySelector('.vehicle-name').textContent = name;
  card.querySelector('.card-status').textContent = stage.toUpperCase();
  card.querySelector('.ear-val').textContent  = stage === 'offline' ? '—' : fmtNum(state.ear);
  card.querySelector('.mar-val').textContent  = stage === 'offline' ? '—' : fmtNum(state.mar);
  card.querySelector('.time-val').textContent = stage === 'offline' ? '—' : fmtSession(state.sessionTime);

  const gpsEl = card.querySelector('.card-gps');
  if (state.gps && state.gps.lat) {
    gpsEl.textContent = `${state.gps.lat.toFixed(4)}, ${state.gps.lon.toFixed(4)}`;
    gpsEl.classList.remove('no-gps');
  } else {
    gpsEl.textContent = 'no location';
    gpsEl.classList.add('no-gps');
  }
}

function updateMarker(sessionId, state) {
  const stage = getEffectiveStage(state);
  if (!state.gps || !state.gps.lat) {
    if (markers.has(sessionId)) {
      map.removeLayer(markers.get(sessionId));
      markers.delete(sessionId);
    }
    return;
  }

  const ll = [state.gps.lat, state.gps.lon];
  const color = STAGE_COLORS[stage] || '#9aa3b8';
  const name = state.name || `Vehicle ${sessionId}`;

  if (markers.has(sessionId)) {
    const m = markers.get(sessionId);
    m.setLatLng(ll);
    m.setStyle({ color, fillColor: color });
    m.setPopupContent(`<strong>${name}</strong><br>${stage}`);
  } else {
    const m = L.circleMarker(ll, {
      radius: 11,
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 3,
    }).addTo(map);
    m.bindPopup(`<strong>${name}</strong><br>${stage}`);
    markers.set(sessionId, m);

    if (!mapAutoFitDone) {
      map.setView(ll, 12);
      mapAutoFitDone = true;
    }
  }
}

function updateFleetStats() {
  const total = drivers.size;
  let active = 0;
  let danger = 0;
  for (const state of drivers.values()) {
    const stage = getEffectiveStage(state);
    if (stage === 'offline' || stage === 'idle') continue;
    active++;
    if (stage === 'hard' || stage === 'external') danger++;
  }
  if (danger > 0) {
    elFleetStats.innerHTML = `${active} active · <span class="danger">${danger} in danger</span> · ${total} total`;
  } else {
    elFleetStats.textContent = `${active} active · ${total} total`;
  }
}

function handleStateUpdate(sessionId, state) {
  if (!state) return;
  drivers.set(sessionId, state);
  updateCard(sessionId, state);
  updateMarker(sessionId, state);
  updateFleetStats();
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
        <span class="vehicle-tag">${inc._vehicleName || inc._sessionId || 'Unknown'}</span>
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
  if (!inc) return;
  const empty = elIncidents.querySelector('.empty');
  if (empty) empty.remove();
  elIncidents.prepend(renderIncident(inc));
}

initMap();

const firebaseConfigured =
  firebaseConfig &&
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('YOUR_');

if (firebaseConfigured) {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
  const { getDatabase, ref, onValue, onChildAdded, onChildRemoved, query, limitToLast }
    = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js');

  const fbApp = initializeApp(firebaseConfig);
  const db = getDatabase(fbApp);
  const sessionsRef = ref(db, 'sessions');

  function subscribeToSession(sessionId) {
    if (subscribedSessions.has(sessionId)) return;
    subscribedSessions.add(sessionId);

    const stateRef = ref(db, `sessions/${sessionId}/state`);
    onValue(stateRef, (snap) => {
      const state = snap.val();
      if (state) handleStateUpdate(sessionId, state);
    });

    const incRef = query(ref(db, `sessions/${sessionId}/incidents`), limitToLast(20));
    onChildAdded(incRef, (snap) => {
      const inc = snap.val() || {};
      inc._sessionId = sessionId;
      inc._vehicleName = (drivers.get(sessionId) || {}).name || `Vehicle ${sessionId}`;
      addIncident(inc);
    });
  }

  onChildAdded(sessionsRef, (snap) => {
    subscribeToSession(snap.key);
  });

  onChildRemoved(sessionsRef, (snap) => {
    const sessionId = snap.key;
    drivers.delete(sessionId);
    subscribedSessions.delete(sessionId);
    document.getElementById(`card-${sessionId}`)?.remove();
    if (markers.has(sessionId)) {
      map.removeLayer(markers.get(sessionId));
      markers.delete(sessionId);
    }
    updateFleetStats();
    if (drivers.size === 0 && elEmptyCards) {
      elEmptyCards.style.display = 'block';
    }
  });

  console.log('Sync: Firebase Realtime Database — fleet mode');
} else {
  document.getElementById('setupWarning').classList.remove('hidden');
  console.warn('Firebase not configured — fleet dashboard requires Firebase');
}
