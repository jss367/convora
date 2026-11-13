# Developer Notes for Convora

## Understanding the Application Structure

Convora uses a single-server setup where the backend Node.js/Express server serves both the API and the built React application.

The frontend is React and the backend is Node.js.

`votes.js` owns transactional response writes, including serialization of
simultaneous poll submissions from the same participant. Brainstorm ideas
remain separate responses. On the wire a `vote` event means "set my answer to
this value" and is safe to repeat; removing an Agreement or Yes/No vote is the
separate `clearVote` event. Both acknowledge with `{ ok }`, which the client uses
to show a saving state until the answer is handled. `question-data.js` owns question validation and stored
value parsing, and `reports.js` builds discussion summaries and printable reports
without database or HTTP access. `client/src/questions/` contains the question
editor, answer components, result charts, and their shared display configuration;
`DiscussionPage.jsx` coordinates discussion state and user actions. Its connection
and room subscriptions live in `client/src/hooks/useDiscussionRoom.js`; participant
identity and ownership live in `useParticipantIdentity.js`, and moderator token
adoption, verification, and revocation live in `useModeratorAccess.js`.
`database.js` applies the schema and startup migrations before the server listens,
preserving their required order and independent parallel group; `discussion-names.js`
shares canonical slug and display-title rules between migrations and live requests.
`logging.js` keeps raw database errors and their potentially sensitive details out
of server logs.

### Results visibility

`discussions.results_visibility` is `after_vote` (the default) or `always`. In
`after_vote` mode the server removes the votes of Agreement, Yes/No and Numerical
questions a viewer has not answered and marks them `resultsHidden`
(`hideUnansweredResults` in `server.js`), so the `questions` payload differs per
participant. `emitQuestions` therefore replaces the room broadcast: it runs one
questions query, builds one view per participant in the room, and sends each
socket its own. A socket is a participant once it has sent `identify`, and a
moderator once `checkModerator` or `claimModerator` has accepted its token; the
token is checked again on every send. In `always` mode it is a single room
broadcast as before. Any new code that changes votes or questions must call
`emitQuestions` and never emit `questions` to the room directly.

The REST endpoints that return results (`summary`, `clusters`, `snapshots`,
`export.csv`, `export.json`, `report.html`) apply the same rule through
`getQuestionsForViewer`. The client identifies the viewer with the
`X-Convora-User` and `X-Convora-Moderator` headers (`client/src/viewer.js`); a
request without them sees only what a participant who has answered nothing sees.

## Running the Application Locally

### Option A: Docker Postgres

1. Start the local PostgreSQL container:
   ```bash
   npm run dev:db
   ```

2. Build the React app (if changes were made to the frontend):
   ```bash
   npm run build
   ```

3. Start the server against Docker Postgres:
   ```bash
   npm run dev:server:docker
   ```

4. Access the application at `http://localhost:3001`

5. Stop Docker Postgres when you are done:
   ```bash
   npm run dev:db:down
   ```

### Option B: Local Postgres

1. Start the PostgreSQL database server:
   ```
   brew services start postgresql@14
   ```

2. Build the React app (if changes were made to the frontend):
   ```
   npm run build
   ```

3. Start the server:
   ```
   node server.js
   ```

4. Access the application at `http://localhost:3001`

## Making Changes

### Frontend Changes
1. Make your changes in the React code
2. Rebuild the React app:
   ```
   npm run build
   ```
3. Restart the server:
   ```
   NODE_ENV=development node server.js
   ```

### Backend Changes
1. Make your changes in the server code
2. Restart the server:
   ```
   NODE_ENV=development node server.js
   ```

## Databases

- Docker name: `convora`
- Docker connect: `psql "postgresql://convora:convora@127.0.0.1:54329/convora"`
- Local name: `convora`
- Local connect: `psql -U julius -d convora`

### See tables

* `\dt`

* `\d+ questions`


### Connect to remote database

`heroku pg:psql`

## Tests

This repo has a Postgres-backed integration harness that starts Docker Compose,
boots the real server on an ephemeral port, and verifies both HTTP and Socket.IO
flows.

Run the full harness:
```bash
npm test
```

Run against an already-running database:
```bash
DATABASE_URL=postgresql://convora:convora@127.0.0.1:54330/convora_test npm run test:node
```

Run lint with `npm run lint`. For browser tests, install Chromium once with
`npx playwright install chromium`, then run:

```bash
KEEP_TEST_DB=1 npm test
DATABASE_URL=postgresql://convora:convora@127.0.0.1:54330/convora_test npm run test:browser
COMPOSE_PROJECT_NAME=convora-test POSTGRES_DB=convora_test POSTGRES_PORT=54330 docker compose down -v --remove-orphans
```

The browser suite builds the client, starts its own server on port 4173, and exercises live updates
between two isolated browser sessions. It uses the same disposable-database
guard as the integration tests and cleans up the discussion it creates. Run
the integration and browser suites sequentially when sharing a test database.
GitHub Actions runs all checks on Node 20.15 and the latest Node 20 release.

Connection tests interrupt a real proxied WebSocket, navigate between duplicated
discussions and browser history entries, and grant/revoke moderator access live.
The integration suite also checks legacy interaction-flag upgrades and verifies
that restarting initialization preserves subsequent moderator settings.

The default test harness uses a separate Docker Compose project and port
(`convora-test`, `54330`) from the dev database (`54329`). Set `KEEP_TEST_DB=1`
to leave the test database running after a successful or failed run. The browser
sequence above uses those defaults and explicitly removes only the test project's
containers and volumes afterward; run that cleanup even if a test fails.
Because the tests truncate
tables between cases, they refuse to run unless `DATABASE_URL` points at a
localhost database whose name ends with `_test`; set `ALLOW_NON_TEST_DATABASE=1`
only for a disposable nonstandard test database.

## Production Deployment on Heroku

### Pushing from your git branch to heroku main

* `git add .`
* `git commit -m "Update ..."`
* `git push heroku my_branch:main`

This allows you to be working on a branch, `my_branch`, and push to main in heroku.

Push from a branch might make it a little easier to revert if it doesn't go well, but if you want to push from main, it would be:

`git push heroku main:main`


## Dashboard

* `https://dashboard.heroku.com/apps/convora`

## Other Notes

The client and server are on the same domain, so I don't need to do things like this:
```javascript
const socket = io(SOCKET_URL, {
    withCredentials: true,
});
```

# Shut down

I deleted the PostgreSQL with this: `heroku addons:destroy heroku-postgresql --app convora`

If you want to turn on the app, you'll have to add it back. Before deleting, I downloaded a backup and save it at `/Users/julius/git/convora/latest.dump`.
