import React from 'react';
import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import DiscussionPage from './DiscussionPage';
import HomePage from './HomePage';

const App = () => {
    return (
        <Router>
            <div className="app">
                <header className="bg-blue-600 text-white p-4">
                    <h1 className="text-2xl font-bold">Convora</h1>
                </header>
                <main className="container mx-auto p-4">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/:topic" element={<DiscussionPage />} />
                    </Routes>
                </main>
            </div>
        </Router>
    );
};

export default App;


