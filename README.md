# convora
Have better group conversations

A web app for people to have better conversations as a group. Key features include:

You can create a discussion, which generates its own URL. For example, if the app's URL is convora.com and you wanted to discuss AI safety, you could create a discussion and it would create the URL, say convora.com/ai-safety.

From there, users can submit questions and people can vote on how much they agree with them. For example, someone could say, "The biggest risk of AI is through AI weapons" and each person can vote that they strongly agree, agree, are unsure, disagree, or strongly disagree. The app would show the aggregates. That way you could find which statement most people disagree with.

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
