/**
 * Metis — Firebase 초기화
 *
 * npm 설치: npm install firebase
 * 현재는 번들러 없이 CDN 모듈로 로드합니다.
 * 번들러 도입 시 import 경로를 "firebase/app", "firebase/firestore" 로 바꾸면 됩니다.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAbzAv0TBeWM4iR4Cvnom4syNrxuldfelA",
  authDomain: "metis-timer.firebaseapp.com",
  projectId: "metis-timer",
  storageBucket: "metis-timer.firebasestorage.app",
  messagingSenderId: "693063580246",
  appId: "1:693063580246:web:afd8b62e346a1cc42dd9f7",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

window.MetisFirebase = {
  app: app,
  db: db,
  firebaseConfig: firebaseConfig,
};

export { app, db, firebaseConfig };
