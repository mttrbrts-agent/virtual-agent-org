-- GitHub events (decision 62).

-- decisions.status gains 'lapsed': a person merged or closed the PR or issue, or new
-- commits arrived, so the decision can no longer run. Only the gateway sets it, and
-- only on decisions that are open, or approved and not yet run. The column has no
-- constraint, so it needs no change for that.

-- A merge card's checks as the gateway last re-ran them, after CI finished or a review
-- or thread changed. The rationale keeps the checks from when it was queued.
ALTER TABLE decisions ADD COLUMN checks_now TEXT;
ALTER TABLE decisions ADD COLUMN checks_at TEXT;

-- One row per delivery the gateway used. No titles, bodies or comment text: agents
-- read those from GitHub themselves, as data. Pruned with the other events.
-- One delivery can be about several PRs (a workflow run), so the key is both.
CREATE TABLE github_events (
  delivery     TEXT NOT NULL,                   -- X-GitHub-Delivery
  target       TEXT NOT NULL,                   -- owner/repo#n, lower case
  event        TEXT NOT NULL,                   -- pull_request, workflow_run, ...
  action       TEXT NOT NULL,                   -- closed, completed, ...
  actor        TEXT,                            -- GitHub login of whoever did it
  association  TEXT,                            -- the PR's or issue's author_association, where given
  sha          TEXT,                            -- head commit, where there is one
  detail       TEXT,                            -- short gateway-made words: "merged", "failure"
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (delivery, target)
);
CREATE INDEX github_events_target ON github_events(target, received_at);

-- When the daily check last read each tracked PR or issue, so it reads the least
-- recently checked first and no target is starved by older ones.
CREATE TABLE github_checks (
  target      TEXT PRIMARY KEY,                 -- owner/repo#n, lower case
  checked_at  TEXT NOT NULL
);

-- Work the gateway will start for Mira when an event calls for it. A trigger fires at
-- most once per target and head; the five-minute cron starts those that are due.
CREATE TABLE github_wakes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,                    -- review | merge | first_response
  target      TEXT NOT NULL,                    -- owner/repo#n, lower case
  sha         TEXT NOT NULL DEFAULT '',         -- head commit; '' for first responses
  agent       TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | starting | started | dropped
  reason      TEXT,                             -- why it was dropped or put off
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),  -- reset when a dropped wake is queued again
  started_at  TEXT,                             -- set when claimed; counts towards the daily cap
  UNIQUE (trigger, target, sha)
);
CREATE INDEX github_wakes_due ON github_wakes(status, due_at);
CREATE INDEX github_wakes_started ON github_wakes(trigger, started_at);
