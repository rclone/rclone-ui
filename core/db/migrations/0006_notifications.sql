-- Notification targets and the mail server (core/notifications). The mail server's password is
-- in the keychain.

CREATE TABLE notification_targets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  provider     TEXT NOT NULL,           -- webhook | slack | discord | telegram | email
  url          TEXT NOT NULL,           -- the webhook, the bot URL, or the email recipients
  url_key      TEXT NOT NULL UNIQUE,    -- hash of lower(url), so there is one target per url
  events       TEXT NOT NULL,           -- JSON array of event ids
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_ms INTEGER,
  last_error   TEXT,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);

-- The single mail server that email targets send through. There is no row when none is set.
CREATE TABLE notification_smtp (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  encryption   TEXT NOT NULL,           -- starttls | tls | none
  username     TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  from_name    TEXT NOT NULL DEFAULT '',
  updated_ms   INTEGER NOT NULL
);
