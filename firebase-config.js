// Hidden Queen Chess — Firebase configuration.
//
// This file needs YOUR OWN Firebase project's config before online play
// will work. It takes about 5 minutes and is free. Steps:
//
// 1. Go to https://console.firebase.google.com and sign in with any Google
//    account. Click "Add project", give it any name (e.g. "hidden-queen-
//    chess"), and you can decline Google Analytics if asked — not needed.
//
// 2. Once the project is created, on the project's home screen click the
//    "</>" (Web) icon to register a web app. Give it any nickname. You do
//    NOT need Firebase Hosting for this (you're using GitHub Pages) — just
//    skip that step if offered.
//
// 3. Firebase will show you a `firebaseConfig` object. Copy the values
//    into FIREBASE_CONFIG below, replacing the placeholders.
//
// 4. In the left sidebar, go to Build > Realtime Database > Create
//    Database. Choose any region, and start in **test mode** for now.
//
// 5. Still in Realtime Database, click the "Rules" tab and replace the
//    rules with the block below, then click Publish. This scopes access to
//    a room's own data only, and stops anyone from listing every room:
//
//    {
//      "rules": {
//        "rooms": {
//          "$roomCode": {
//            ".read": true,
//            ".write": true
//          }
//        }
//      }
//    }
//
//    Note: it's normal and safe for FIREBASE_CONFIG's apiKey to be public
//    (committed to a public GitHub repo, visible in browser devtools) —
//    Firebase's actual security boundary is the Realtime Database rules
//    above, not the config values. This is documented Firebase behavior,
//    not a shortcut taken here.
//
// That's it — once this file has real values, "Play Online" will work for
// anyone who loads your GitHub Pages site.

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCSHR42Nst4TbFpGjGuV2CpfyT0AfqPOJc",
  authDomain: "hidden-queen-chess.firebaseapp.com",
  databaseURL: "https://hidden-queen-chess-default-rtdb.firebaseio.com",
  projectId: "hidden-queen-chess",
  storageBucket: "hidden-queen-chess.firebasestorage.app",
  messagingSenderId: "898469313499",
  appId: "1:898469313499:web:7d2ae777597d8931e205fe",
};
