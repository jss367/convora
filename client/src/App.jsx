import React from 'react';
import { Link, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import DiscussionPage from './DiscussionPage';
import HomePage from './HomePage';

const App = () => {
    return (
        <Router>
            <div className="app">
                <header className="bg-blue-600 text-white p-4">
                    <Link to="/" className="text-white hover:text-gray-200 transition duration-300">
                        <h1 className="text-2xl font-bold">Convora</h1>
                    </Link>
                </header>
                <main className="container mx-auto p-4">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/discussion/:topic" element={<DiscussionPage />} />
                    </Routes>
                </main>
            </div>
        </Router>
    );
};

export default App;
