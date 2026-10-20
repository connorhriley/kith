# Repository, path and scope rules

## Discovery

CLI, MCP and library entry points discover the canonical Git checkout root from the supplied directory. Subdirectories and symlink aliases select that checkout. Linked checkouts share coordination through Git's physical common directory while retaining their own checkout for Git operations. Ordinary repositories keep existing state in the primary checkout's `.coord/state.db`; separate Git directories use `<common-git-dir>/kith/state.db`. Submodules and nested independent repositories have their own common directories and state.

A session created inside a linked checkout records that checkout as its working path. Resuming a capability retains its recorded working path. Hook paths and file reports use the recorded worktree when present. Git pre-commit checks inspect the invoking checkout's staged index, even if the generated command passes another checkout through `--repo`. Integration targets the branch checked out in the explicitly selected checkout; use `--repo /path/to/integration-target` when completing work into another checkout.

Relative API file paths and scopes are checkout-root-relative, including when the client starts in a subdirectory. Hook clients should send absolute file paths. A non-Git directory has no shared Git identity; pass its intended root explicitly. Bare repositories and broken `.git` markers fail discovery. Setup discovers the root before preparing configuration and retains dry-run behavior.

Stop old Kith clients before upgrading. If the selected directory, an ancestor up to its checkout root, or a linked/separate-Git-directory checkout contains an old independent `.coord/state.db`, discovery refuses it rather than bypassing that state. Preserve its database, worktrees, snapshots and quarantine files before consolidating state manually. Kith does not merge independent databases or delete legacy work automatically.

## Supported scope grammar

The glob language compares case-sensitive strings separated by `/`. On a checkout whose filesystem treats case variants as aliases, lock conflict checks additionally compare normalized case variants, including missing files; they can retain extra conflicts. Symbol identifiers retain their case. Filesystem case behavior is probed read-only and cached for the lifetime of an engine:

| Form | Meaning |
| --- | --- |
| `src/auth.ts` | A concrete path |
| `src/*.ts` | `*` matches zero or more filename characters, without crossing `/` |
| `src/file?.ts` | `?` matches one Unicode code point, without crossing `/` |
| `src/**/*.ts` | A whole-segment `**` matches zero or more complete directories |
| `**` | All nonempty repository file paths |
| `file:src/routes/[id]/page.tsx` | An explicit literal path; reserved glob characters have no special meaning |
| `symbol:src/auth.ts#verifyToken` | A named symbol in a concrete file; a whole-file scope overlaps every symbol in that file |

Wildcards include dotfiles. `src/**/*.ts` includes `src/a.ts` and `src/nested/a.ts`. `src/**/left.ts` and `src/**/right.ts` do not overlap. Brace expansion, character classes, extglobs, negation and backslash escaping are unsupported in glob scopes and produce errors. Use separate scopes for alternatives, or `file:` for literal names containing brackets, braces, parentheses, `!`, `*` or `?`. Hook-generated file locks use literal paths automatically. `file:` and `symbol:` are reserved scope prefixes.

Scope strings are limited to 512 characters and 64 segments. Empty paths, control characters, backslashes and `.`/`..` segments after the wildcard prefix are refused. Quote scopes in shells. CLI scopes are comma-separated; literal commas in a scope require the library/MCP array API.

Intersection uses finite-state language intersection rather than sample filenames. Already-persisted unsupported scopes retain exclusion until their owner releases them or their session expires. This can block unrelated work; it never silently declares a malformed scope disjoint.

## Symlinks

Existing literal path prefixes are physically resolved before containment checks, including `..` following a symlink. Internal aliases map to the same scope; outward, dangling and looping links are refused. Missing leaves resolve through their existing ancestors. Coordination directories/database and configuration writes refuse redirected paths. Indexing skips symlink sources and nested repositories.

A wildcard can hide a symlink below its literal prefix. When a lexical comparison is disjoint, Kith checks relevant filesystem entries in active checkouts and retains exclusion if an alias makes the result uncertain. Scan errors or the 10,000-entry scan bound also retain exclusion. This favors extra conflicts over overlapping access. Release scopes or use narrower literal prefixes to reduce uncertainty.

Path checks assume a stable layout during the check/write boundary. They do not provide protection against a hostile process swapping symlinks concurrently, hardlink aliases or clients bypassing Kith. Windows path behavior remains unvalidated.

## Integration and conflicts

Before staging source changes, integration verifies the agent's registered worktree, common repository and requested branch. Worktree removal refuses normalized-ID collisions and a path registered to another active agent. Executable mode is preserved in shadow reports. Git path lists are NUL-delimited, so conflict paths containing tabs/newlines are not split or interpreted as quoted names.

Git handles clean merges. Any unresolved Git conflict fails integration, including apparently additive source or JSON changes. Kith does not parse or rewrite conflicting contents. The target stays unchanged and the source worktree/checkpoint remains available for explicit repair and retry. Merge the current target into that source branch, resolve and commit the conflict there, then retry completion with a project-specific verification command. Checks must leave the candidate unchanged. A clean Git merge alone does not establish compatibility.
