import { firebaseConfig } from '../firebase-config.js';

function resolveSessionId() {
  if (location.hash && location.hash.length > 1) {
    const id = location.hash.slice(1).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    if (id) {
      localStorage.setItem('drowsiness-session-id', id);
      return id;
    }
  }
  let id = localStorage.getItem('drowsiness-session-id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 8);
    localStorage.setItem('drowsiness-session-id', id);
  }
  return id;
}

const SESSION_ID = resolveSessionId();
document.getElementById('sessionId').textContent = SESSION_ID;

const vehicleNameInput = document.getElementById('vehicleName');
let vehicleName = localStorage.getItem('drowsiness-vehicle-name') || `Vehicle ${SESSION_ID}`;
vehicleNameInput.value = vehicleName;
vehicleNameInput.addEventListener('input', () => {
  vehicleName = vehicleNameInput.value.trim() || `Vehicle ${SESSION_ID}`;
  localStorage.setItem('drowsiness-vehicle-name', vehicleName);
});

const EAR_THRESHOLD = 0.22;
const MAR_THRESHOLD = 0.6;

const SOFT_AFTER_MS     = 1000;
const HARD_AFTER_MS     = 3000;
const EXTERNAL_AFTER_MS = 10000;
const RECOVERY_AFTER_MS = 2000;

const NO_FACE_DROWSY_MS = 2000;
const PUSH_INTERVAL_MS  = 1000;

const LEFT_EYE  = [362, 385, 387, 263, 373, 380];
const RIGHT_EYE = [33,  160, 158, 133, 153, 144];
const MOUTH_TOP    = 13;
const MOUTH_BOTTOM = 14;
const MOUTH_LEFT   = 78;
const MOUTH_RIGHT  = 308;

const STAGE = {
  IDLE:     'idle',
  WATCHING: 'watching',
  SOFT:     'soft',
  HARD:     'hard',
  EXTERNAL: 'external',
  STOPPED:  'stopped',
};

const firebaseConfigured =
  firebaseConfig &&
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('YOUR_');

let sync;

if (firebaseConfigured) {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
  const { getDatabase, ref, set, push, onDisconnect } = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js');
  const fbApp = initializeApp(firebaseConfig);
  const db = getDatabase(fbApp);
  const stateRef = ref(db, `sessions/${SESSION_ID}/state`);
  const incidentsRef = ref(db, `sessions/${SESSION_ID}/incidents`);

  onDisconnect(stateRef).set({
    driverOffline: true,
    stage: 'offline',
    name: vehicleName,
    lastUpdate: Date.now(),
  });

  sync = {
    sendState: (data) => set(stateRef, data).catch(e => console.warn('state push failed:', e.message)),
    sendIncident: (data) => push(incidentsRef, data).catch(e => console.warn('incident push failed:', e.message)),
  };
  console.log('Sync: Firebase Realtime Database, session:', SESSION_ID);
} else {
  const ch = new BroadcastChannel('drowsiness-v1');
  sync = {
    sendState: (data) => ch.postMessage({ type: 'state', data }),
    sendIncident: (data) => ch.postMessage({ type: 'incident', data }),
  };
  console.warn('Sync: BroadcastChannel (Firebase not configured — same-device only)');
  document.getElementById('setupWarning').classList.remove('hidden');
}

const video    = document.getElementById('video');
const canvas   = document.getElementById('overlay');
const ctx      = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const earEl    = document.getElementById('ear');
const marEl    = document.getElementById('mar');
const closedEl = document.getElementById('closed');
const alarmAudio = document.getElementById('alarm');

let faceMesh = null;
let running = false;
let cameraStream = null;
let pushStateTimer = null;

let dangerSince   = null;
let recoverySince = null;
let lastFaceSeen  = null;
let stage = STAGE.IDLE;
let alarmPlaying = false;

