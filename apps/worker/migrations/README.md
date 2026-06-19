# D1 Migrations

`0001_init.sql` is a squashed baseline for fresh databases.

The production `artifact-use` D1 database already recorded the historical
`0001` through `0007` migration names before this squash. The next production
schema migration must therefore be numbered `0008_*` or higher; reusing
`0002` through `0007` would be skipped by Wrangler on production.
