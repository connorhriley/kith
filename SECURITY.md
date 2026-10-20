# Security and reliability reports

Use the latest reviewed source on `main` and include your commit or version when reporting an issue. Kith runs with the invoking user's privileges and cannot contain a malicious agent that can bypass hooks, write the coordination database, or invoke Git directly.

Do not post exploit details, source snapshots, credentials, or quarantine contents in public issues. Use [GitHub private vulnerability reporting](https://github.com/connorhriley/kith/security/advisories/new), enabled on the canonical upstream. Include a minimal reproduction and affected version; do not disclose the report in a public issue.

For ordinary reliability bugs, provide a minimal disposable repository and redacted steps. Quarantine and snapshot files can contain full source files and secrets. Treat `.coord` as sensitive local state, keep it out of Git, and inspect it before sharing diagnostics.

Session capabilities protect cooperative client ownership and are omitted from status/events. They do not protect against a process with permission to read another process environment or rewrite the local SQLite database. Keep KITH_SESSION_TOKEN out of public diagnostics. See [session lifecycle](docs/sessions-and-mutexes.md).

MCP command execution (`kith_run_with_mutex`) and merge verification execute programs with the coordinator process permissions. They are outside a native client shell sandbox and must be reviewed/approved accordingly. Working-directory checks do not sandbox programs.

Read [the reliability contract](docs/reliability.md) for known enforcement and recovery limits.
