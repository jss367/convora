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
  ],
  'Multiple Choice': [
    'Which would reassure you most about a powerful AI?',
    'Which would reassure you most',
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
  ],
  Agreement: [
    'Do you agree that remote work is better?',
    'Would you agree that we move too slowly?',
    'Agree or disagree: pineapple belongs on pizza',
    'I think we should ship weekly, do you agree?',
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

test('returns null for statements and unrecognized wording', async () => {
  const { guessQuestionType } = await guesser;
  for (const title of NO_GUESS) {
    assert.equal(guessQuestionType(title), null, String(title));
  }
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
