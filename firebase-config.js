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
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// All driver/watcher pairs that share this session ID see each other.
// For a single-vehicle MVP, leave as "default". For multiple concurrent
// vehicles, generate a unique ID per vehicle.
export const SESSION_ID = "default";
