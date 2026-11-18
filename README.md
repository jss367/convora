# convora
Have better group conversations

A web app for people to have better conversations as a group. Key features include:

You can create a discussion, which generates its own URL. For example, if the app's URL is convora.com and you wanted to discuss AI safety, you could create a discussion and it would create the URL, say convora.com/ai-safety.

From there, users can submit questions and people can vote on how much they agree with them. For example, someone could say, "The biggest risk of AI is through AI weapons" and each person can vote that they strongly agree, agree, are unsure, disagree, or strongly disagree. The app would show the aggregates. That way you could find which statement most people disagree with.

## Multiple choice questions

Choose **Multiple Choice** as the question type to write your own answers, for
example "In the last year, did your p(doom) get higher or lower?" with
**Higher**, **Lower** and **About the same**. Each participant picks one answer,
and can change or undo it like an Agreement or Yes/No vote.

- A question has 2 to 6 options of up to 100 characters each. Options must be
  different from each other, ignoring case and extra spaces.
- Results show one bar per option, in the order you wrote them, with each
  option's count and share of the vote.
- Like every question, a moderator can edit it only until someone answers, so
  the options can't change under people who already voted. To change them after
  that, delete the question and ask it again.
- Multiple choice answers are categories, not a scale, so they aren't counted
  in the agreement sorts, the consensus and divisive rankings, or opinion
  groups. They do appear in the summary, exports, the room display and opinion
  snapshots.

## Mark the questions you want to discuss

Every question has a ▲ button with a count next to its title. Press it to say
you find the question interesting, and press it again to take that back. Each
participant counts once per question, and nobody can see who pressed it.

To rank the list by that count, choose **Most Interesting** in the sort menu
above the questions. Questions with the same count stay newest first, and
pinned questions stay on top. The sort is each viewer's own choice, so it does
not change what other people see. Locking a discussion closes these marks along
with voting.

## Queue questions and publish them one at a time

A moderator can write questions ahead of time without showing them to the
room. In the Add Question form, tick **Add to the queue**. The box stays ticked
from one question to the next, so a whole agenda can be entered in a row.

Queued questions are listed under **Queued questions** on the moderator's page,
in the order they were written. Only moderators receive them: participants, the
room display, the summary, exports and snapshots do not. Nobody can answer a
queued question, and it can be edited or deleted like any question without
responses.

Click **Publish** on a queued question to show it to everyone and open it for
answers. It arrives as the newest question, so it is first under **Most
Recent**. Publishing cannot be undone, because hiding a question again would
hide the answers people gave to it; delete the question instead. A locked
discussion publishes nothing until it is unlocked.

When a moderator duplicates a discussion, the copy keeps its queued questions
queued, so a prepared agenda can be reused. A copy made by anyone else leaves
the queued questions out.

## Discussions are unlisted unless you list them

A new discussion is unlisted: it's reachable only through its link or short
link, so share the link with the people you want to take part. To let anyone
find it, turn on **Listed publicly** in the moderator controls. Listed
discussions appear under **Public Discussions** on the home page, newest first.
Turn it off to take a discussion off the list; its link keeps working either way. A
duplicated discussion starts unlisted.

The home page shows **Your Discussions**: the ones this browser created or
opened, remembered in the browser's local storage. Clearing site data or using
another browser or device empties that list; the discussions themselves are
unaffected and still open from their links.

Unlisted is not private: links are derived from the discussion title, and anyone
who has or guesses a link can read and take part.

## Results appear after you vote

For Agreement, Yes/No, Multiple Choice and Numerical questions, a participant sees the tallies,
percentages and histogram only for questions they have answered. Seeing the
room's answer first pulls people toward it, and it would spoil the "before"
half of an opinion snapshot. Undoing a vote hides that question's results again.

A moderator can change this in the moderator controls, under **Results shown**:

- **After voting** is the default, for new and existing discussions.
- **Always** shows every result to everyone.

With **Show results after you vote**, a moderator can also reveal one question
at a time: click **Show results** on the question to show its results to
everyone now, whether or not they have voted, and **Hide results** to go back.
This is the usual way to run a live poll: collect votes, then reveal the answer
to discuss it.

Moderators always see results. The setting also applies to the summary, opinion
groups, opinion snapshots and exports: each leaves out the results of questions
the person viewing has not answered and says how many were left out. Open Ended questions are not affected. Their responses are the discussion
itself, not a tally, and response reactions keep their own moderator toggles.

## Numerical answers can be decimals

A Numerical question has a whole-number minimum and maximum. An answer can be
any number between them, with up to two decimal places: drag the slider for a
whole number, or type a number such as 0.5 or 33.25 in the box next to it. A
decimal comma (0,5) is read the same as a decimal point, because many phone
keypads offer only a comma. More than two decimal places are rounded.

## Room display

To show a discussion on a shared TV or projector while people vote on their
phones, click **Open room display** in the moderator controls. This opens
`/discussion/<discussion>/display` in a new tab. It shows the discussion title, a
large QR code and join link, the questions as they come in, how many people are
here now, and how many responses each question has.

You don't need moderator access to open it. On a TV or projector that joined
with the ordinary link, choose **More ▾ → Open room display**, which switches
that tab to the display.

The display is read-only. It doesn't count as a participant, can't vote or add
anything, and never uses a moderator's access, even when opened from the
moderator's browser. It follows the **Results** setting:

