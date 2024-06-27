// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyCLqKIHZK1b9LqoYHWrkT2_vQCEXY5-Cb8",
    authDomain: "convora-7cba7.firebaseapp.com",
    projectId: "convora-7cba7",
    storageBucket: "convora-7cba7.appspot.com",
    messagingSenderId: "68061739015",
    appId: "1:68061739015:web:f4a9361b1d1f3ff33052a2",
    measurementId: "G-3K2ZY0948V"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);
export const db = getFirestore(app);
export const auth = getAuth(app);
