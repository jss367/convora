


# Buliding locally (Development Mode)

start server in dev mode

`node server.js`


Start the database server:

`brew services start postgresql@14`

# Databases

- Name: `convora`
- Connect: `psql -U julius -d convora`

## See tables

* `\dt`

* `\d+ questions`


## Connect to remote database

`heroku pg:psql`

# Updating

To see the impact of code changes, you'll need to build it first
* `npm run build`
* `node server.js`

# Pushing from your git branch to heroku main

* `git add .`
* `git commit -m "Update ..."`
* `git push heroku my_branch:main`

This allows you to be working on a branch, `my_branch`, and push to main in heroku

# Notes

The client and server are on the same domain, so I don't need to do things like this:
```
const socket = io(SOCKET_URL, {
    withCredentials: true,
});
```

The frontend is React and the backend is Node.js.
