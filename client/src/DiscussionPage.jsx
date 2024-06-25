import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Input, Button, Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';

const VoteOptions = {
    STRONGLY_AGREE: 'Strongly Agree',
    AGREE: 'Agree',
    UNSURE: 'Unsure',
    DISAGREE: 'Disagree',
    STRONGLY_DISAGREE: 'Strongly Disagree',
};

const DiscussionPage = () => {
    const { discussionId } = useParams();
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');

    const handleAddQuestion = () => {
        if (newQuestion.trim() !== '') {
            setQuestions([
                ...questions,
                {
                    id: Date.now(),
                    text: newQuestion,
                    votes: {
                        [VoteOptions.STRONGLY_AGREE]: 0,
                        [VoteOptions.AGREE]: 0,
                        [VoteOptions.UNSURE]: 0,
                        [VoteOptions.DISAGREE]: 0,
                        [VoteOptions.STRONGLY_DISAGREE]: 0,
                    },
                },
            ]);
            setNewQuestion('');
        }
    };

    const handleVote = (questionId, option) => {
        setQuestions(
            questions.map((q) =>
                q.id === questionId
                    ? { ...q, votes: { ...q.votes, [option]: q.votes[option] + 1 } }
                    : q
            )
        );
    };

    return (
        <div className="container mx-auto p-4">
            <h1 className="text-2xl font-bold mb-4">Discussion: {discussionId}</h1>
            <div className="mb-4">
                <Input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    placeholder="Enter a new question or statement"
                    className="mr-2"
                />
                <Button onClick={handleAddQuestion}>Add Question</Button>
            </div>
            {questions.map((question) => (
                <Card key={question.id} className="mb-4">
                    <CardHeader>{question.text}</CardHeader>
                    <CardContent>
                        {Object.entries(question.votes).map(([option, count]) => (
                            <div key={option} className="mb-2">
                                <span>{option}: {count}</span>
                                <Button
                                    onClick={() => handleVote(question.id, option)}
                                    className="ml-2"
                                >
                                    Vote
                                </Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
};

export default DiscussionPage;
