const assert = require('node:assert/strict');
const { test } = require('node:test');

const guesser = import('../client/src/questions/guessQuestionType.mjs');

const CASES = {
  Numerical: [
    'How likely is it that X happens?',
    'how likely is it that it rains tomorrow',
    'How many people will attend?',
    'How much should we charge per seat?',
    'How confident are you in this plan?',
    'How long should the meeting run?',
    'What percent of our users are on mobile?',
    'What percentage of cars will be electric by 2035?',
    'What % of the budget should go to research?',
    'What is the probability that AGI arrives by 2030?',
    "What's the likelihood of a recession next year?",
    'What are the odds we ship on time?',
    'What are the chances of rain?',
    'By November 21, 2027, what chance is there that an AI system will be capable of taking control of the U.S. government against its leaders’ wishes, whether or not it tries?',
    'What chance is there of rain?',
    'By what year will fusion power be commercial?',
    'Which year would suit you most?',
    'Which year, if any, would suit you most?',
    'In how many years will this be solved?',
    'By 2030, how likely is a crewed Mars landing?',
    'We ship in June - how confident are you?',
    'Probability that the launch slips',
    'Estimate the number of piano tuners in Chicago',
    'Rate your confidence in the roadmap',
    'On a scale of 1 to 10, how happy are you?',
    'Rank your energy today on a scale from 1 to 5',
    '"How likely is a recession?"',
    '1. How many teams should we have?',
    'How   likely\tis it?',
    'What’s the probability of rain?',
    'What share of the budget should go to training?',
    'If we switch to weekly meetings, how many hours will that save?',
  ],
  'Multiple Choice': [
    'Which would reassure you most about a powerful AI?',
    'Which would reassure you most',
    'Which option would reassure you most?',
    'Which **option** would reassure you *most*?',
    'Which of these would reassure you most?',
    'Which one of these would reassure you most?',
    'Which one of the following choices could reassure you the most?',
    'Which of these options would reassure you most?',
    'Which option, if any, would reassure you most?',
    'Which would you prefer?',
    'Which option do you prefer?',
  ],
  'Yes/No': [
    'Will it rain tomorrow?',
    'Should we adopt a four-day week?',
    'Is remote work better for focus?',
    'Are we ready to launch',
    'Does this plan make sense?',
    'Do you want to meet weekly?',
    'Can we afford a second office?',
    'Would you recommend us to a friend?',
    'Has the pilot been a success?',
    'Have you used the new dashboard?',
    "Isn't this too expensive?",
    "Won't this slow us down?",
    'If we raise prices, will customers leave?',
    "Remote work is here to stay, isn't it?",
    'Does it matter how much we spend?',
    'Did we share the training budget with the team?',
    'If we switch to weekly meetings, will that save time?',
    'Is ',
  ],
  'Open Ended': [
    'What are some ways to improve onboarding?',
    'What are good names for the new product?',
    'What should we build next?',
    'What would reassure you most about a powerful AI?',
    'What else could we try?',
    'How might we reduce churn?',
    'How can we make meetings shorter?',
    'What features are we missing?',
    'Which topics should the offsite cover?',
    'Which ideas would help most?',
    'Which ideas would reassure you most?',
    'Which ideas, if any, would reassure you most?',
    'Which suggestions matter most?',
    'Which cities have the most parks?',
    'Any ideas for the team offsite?',
    'Ideas for the holiday party',
    'Ways to cut cloud costs',
    'List some risks we have not discussed',
    'Name three things we should stop doing',
    'Brainstorm names for the mascot',
    'Why did the last launch slip?',
    'How do you feel about the reorg?',
    'How would you describe our culture?',
    'What do you think about the proposal?',
    'What is your biggest concern?',
    'What chance did you wish you had taken?',
    "What's your biggest concern",
    'Which option is best?',
    'Who should lead this project?',
    'When should we revisit this?',
    'Where do we lose the most time?',
    'Describe your ideal work week',
    'Explain why you joined',
    'Tell us about a recent win',
    'Should we do this, and why?',
    'What should we share about the training budget?',
    'If we switch to weekly meetings, what would we lose?',
    'What could we do to agree on a budget?',
  ],
  Agreement: [
    'Do you agree that remote work is better?',
    'Would you agree that we move too slowly?',
    'Agree or disagree: pineapple belongs on pizza',
    'I think we should ship weekly, do you agree?',
    'Weekly meetings would save us time — would you agree?',
  ],
};

