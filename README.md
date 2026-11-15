# convora
Have better group conversations

A web app for people to have better conversations as a group. Key features include:

You can create a discussion, which generates its own URL. For example, if the app's URL is convora.com and you wanted to discuss AI safety, you could create a discussion and it would create the URL, say convora.com/ai-safety.

From there, users can submit questions and people can vote on how much they agree with them. For example, someone could say, "The biggest risk of AI is through AI weapons" and each person can vote that they strongly agree, agree, are unsure, disagree, or strongly disagree. The app would show the aggregates. That way you could find which statement most people disagree with.

## Discussions are unlisted unless you list them

A new discussion is unlisted: it's reachable only through its link or short
link, so share the link with the people you want to take part. To let anyone
find it, tick **List publicly on this page** when you create it, or click
**List publicly** in the moderator bar later. Listed discussions appear under
**Public Discussions** on the home page, newest first. Click **Listed publicly**
to take a discussion off the list; its link keeps working either way. A
duplicated discussion starts unlisted.

The home page shows **Your Discussions**: the ones this browser created or
opened, remembered in the browser's local storage. Clearing site data or using
another browser or device empties that list; the discussions themselves are
unaffected and still open from their links.

Unlisted is not private: links are derived from the discussion title, and anyone
who has or guesses a link can read and take part.

## Results appear after you vote

For Agreement, Yes/No and Numerical questions, a participant sees the tallies,
percentages and histogram only for questions they have answered. Seeing the
room's answer first pulls people toward it, and it would spoil the "before"
half of an opinion snapshot. Undoing a vote hides that question's results again.

A moderator can change this in the moderator bar, under **Results**:

- **Show results after you vote** is the default, for new and existing discussions.
- **Always show results** shows every result to everyone.

With **Show results after you vote**, a moderator can also reveal one question
at a time: click **Show results** on the question to show its results to
everyone now, whether or not they have voted, and **Hide results** to go back.
This is the usual way to run a live poll: collect votes, then reveal the answer
to discuss it.

Moderators always see results. The setting also applies to the summary, opinion
groups, opinion snapshots and exports: each leaves out the results of questions
the person viewing has not answered and says how many were left out. Open Ended
and Brainstorm questions are not affected. Their responses are the discussion
itself, not a tally, and Brainstorm reactions keep their own moderator toggles.

## Room display

To show a discussion on a shared TV or projector while people vote on their
phones, click **Open room display** in the moderator bar. This opens
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
- With **Always show results**, it shows the live results.

To put one question's results on the screen, click **Show results** on that
question from your own moderator page, phone or laptop. The display updates at
once. Anyone with the link can open the display, so a revealed question's
results are shown to every participant too. **Hide results** takes them off the
screen again.

Open Ended and Brainstorm responses appear on the display as they do for
participants. Brainstorm ratings and reactions appear only when the moderator has
made them visible.

While the display is open and visible, it asks the browser to keep the screen
awake, as a video player does, so the TV or laptop doesn't dim or go to sleep
partway through a discussion. This uses the Screen Wake Lock API, which current
Chrome, Edge, Safari and Firefox support on HTTPS pages. Older browsers sleep as
usual.

## Compare opinions before and after discussion

Open **Opinion Snapshots** in a discussion. A moderator can save named snapshots
such as “Before discussion” and “After discussion.” For probability estimates,
create a **Numerical** question with a minimum of **0** and maximum of **100**.
Collect initial answers, save the first snapshot, then invite people to update
their answers after discussing and save the second snapshot.

Choose an earlier and later snapshot to compare response counts, distributions,
and numerical averages. Agreement and yes/no questions are included too. Everyone
can view the saved results; only moderators can save snapshots, including after
voting closes. Use **Refresh** to load snapshots saved by another moderator.

Snapshots preserve aggregate results even when answers are updated or questions
are edited or deleted. They do not retain participant identities or individual
answer histories. Comparisons describe the group at each point in time;
participants may differ between snapshots. Questions with changed wording,
types, or scales are flagged and shown separately.


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
