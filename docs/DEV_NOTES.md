# Developer Notes for Convora

## Understanding the Application Structure

Convora uses a single-server setup where the backend Node.js/Express server serves both the API and the built React application.

The frontend is React and the backend is Node.js.

## Running the Application Locally

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

- Name: `convora`
- Connect: `psql -U julius -d convora`

### See tables

* `\dt`

* `\d+ questions`


### Connect to remote database

`heroku pg:psql`

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