// Statements and anything unrecognized: the composer keeps its default type.
const NO_GUESS = [
  '',
  '   ',
  null,
  undefined,
  'Remote work is better than office work',
  'We should adopt a four-day week',
  'Pineapple on pizza?',
  'When AI arrives, jobs will change',
  'What we need is more funding',
  'How we work matters more than where',
  'It does not matter how much we spend',
  'Cats, dogs, and will power',
  'On the agenda: how many hours weekly meetings would save',
  // Half-typed words must not flip the type early.
  'Is',
  'Issues with the roadmap',
  'Willpower is overrated',
  'Howard is the best candidate',
  'Whatever we choose, we should commit',
  'Listening matters more than talking',
];

test('guesses the question type from common wordings', async () => {
  const { guessQuestionType } = await guesser;
  for (const [type, titles] of Object.entries(CASES)) {
    for (const title of titles) {
      assert.equal(guessQuestionType(title), type, title);
    }
  }
});

test('distinguishes polite requests for explanations from yes/no questions', async () => {
  const { guessQuestionType } = await guesser;
  assert.equal(guessQuestionType('Could you describe a time when onboarding went well?'), 'Open Ended');
  assert.equal(guessQuestionType('Can you explain what made onboarding easier?'), 'Open Ended');
  assert.equal(guessQuestionType('Can you tell us what happened?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you please tell me about the problem?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you tell me more about the problem?'), 'Open Ended');
  assert.equal(guessQuestionType('Can you tell us a little about your role?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you tell us your biggest concern?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you tell us your biggest concern if you could choose just one?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you tell us your biggest concern if I asked?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell me if plans changed?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell me the truth if I asked?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell us a secret if you knew one?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell us what happens if plans change?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you please elaborate on that feedback?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you attend the next onboarding session?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you briefly describe your experience?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you please briefly explain what happened?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you usually describe the process to new hires?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you just describe your experience?'), 'Open Ended');
  assert.equal(guessQuestionType('Can you tell us something about your role?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you tell me one thing you would change?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you tell me two things you would change?'), 'Open Ended');
  assert.equal(guessQuestionType('Can you tell us 3 ways to improve the process?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you tell us your biggest concern if we could choose just one?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you tell us something if you knew it?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell me anything if you saw it?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell me the answer if I asked again?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you tell us anything if you could choose one thing?'), 'Open Ended');
});

test('distinguishes a proposed characterization from a request for a description', async () => {
  const { guessQuestionType } = await guesser;
  assert.equal(guessQuestionType('Would you describe your experience as positive?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the process as not useful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the process as not very useful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe meetings as productive?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the course as useful for beginners?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the course as effective in practice?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the meetings as more productive than before?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you briefly describe the meetings as less useful than last year?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe Convora as easy to use?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe what you do as stressful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the pilot as a success?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and explain why?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and its partners?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe climate change as a priority for your organization?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the delay as a problem with capacity?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you describe your responsibilities as a manager?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the situation as it was?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe how meetings changed as the team grew?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe your experience?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe your experience as positive, and why?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe the course as really useful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the course as somewhat useful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the drug as safe and effective?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the guide as clear and useful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the guide as clear and explain why?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the incident as clearly and completely?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe the staff as friendly and helpful?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the course as really useful and engaging?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and provide details?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and give your reasons?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the incident as clearly?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the process as accurately?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe the staff as friendly?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and discuss why?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and outline the reasons?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and show how?'), 'Open Ended');
  assert.equal(guessQuestionType('Would you describe the plan as financially sustainable?'), 'Yes/No');
  assert.equal(guessQuestionType('Would you describe the plan as financially sustainable and clear?'), 'Yes/No');
  assert.equal(guessQuestionType('Could you describe the incident as clearly as possible?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and respond with details?'), 'Open Ended');
  assert.equal(guessQuestionType('Could you describe the pilot as a success for the team and answer in your own words?'), 'Open Ended');
});

test('returns null for statements and unrecognized wording', async () => {
  const { guessQuestionType } = await guesser;
  for (const title of NO_GUESS) {
    assert.equal(guessQuestionType(title), null, String(title));
  }
});

test('uses visible wording to infer the type of an emphasized question', async () => {
  const { guessQuestionType } = await guesser;
  assert.equal(guessQuestionType('*Should* we proceed?'), 'Yes/No');
  assert.equal(guessQuestionType('**How** likely is rain?'), 'Numerical');
});

test('the guess can change as the title is typed', async () => {
  const { guessQuestionType } = await guesser;
  const typed = 'How likely is it?';
  const guesses = [...typed].map((_, i) => guessQuestionType(typed.slice(0, i + 1)));
  // "How" alone is not yet a question; "How likely" is claimed as Numerical
  // before the general "how ..." rule can call it Open Ended.
  assert.equal(guesses[typed.indexOf('w')], null);
  assert.equal(guesses[typed.indexOf('y')], 'Numerical');
  assert.equal(guesses.at(-1), 'Numerical');
});
