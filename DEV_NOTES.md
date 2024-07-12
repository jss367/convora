


# Buliding locally

`npm install`  <--- do in root directory but might also need to do it in the client directory

`npm run dev:client`

Access it at http://localhost:5173/









You can now start the database server using:

    pg_ctl -D /usr/local/var/postgres -l logfile start

Actually, do this instead:

brew services start postgresql@14

# Databases

For reference, here are the databases, both locally and on heroku

CREATE TABLE discussions (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL
);

CREATE TABLE questions (
  id SERIAL PRIMARY KEY,
  discussion_id INTEGER REFERENCES discussions(id),
  text TEXT NOT NULL,
  type TEXT NOT NULL,
  min_value INTEGER,
  max_value INTEGER
);

CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id),
  value TEXT NOT NULL
);



Local database is called convora

Connect to it: `\c convora`




# Pushing from your git branch to heroku main

* `git add .`
* `git commit -m "Update ..."`
* `git push heroku my_branch:main`

This allows you to be working on a branch, `my_branch`, and push to main in heroku


# Connect to database

`heroku pg:psql`
