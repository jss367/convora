import React from 'react';
import { Link, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import AccountPage, { AccountNav } from './AccountPage';
import ClusterPage from './ClusterPage';
import DiscussionPage from './DiscussionPage';
import DisplayPage from './DisplayPage';
import HomePage from './HomePage';
import SummaryPage from './SummaryPage';

const AppLayout = () => (
    <div className="app">
        <header className="bg-gradient-to-r from-primary to-primary-dark text-white p-4 shadow-md flex items-center justify-between">
            <Link to="/" className="text-white hover:text-gray-200 transition duration-300">
                <h1 className="text-2xl font-bold">Convora</h1>
            </Link>
            <AccountNav />
        </header>
        <main className="container mx-auto p-4">
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/discussion/:topic" element={<DiscussionPage />} />
                <Route path="/discussion/:topic/summary" element={<SummaryPage />} />
                <Route path="/discussion/:topic/clusters" element={<ClusterPage />} />
            </Routes>
        </main>
    </div>
);

const App = () => {
    return (
        <Router>
            <Routes>
                {/* The room display fills a shared screen, without the app header. */}
                <Route path="/discussion/:topic/display" element={<DisplayPage />} />
                <Route path="*" element={<AppLayout />} />
            </Routes>
        </Router>
    );
};

export default App;