let lastEar = null;
let lastMar = null;
let lastGps = null;
let sessionStartTime = null;
let lastIncidentTime = 0;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function eyeAspectRatio(landmarks, eye) {
  const p1 = landmarks[eye[0]];
  const p2 = landmarks[eye[1]];
  const p3 = landmarks[eye[2]];
  const p4 = landmarks[eye[3]];
  const p5 = landmarks[eye[4]];
  const p6 = landmarks[eye[5]];
  return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
}

function mouthAspectRatio(landmarks) {
  const vertical   = dist(landmarks[MOUTH_TOP],  landmarks[MOUTH_BOTTOM]);
  const horizontal = dist(landmarks[MOUTH_LEFT], landmarks[MOUTH_RIGHT]);
  return vertical / horizontal;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.pitch = 1;
  u.volume = 1;
  speechSynthesis.speak(u);
}

function triggerAlarm() {
  if (alarmPlaying) return;
  alarmPlaying = true;
  alarmAudio.currentTime = 0;
  alarmAudio.play().catch(err => console.warn('Alarm play blocked:', err));
}

function stopAlarm() {
  if (!alarmPlaying) return;
  alarmPlaying = false;
  alarmAudio.pause();
  alarmAudio.currentTime = 0;
}

function transitionTo(newStage) {
  if (newStage === stage) return;
  const old = stage;
  stage = newStage;
  console.log(`stage: ${old} → ${newStage}`);

  if (newStage === STAGE.WATCHING) {
    setStatus('Watching', 'watching');
    stopAlarm();
    speechSynthesis.cancel();
  } else if (newStage === STAGE.STOPPED) {
    setStatus('Stopped', 'idle');
    stopAlarm();
    speechSynthesis.cancel();
  } else if (newStage === STAGE.SOFT) {
    setStatus('Soft warning', 'soft');
    speak('Stay focused.');
  } else if (newStage === STAGE.HARD) {
    setStatus('Hard alarm', 'hard');
    triggerAlarm();
    speak('Wake up. Pull over.');
  } else if (newStage === STAGE.EXTERNAL) {
    setStatus('Emergency', 'external');
    triggerAlarm();
    speak('Emergency. Driver unresponsive.');
    captureAndPushIncident();
  }
}

function updateStateMachine(isDrowsy) {
  const now = performance.now();

  if (isDrowsy) {
    recoverySince = null;
    if (dangerSince === null) dangerSince = now;
    const dur = now - dangerSince;

    if (dur >= EXTERNAL_AFTER_MS)      transitionTo(STAGE.EXTERNAL);
    else if (dur >= HARD_AFTER_MS)     transitionTo(STAGE.HARD);
    else if (dur >= SOFT_AFTER_MS)     transitionTo(STAGE.SOFT);
  } else {
    dangerSince = null;
    if (stage !== STAGE.WATCHING && stage !== STAGE.IDLE) {
      if (recoverySince === null) recoverySince = now;
      if (now - recoverySince >= RECOVERY_AFTER_MS) {
        transitionTo(STAGE.WATCHING);
        recoverySince = null;
      }
    }
  }
}

