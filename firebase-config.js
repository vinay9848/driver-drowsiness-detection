// Firebase Realtime Database configuration.
//
// HOW TO SET UP (one-time, ~5 minutes):
//   1. Go to https://console.firebase.google.com → "Add project"
//   2. Name it (e.g. "drowsiness-detection") → Continue → disable Analytics → Create
//   3. Click the </> (Web) icon → register an app (any nickname) → "Register app"
//   4. Copy the firebaseConfig object you see → paste over the placeholder below
//   5. In the left sidebar: "Build" → "Realtime Database" → "Create Database"
//   6. Choose any location → start in TEST MODE → Enable
//   7. Commit + push this file. GitHub Pages auto-rebuilds in ~30 sec.
//
// Notes:
//   - The apiKey is intended to be public — Firebase security comes from
//     Realtime Database rules, not from hiding the key.
//   - Test mode rules expire after 30 days. After that you'll need to update
//     the rules in the Firebase console.

export const firebaseConfig = {
  apiKey: "AIzaSyBQOKNTFTJKiZDjLSGaVYf7EeowWBzVi9s",
  authDomain: "drowsiness-detection-b6d15.firebaseapp.com",
  databaseURL: "https://drowsiness-detection-b6d15-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "drowsiness-detection-b6d15",
  storageBucket: "drowsiness-detection-b6d15.firebasestorage.app",
  messagingSenderId: "496645400723",
  appId: "1:496645400723:web:2fee76534e4bc746bf4566",
};

// All driver/watcher pairs that share this session ID see each other.
// For a single-vehicle MVP, leave as "default". For multiple concurrent
// vehicles, generate a unique ID per vehicle.
export const SESSION_ID = "default";
