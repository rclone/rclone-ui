# Schema

These files make a new `app.db`. Rclone UI 4 isn't released, so the database is never migrated:
a change to the schema edits these files in place, and there are no steps that move data.

| Number | Owner | What |
|---|---|---|
| 0001 | core/db | the base (app metadata) |
| 0002 | core/settings, core/prefs | settings, prefs |
| 0003 | core/templates, core/favorites | templates, favourites |
| 0004 | core/config, core/remotes | the config's password command, each remote's cached fsinfo |
| 0005 | core/transfers | transfers, their files |
| 0006 | core/notifications | targets, SMTP |
| 0007 | core/mounts, core/serves, core/children | automounts, stopped mounts |
| 0101 | core/launcher | the launcher's usage history |
| 0103 | core/watchers | watchers |
| 0104 | core/schedules | schedules |

A file is named `NNNN_<what>.sql` (lower case, digits and `_`). The files run in name order, in
one transaction, so a new file either gets the whole schema or stays empty. A table that
references another must come after it.

A new file records a hash of the schema in `meta.schema` (`core/db/schema.go`). The hash covers
each file's name and its SQL, without comments and with runs of whitespace collapsed. At every
start, a file whose hash differs from the build's is refused, and the app asks for its data folder
to be deleted. So after an edit here, delete your dev data folder. Editing only a comment doesn't
change the hash.

An edit changes the schema golden: run `go test ./core/db -update` and commit
`core/db/testdata/schema/app.sql` with the edit.

From the first release, this changes: a released schema can't be edited, and a change needs a
migration.
