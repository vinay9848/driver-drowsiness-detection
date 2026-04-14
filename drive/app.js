import { firebaseConfig, SESSION_ID } from '../firebase-config.js';

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

async function fetchIpLocation() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res.ok) {
      const d = await res.json();
      if (d && d.latitude && d.longitude) {
        lastGps = {
          lat: d.latitude,
          lon: d.longitude,
          accuracy: 5000,
          source: `ip:${d.city || 'unknown'}`,
        };
        console.log('IP location (ipapi.co):', d.city, d.latitude, d.longitude);
        return;
      }
    }
  } catch (e) {
    console.warn('ipapi.co failed:', e.message);
  }

  try {
    const res = await fetch('https://ipwho.is/');
    if (res.ok) {
      const d = await res.json();
      if (d && d.success && d.latitude && d.longitude) {
        lastGps = {
          lat: d.latitude,
          lon: d.longitude,
          accuracy: 5000,
          source: `ip:${d.city || 'unknown'}`,
        };
        console.log('IP location (ipwho.is):', d.city, d.latitude, d.longitude);
        return;
      }
    }
  } catch (e) {
    console.warn('ipwho.is failed:', e.message);
  }

  console.warn('All IP location services failed — no fallback location');
}

function startGps() {
  fetchIpLocation();

  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(
    pos => {
      lastGps = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        source: 'gps',
      };
      console.log('GPS upgrade:', pos.coords.latitude, pos.coords.longitude);
    },
    err => console.warn('Browser GPS unavailable:', err.message, '— using IP fallback'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function pushState() {
  if (!running) return;
  sync.sendState({
    stage,
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

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('Loading model…', 'loading');
  startBtn.textContent = 'Loading…';

  try {
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

    setStatus('Starting camera…', 'loading');
    await startCamera();
    startGps();

    running = true;
    sessionStartTime = performance.now();
    transitionTo(STAGE.WATCHING);
    startBtn.textContent = 'Monitoring';
    processLoop();
    setInterval(pushState, PUSH_INTERVAL_MS);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, 'error');
    startBtn.disabled = false;
    startBtn.textContent = 'Start monitoring';
  }
});