function drawLandmarks(landmarks) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#4ade80';
  const indices = [...LEFT_EYE, ...RIGHT_EYE, MOUTH_TOP, MOUTH_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT];
  for (const idx of indices) {
    const p = landmarks[idx];
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function onResults(results) {
  const now = performance.now();
  const hasFace = results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0;

  if (hasFace) {
    lastFaceSeen = now;
    const landmarks = results.multiFaceLandmarks[0];
    const leftEAR  = eyeAspectRatio(landmarks, LEFT_EYE);
    const rightEAR = eyeAspectRatio(landmarks, RIGHT_EYE);
    const avgEAR   = (leftEAR + rightEAR) / 2;
    const mar      = mouthAspectRatio(landmarks);

    lastEar = avgEAR;
    lastMar = mar;
    earEl.textContent = avgEAR.toFixed(3);
    marEl.textContent = mar.toFixed(3);

    const eyesClosed = avgEAR < EAR_THRESHOLD;
    const yawning    = mar > MAR_THRESHOLD;
    const isDrowsy   = eyesClosed || yawning;

    closedEl.textContent = eyesClosed ? 'closed' : 'open';
    drawLandmarks(landmarks);
    updateStateMachine(isDrowsy);
  } else {
    earEl.textContent = '—';
    marEl.textContent = '—';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (lastFaceSeen === null) {
      closedEl.textContent = 'no face';
      return;
    }

    const noFaceFor = now - lastFaceSeen;
    closedEl.textContent = `no face ${(noFaceFor / 1000).toFixed(1)}s`;

    const isDrowsy = noFaceFor >= NO_FACE_DROWSY_MS;
    updateStateMachine(isDrowsy);
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  cameraStream = stream;
  video.srcObject = stream;
  await new Promise(resolve => {
    video.onloadedmetadata = () => {
      video.play();
      resolve();
    };
  });
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
}

const IP_SERVICES = [
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: d => (d && d.latitude && d.longitude) ? { lat: d.latitude, lon: d.longitude, city: d.city } : null,
  },
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: d => (d && d.success && d.latitude && d.longitude) ? { lat: d.latitude, lon: d.longitude, city: d.city } : null,
  },
  {
    name: 'freeipapi',
    url: 'https://freeipapi.com/api/json',
    parse: d => (d && d.latitude && d.longitude) ? { lat: d.latitude, lon: d.longitude, city: d.cityName } : null,
  },
  {
    name: 'geolocation-db',
    url: 'https://geolocation-db.com/json/',
    parse: d => (d && d.latitude && d.longitude && d.latitude !== 'Not found') ? { lat: parseFloat(d.latitude), lon: parseFloat(d.longitude), city: d.city } : null,
  },
];

let driverMap = null;
let driverMarker = null;
let driverMapCentered = false;

function initDriverMap() {
  if (driverMap) return;
  if (!window.L) {
    console.error('Leaflet not loaded — cannot init driver map');
    return;
  }
  try {
    driverMap = L.map('driverMap', { zoomControl: true, attributionControl: false }).setView([20.5937, 78.9629], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(driverMap);
    driverMap.on('click', (e) => {
      setManualLocation(e.latlng.lat, e.latlng.lng, true);
    });
    setTimeout(() => driverMap && driverMap.invalidateSize(), 100);
    setTimeout(() => driverMap && driverMap.invalidateSize(), 500);
    console.log('Driver map initialized');
  } catch (err) {
    console.error('Driver map init failed:', err);
  }
}

async function searchCity(query) {
  const q = query.trim();
  if (!q) return;
  console.log('City search:', q);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    if (!results || results.length === 0) {
      alert(`No results for "${q}". Try a different search term.`);
      return;
    }
    const r = results[0];
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    console.log('City search result:', r.display_name, lat, lon);
    setManualLocation(lat, lon, true);
  } catch (e) {
    console.error('City search failed:', e);
    alert(`Search failed: ${e.message}\n\nTry tapping the map manually, or check your network.`);
  }
}

function placeDriverMarker(lat, lon) {
  if (!driverMap) return;
  const ll = [lat, lon];
  if (!driverMarker) {
    driverMarker = L.marker(ll, { draggable: true }).addTo(driverMap);
    driverMarker.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      setManualLocation(pos.lat, pos.lng, false);
    });
  } else {
    driverMarker.setLatLng(ll);
  }
  if (!driverMapCentered) {
    driverMap.setView(ll, 13);
    driverMapCentered = true;
  }
}

