import React, { useState } from 'react';
import { auth } from './firebase';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';

const Auth = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const signUp = async () => {
        try {
            await createUserWithEmailAndPassword(auth, email, password);
            console.log('User signed up successfully');
        } catch (error) {
            console.error('Error signing up:', error.message);
        }
    };

    const signIn = async () => {
        try {
            await signInWithEmailAndPassword(auth, email, password);
            console.log('User signed in successfully');
        } catch (error) {
            console.error('Error signing in:', error.message);
        }
    };

    const handleSignOut = async () => {
        try {
            await signOut(auth);
            console.log('User signed out successfully');
        } catch (error) {
            console.error('Error signing out:', error.message);
        }
    };

    return (
        <div className="max-w-md mx-auto mt-8 p-6 bg-white rounded-lg shadow-xl">
            <h2 className="text-2xl font-bold mb-4">Authentication</h2>
            <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="w-full p-2 mb-4 border rounded"
            />
            <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full p-2 mb-4 border rounded"
            />
            <button onClick={signUp} className="w-full p-2 mb-2 bg-blue-500 text-white rounded hover:bg-blue-600">Sign Up</button>
            <button onClick={signIn} className="w-full p-2 mb-2 bg-green-500 text-white rounded hover:bg-green-600">Sign In</button>
            <button onClick={handleSignOut} className="w-full p-2 bg-red-500 text-white rounded hover:bg-red-600">Sign Out</button>
        </div>
    );
};

export default Auth;
