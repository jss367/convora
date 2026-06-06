import React from 'react';
import { Link, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import ClusterPage from './ClusterPage';
import DiscussionPage from './DiscussionPage';
import HomePage from './HomePage';
import SummaryPage from './SummaryPage';

const App = () => {
    return (
        <Router>
            <div className="app">
                <header className="bg-gradient-to-r from-primary to-primary-dark text-white p-4 shadow-md">
                    <Link to="/" className="text-white hover:text-gray-200 transition duration-300">
                        <h1 className="text-2xl font-bold">Convora</h1>
                    </Link>
                </header>
                <main className="container mx-auto p-4">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/discussion/:topic" element={<DiscussionPage />} />
                        <Route path="/discussion/:topic/summary" element={<SummaryPage />} />
                        <Route path="/discussion/:topic/clusters" element={<ClusterPage />} />
                    </Routes>
                </main>
            </div>
        </Router>
    );
};

export default App;
