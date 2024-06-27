import React from 'react';
import { BrowserRouter as Router, Route, Routes, Link } from 'react-router-dom';
import HomePage from './HomePage';
import DiscussionPage from './DiscussionPage';
import Auth from './Auth';

const App = () => {
    return (
        <Router>
            <div className="min-h-screen bg-gray-100">
                <nav className="bg-primary text-white p-4">
                    <div className="container mx-auto flex justify-between items-center">
                        <Link to="/" className="text-2xl font-bold">Convora</Link>
                        <div>
                            <Link to="/" className="mr-4 hover:underline">Home</Link>
                            <Link to="/auth" className="hover:underline">Login/Signup</Link>
                        </div>
                    </div>
                </nav>
                <main className="container mx-auto p-4">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/auth" element={<Auth />} />
                        <Route path="/:discussionId" element={<DiscussionPage />} />
                    </Routes>
                </main>
            </div>
        </Router>
    );
};

export default App;
