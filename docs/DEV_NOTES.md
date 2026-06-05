# Developer Notes for Convora

## Understanding the Application Structure

Convora uses a single-server setup where the backend Node.js/Express server serves both the API and the built React application.

The frontend is React and the backend is Node.js.

## Running the Application Locally

### Option A: Docker Postgres

1. Start the local PostgreSQL container:
   ```
   npm run dev:db
   ```

2. Build the React app (if changes were made to the frontend):
   ```
   npm run build
   ```

3. Start the server against Docker Postgres:
   ```
   npm run dev:server:docker
   ```

4. Access the application at `http://localhost:3001`

5. Stop Docker Postgres when you are done:
   ```
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
```
npm test
```

Run against an already-running database:
```
DATABASE_URL=postgresql://convora:convora@127.0.0.1:54330/convora_test npm run test:node
```

The default test harness uses a separate Docker Compose project and port
(`convora-test`, `54330`) from the dev database (`54329`). Set `KEEP_TEST_DB=1`
to leave the test database running after a failed run. Because the tests truncate
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
```
const socket = io(SOCKET_URL, {
    withCredentials: true,
});
```

# Shut down

I deleted the PostgreSQL with this: `heroku addons:destroy heroku-postgresql --app convora`

If you want to turn on the app, you'll have to add it back. Before deleting, I downloaded a backup and save it at `/Users/julius/git/convora/latest.dump`.
