# Developer Notes for Convora

## Understanding the Application Structure

Convora uses a single-server setup where the backend Node.js/Express server serves both the API and the built React application.

The frontend is React and the backend is Node.js.

`votes.js` owns transactional response writes, including serialization of
simultaneous poll submissions from the same participant. Open Ended responses
are independent rows. Their `vote` payload is `{ text, requestId }` for creation
or `{ text, responseId }` for an owned edit. Request IDs prevent transport retries
from creating extra rows; matching text is deliberately allowed. Per-person limits
are checked under the same participant/question lock as insertion. Question fields
`maxResponses` (null for unlimited) and `showAttribution` persist and copy with the
question. Attribution is stripped on the server when disabled.
For polls, a `vote` event means "set my answer to this value" and is safe to repeat; removing an Agreement or Yes/No vote is the
separate `clearVote` event. Both acknowledge with `{ ok }`, which the client uses
to show a saving state until the answer is handled. `question-data.js` owns question validation and stored
value parsing, and `reports.js` builds discussion summaries and printable reports
without database or HTTP access. `client/src/questions/` contains the question
editor, answer components, result charts, and their shared display configuration;
`DiscussionPage.jsx` coordinates discussion state and user actions. `QuestionComposer.jsx`
renders the question form and duplicate prompt; `composerLifecycle.mjs` handles draft
changes and acknowledgments. `client/src/hooks/pendingVotes.mjs` tracks sent and
buffered votes across disconnects. Connection and room subscriptions live in
`client/src/hooks/useDiscussionRoom.js`; participant
identity and ownership live in `useParticipantIdentity.js`, and moderator token
adoption, verification, and revocation live in `useModeratorAccess.js`.
The moderator's controls are `client/src/ModeratorPanel.jsx`: grouped settings,
with a switch for each one that is either on or off, collapsible to a one-line
summary.
`database.js` takes a PostgreSQL advisory lock and applies pending migrations
in a transaction before the server listens. The `schema_migrations` table records
completed versions. To change the schema, append a version to `migrations/index.js`;
don't edit an already-applied step or rely on startup to repeat a backfill.
`discussion-names.js` shares canonical slug and display-title rules between
migrations and live requests.
`logging.js` keeps raw database errors and their potentially sensitive details out
of server logs.

### Results visibility

`discussions.results_visibility` is `after_vote` (the default) or `always`. In
`after_vote` mode the server removes the votes of Agreement, Yes/No, Multiple Choice and Numerical
questions a viewer has not answered and marks them `resultsHidden`
(`hideUnansweredResults` in `server.js`), so the `questions` payload differs per
participant. `emitQuestions` delegates to `question-broadcaster.js`, which loads
one set of questions per send, reuses each participant's view across sockets,
and serializes room-wide broadcasts so older results can't arrive last. A
socket is a participant once it has sent `identify`, and a
moderator once `checkModerator` or `claimModerator` has accepted its token; the
token is checked again on personalized sends. In `always` mode a room with no
queued questions can use one broadcast. Any code that changes votes or questions must call
`emitQuestions` and never emit `questions` to the room directly.

The REST endpoints that return results (`summary`, `clusters`, `snapshots`,
`export.csv`, `export.json`, `report.html`) apply the same rule through
`getQuestionsForViewer`. The client identifies the viewer with the
`X-Convora-User` and `X-Convora-Moderator` headers (`client/src/viewer.js`); a
request without them sees only what a participant who has answered nothing sees.

Opinion-group analysis (`cluster-service.js`) runs in a worker so it doesn't
block live votes or room updates. Each server process admits one analysis and
two waiting requests. Further requests receive HTTP 503 and may be retried.
Only viewer-visible Agreement votes and request-local participant IDs go to
the worker; the worker has 30 seconds to finish.

### Question interest

`question_interest` holds one vote per participant per question. The idempotent
`setQuestionInterest` event accepts `true` (upvote), `false` (clear), or `"down"`
(downvote, only when the moderator has enabled it). `getQuestions` sends each
direction's count and per-question ownership tokens, not raw participant IDs.
The client recomputes `ownerToken('question:<id>', userId)` to recognize its own
vote. These counts are independent of poll results. When downvotes are disabled,
their count and tokens are hidden; the Most Interesting sort always uses upvotes.

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

In Render, open **convora-db → Connect → External Connection**, copy the
**External Database URL**, and run `psql "<EXTERNAL_DATABASE_URL>"`.

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

## Production Deployment

Production runs on Render at https://convora.xyz. Merging to `main` deploys it
automatically. See [DEPLOY.md](DEPLOY.md) for setup and configuration.

## Other Notes

The client and server are on the same domain, so I don't need to do things like this:
```javascript
const socket = io(SOCKET_URL, {
    withCredentials: true,
});
```

## Old Heroku deployment

The app used to run on Heroku. That app and its database no longer exist.
`latest.dump` is a backup of the Heroku database; see [DEPLOY.md](DEPLOY.md) for
how to restore it.

## Composer wording contract

The type picker suggests a response format; it does not need to parse every English sentence. A manual choice wins over the suggestion. The three polite-request tables in `tests/guess-question-type.test.js` are the acceptance set. Use contrasting examples when proposing a change to this contract:

- Asking for content takes **Open Ended**: “Could you just describe your experience?” or “Can you tell us two lessons from the pilot?” Asking whether someone can perform an action takes **Yes/No**.
- Asking someone to confirm a label takes **Yes/No**, including “really useful for beginners.” Asking for a description in a role or manner, or asking for reasons as well as confirmation, takes **Open Ended**.
- For ambiguous “would you tell us” questions, distinguish willingness to disclose (“if I asked”) from a constraint on the answer (“if we could choose just one”). The former takes **Yes/No**, the latter **Open Ended**.

Treat other phrasing as best effort. Add a new acceptance case when it establishes a meaningful distinction, not just another synonym. Keep the existing numerical, choice, agreement, and no-guess cases intact.