function setManualLocation(lat, lon, panTo) {
  lastGps = { lat, lon, accuracy: 0, source: 'manual' };
  localStorage.setItem('drowsiness-manual-location', JSON.stringify({ lat, lon }));
  placeDriverMarker(lat, lon);
  if (panTo && driverMap) driverMap.setView([lat, lon], Math.max(driverMap.getZoom(), 13));
  updateLocationDisplay();
  console.log('Manual location set:', lat, lon);
}

function loadSavedManualLocation() {
  const saved = localStorage.getItem('drowsiness-manual-location');
  if (!saved) return false;
  try {
    const { lat, lon } = JSON.parse(saved);
    if (typeof lat === 'number' && typeof lon === 'number') {
      lastGps = { lat, lon, accuracy: 0, source: 'manual' };
      placeDriverMarker(lat, lon);
      console.log('Loaded saved manual location:', lat, lon);
      return true;
    }
  } catch (e) {}
  return false;
}

function updateLocationDisplay() {
  const sourceEl = document.getElementById('locationSource');
  const tileEl = document.getElementById('location');

  let label = 'searching…';
  let color = '#9aa3b8';

  if (lastGps) {
    if (lastGps.source === 'gps') {
      label = 'device GPS ✓';
      color = '#4ade80';
    } else if (lastGps.source === 'manual') {
      label = 'manual pin';
      color = '#3b82f6';
    } else {
      label = `IP · ${(lastGps.source || '').replace('ip:', '')}`;
      color = '#fbbf24';
    }
  }

  if (sourceEl) {
    sourceEl.textContent = label;
    sourceEl.style.color = color;
  }
  if (tileEl) {
    tileEl.textContent = lastGps
      ? (lastGps.source === 'gps' ? 'gps ✓'
        : lastGps.source === 'manual' ? 'manual'
        : (lastGps.source || '').replace('ip:', ''))
      : 'searching…';
    tileEl.style.color = color;
  }

  if (lastGps) placeDriverMarker(lastGps.lat, lastGps.lon);
}

async function fetchIpLocation() {
  for (const svc of IP_SERVICES) {
    try {
      const res = await fetch(svc.url);
      if (!res.ok) {
        console.warn(`${svc.name}: HTTP ${res.status}`);
        continue;
      }
      const d = await res.json();
      const result = svc.parse(d);
      if (result) {
        lastGps = {
          lat: result.lat,
          lon: result.lon,
          accuracy: 5000,
          source: `ip:${result.city || 'unknown'}`,
        };
        console.log(`IP location (${svc.name}):`, result.city, result.lat, result.lon);
        updateLocationDisplay();
        return true;
      }
      console.warn(`${svc.name}: no usable data`);
    } catch (e) {
      console.warn(`${svc.name} failed:`, e.message);
    }
  }
  return false;
}

async function startGps() {
  const hasManual = lastGps && lastGps.source === 'manual';

  if (!hasManual) {
    let ipOk = await fetchIpLocation();
    if (!ipOk) {
      setTimeout(async () => {
        if (lastGps && lastGps.source === 'manual') return;
        ipOk = await fetchIpLocation();
        if (!ipOk) setTimeout(() => {
          if (!lastGps || lastGps.source !== 'manual') fetchIpLocation();
        }, 10000);
      }, 5000);
    }
  }

  if (!('geolocation' in navigator)) {
    console.warn('navigator.geolocation not available');
    return;
  }

  navigator.geolocation.watchPosition(
    pos => {
      if (lastGps && lastGps.source === 'manual') return;
      lastGps = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        source: 'gps',
      };
      console.log('GPS upgrade:', pos.coords.latitude, pos.coords.longitude);
      updateLocationDisplay();
      const banner = document.getElementById('gpsWarning');
      if (banner) banner.classList.add('hidden');
    },
    err => {
      console.warn('Browser GPS error:', err.code, err.message);
      const banner = document.getElementById('gpsWarning');
      if (banner && err.code === err.PERMISSION_DENIED) {
        banner.classList.remove('hidden');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

try {
  document.getElementById('useGpsBtn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      alert('Geolocation is not supported by this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        localStorage.removeItem('drowsiness-manual-location');
        lastGps = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: 'gps',
        };
        driverMapCentered = false;
        updateLocationDisplay();
        console.log('Device GPS:', pos.coords.latitude, pos.coords.longitude);
      },
      err => {
        alert(`Could not get device GPS: ${err.message}\n\nUse the search box or tap the map to set your location manually.`);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  const citySearchInput = document.getElementById('citySearch');
  document.getElementById('citySearchBtn').addEventListener('click', () => {
    searchCity(citySearchInput.value);
  });
  citySearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchCity(citySearchInput.value);
    }
  });

  initDriverMap();
  loadSavedManualLocation();
  updateLocationDisplay();

  if (!lastGps) {
    fetchIpLocation().then(ok => {
      if (!ok) console.warn('Initial IP location fetch failed; user can search or tap manually');
    });
  }
} catch (initErr) {
  console.error('Location init failed:', initErr);
}