- With **Show results after you vote**, the server sends the display each
  question's response count but no tallies, percentages or histograms. The
  display has not voted, so it sees what a participant who has not voted sees.
- With **Always show results**, it shows the live results as charts sized for
  the room: a labelled bar with count and percentage for each agreement,
  yes/no or multiple choice option, and a histogram with the average and median
  for numerical questions. While results are hidden, a multiple choice question
  still lists its options under the response count.

Two moderator settings change the display from wherever the moderator is
sitting, so nobody has to touch the shared screen:

- **Display QR**: the join QR code and link **Large** in a sidebar (the
  default), **Small, in a corner** of the header, or **Hidden**.
- **Display shows**: **All questions** (the default), or **One question**
  filling the screen.

To choose the one question, click **Show on display** on it from your own
moderator page. The display switches to the one-question view if it was listing
every question, and the button reads **On display** on the question the room is
looking at. The question stays on the screen until you choose another one, so a
new question from a participant does not replace it. Click **On display** to
stop showing it; the display then shows the first pinned question, or the
newest one when nothing is pinned. It does the same if you delete the question.

To put one question's results on the screen, click **Show results** on that
question from your own moderator page, phone or laptop. The display updates at
once. Anyone with the link can open the display, so a revealed question's
results are shown to every participant too. **Hide results** takes them off the
screen again.

Open Ended responses appear on the display as they do for
participants. Response ratings and reactions appear only when the moderator has
made them visible.

While the display is open and visible, it asks the browser to keep the screen
awake, as a video player does, so the TV or laptop doesn't dim or go to sleep
partway through a discussion. It holds a Screen Wake Lock where the browser
supports one (current Chrome, Edge, Safari and Firefox, on HTTPS pages), and also
plays a tiny muted video on a loop, because smart TVs can ignore the wake lock or
have a built-in browser without it, but don't sleep during video playback. A TV's
own power settings, such as an auto power-off timer, can still turn it off.

## Compare opinions before and after discussion

Open **Opinion Snapshots** in a discussion. A moderator can save named snapshots
such as “Before discussion” and “After discussion.” For probability estimates,
create a **Numerical** question with a minimum of **0** and maximum of **100**.
Answers can be decimals, so a participant can enter 0.5 for half a percent.
Collect initial answers, save the first snapshot, then invite people to update
their answers after discussing and save the second snapshot.

Choose an earlier and later snapshot to compare response counts, distributions,
and numerical averages. Agreement, yes/no, and multiple choice questions are
included too. Everyone
can view the saved results; only moderators can save snapshots, including after
voting closes. Use **Refresh** to load snapshots saved by another moderator.

Snapshots preserve aggregate results even when answers are updated or questions
are edited or deleted. They do not retain participant identities or individual
answer histories. Comparisons describe the group at each point in time;
participants may differ between snapshots. Questions with changed wording,
types, scales, or answer options are flagged and shown separately.


## Tech notes:

This is a React app with a Node.js backend. It uses WebSockets for real-time communication.

## Local development

Start Postgres with Docker Compose:

```bash
npm run dev:db
```

Run the backend against that database:

```bash
npm run dev:server:docker
```

Run the integration harness, which starts an isolated Docker Postgres and tests
the real HTTP and Socket.IO paths:

```bash
npm test
```

Run static checks and the browser regression test:

```bash
npm run lint
npx playwright install chromium
# Start and test the disposable database, keeping it for the browser suite.
KEEP_TEST_DB=1 npm test
DATABASE_URL=postgresql://convora:convora@127.0.0.1:54330/convora_test npm run test:browser
# Remove only the test project's containers and volumes when finished.
COMPOSE_PROJECT_NAME=convora-test POSTGRES_DB=convora_test POSTGRES_PORT=54330 docker compose down -v --remove-orphans
```

These commands use the test harness defaults: project `convora-test`, database
`convora_test`, and port `54330`; the development database uses port `54329`.
`KEEP_TEST_DB=1` retains the test database after successful or failed integration
runs, so run the cleanup command even if a test fails. The browser command builds
the client and starts an isolated test server.

GitHub Actions runs lint, the production build, PostgreSQL integration tests,
and Chromium interaction tests on Node 20.15 and the latest Node 20 release.

## Website

[https://convora-e40a9ae358dc.herokuapp.com/](https://convora-e40a9ae358dc.herokuapp.com/)

https://console.cloud.google.com/welcome?pli=1&inv=1&invt=Ab0Pdg&project=convora-7cba7

## Free-text questions

Open Ended supports multiple responses per participant, with no limit by default.
Question creators can set a maximum number of responses per person and hide author
pseudonyms; pseudonyms are shown by default. Participants can edit or delete their
own responses. Identical responses are allowed, including from the same person.
Moderators can enable quality votes, agreement ratings, reactions, and comments.

Existing Brainstorm questions become Open Ended and retain hidden attribution.
Existing Open Ended questions retain their one-response limit. Responses and
feedback survive migration, with previous upvotes carried over as quality votes.

## Delete a discussion

The creator can choose **More → Delete discussion** and confirm permanent deletion.
This removes the discussion and all its questions, responses, comments, and saved
snapshots for everyone. Connected participants return to the home page and room
displays show that the discussion is gone. Deleted discussion routes stay reserved;
creating the same title later gives it a new link. Promoted
moderators cannot delete discussions. As with other creator controls, anyone with
the creator's saved moderator link has the same authority.