function pushState() {
  if (!running) return;
  sync.sendState({
    stage,
    name: vehicleName,
    ear: lastEar,
    mar: lastMar,
    gps: lastGps,
    sessionTime: sessionStartTime ? (performance.now() - sessionStartTime) / 1000 : 0,
    lastUpdate: Date.now(),
  });
}

function captureAndPushIncident() {
  const now = performance.now();
  if (now - lastIncidentTime < 5000) return;
  lastIncidentTime = now;

  let snapshot = null;
  if (video.videoWidth > 0) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    snapshot = c.toDataURL('image/jpeg', 0.6);
  }

  sync.sendIncident({
    id: `inc-${Date.now()}`,
    timestamp: Date.now() / 1000,
    stage: 'external',
    ear: lastEar,
    mar: lastMar,
    gps: lastGps,
    sessionTime: sessionStartTime ? (performance.now() - sessionStartTime) / 1000 : 0,
    snapshot,
  });
}

async function processLoop() {
  if (!running) return;
  if (video.readyState >= 2) {
    await faceMesh.send({ image: video });
  }
  requestAnimationFrame(processLoop);
}

async function startMonitoring() {
  startBtn.disabled = true;
  setStatus('Loading model…', 'loading');
  startBtn.textContent = 'Loading…';

  try {
    if (!faceMesh) {
      faceMesh = new FaceMesh({
        locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMesh.onResults(onResults);
    }

    setStatus('Starting camera…', 'loading');
    await startCamera();
    startGps();

    running = true;
    sessionStartTime = performance.now();
    transitionTo(STAGE.WATCHING);
    startBtn.textContent = 'Stop monitoring';
    startBtn.disabled = false;
    processLoop();
    pushStateTimer = setInterval(pushState, PUSH_INTERVAL_MS);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, 'error');
    startBtn.disabled = false;
    startBtn.textContent = 'Start monitoring';
  }
}

function stopMonitoring() {
  if (!running) return;
  running = false;

  if (pushStateTimer !== null) {
    clearInterval(pushStateTimer);
    pushStateTimer = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  dangerSince = null;
  recoverySince = null;
  lastFaceSeen = null;
  lastEar = null;
  lastMar = null;
  earEl.textContent = '—';
  marEl.textContent = '—';
  closedEl.textContent = '—';

  transitionTo(STAGE.STOPPED);

  sync.sendState({
    stage: STAGE.STOPPED,
    name: vehicleName,
    ear: null,
    mar: null,
    gps: lastGps,
    sessionTime: sessionStartTime ? (performance.now() - sessionStartTime) / 1000 : 0,
    lastUpdate: Date.now(),
  });

  sessionStartTime = null;
  startBtn.textContent = 'Start monitoring';
  startBtn.disabled = false;
}

startBtn.addEventListener('click', () => {
  if (running) stopMonitoring();
  else startMonitoring();
});
