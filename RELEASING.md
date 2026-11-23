# Releasing Kith

Pushing a `vX.Y.Z` tag runs the release workflow on that commit. `main` is protected; merge the release commit first, then tag the merge commit. Do not publish with an npm token. When that version is not already on npm, the [release workflow](.github/workflows/release.yml) publishes through npm trusted publishing and attaches provenance. When `npm view kith-coord@X.Y.Z version` already prints `X.Y.Z`, the workflow skips `npm publish` and still creates the GitHub release, publishes to the MCP Registry, and installs that version from the registry on Windows.

The tag must point at a commit that already contains `.github/workflows/release.yml`. GitHub runs the workflow from the tagged commit.

## Cut a release

1. Stop and make the version consistent. Set the same `X.Y.Z` in:
   - `package.json` `version`
   - `src/version.ts` `KITH_VERSION`
   - `server.json` `version` and `packages[0].version`
   - a new `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md`
2. Bump `extensions/editor/package.json` when that tag should ship a new editor extension. Marketplace publish uses the extension's own version and fails if that version is already published. Omit the marketplace secrets to skip it.
3. Run `pnpm release:check`, then the usual `pnpm typecheck`, `pnpm test`, `pnpm protocol:check`, and `git diff --check`.
4. Merge to `main`. The pull-request checks are the six CI jobs (Linux and macOS, Node 22.13.0, 22, and 24) and the two Windows jobs (Node 22.13.0 and 24).
5. Tag the merge commit and push the tag:

```sh
git checkout main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

You can also run the Release workflow manually with the **Use workflow from** selector set to that tag. Any other ref fails the manifest check before it publishes.

The workflow then:

1. Checks the tag, versions, changelog section, and `server.json` against the current MCP Registry schema.
2. Runs the CI workflow and the Windows workflow against a tarball packed from the tag. These finish before publish. They do not install `kith-coord` from the registry.
3. Publishes to npm with `npm publish --provenance --access public`, unless that exact version is already on the public registry. The check is `npm view kith-coord@X.Y.Z version` against `https://registry.npmjs.org`. A matching version skips only that step. The publish job still succeeds, so the jobs that follow it are not skipped. The publish job uses Node 24 and npm 11.21.2 when it does publish. Trusted publishing requires Node 22.14.0 or newer and npm 11.5.1 or newer; the package itself still runs on Node 22.13.0.
4. Creates the GitHub release from the matching changelog section, publishes `server.json` with `mcp-publisher` 1.8.9 using GitHub OIDC, and runs Windows validation again by installing `kith-coord@X.Y.Z` from the registry. These three run whether or not step 3 published.

That second Windows run is the existing registry check. It is a separate job after the npm job because a tag push used to start it immediately, and the registry did not have the new version yet. The Windows workflow retries a fresh npm install for about five minutes to cover registry propagation. When the version was published before the tag, that install is the copy already on npm.

Publishing jobs use the GitHub environment `release`. No job reads `NPM_TOKEN`.

## Already on npm

0.2.0 is cut the same way as 0.1.9 while the npm trusted publisher is not configured: publish manually from the merged release commit, confirm the registry, then push the tag. The tag must not be the thing that first publishes the version.

```sh
git checkout main
git pull
npm publish --access public
npm view kith-coord@0.2.0 version
git tag v0.2.0
git push origin v0.2.0
```

Publish the same commit you tag. The earlier Windows job tests a tarball packed from the tag. The later Windows job installs `kith-coord@0.2.0` from the registry and validates that copy. The editor job publishes extension 0.2.0 only when `VSCE_PAT` and `OVSX_PAT` are present.

0.1.9 is published manually, from the merged release commit, before `v0.1.9` is pushed. The npm trusted publisher is not configured yet, so the tag must not be the thing that first publishes that version. After `npm view kith-coord@0.1.9 version` prints `0.1.9`, push the tag. The workflow then skips `npm publish` and still creates the GitHub release, publishes `server.json` with `mcp-publisher` (GitHub OIDC), and runs the Windows job that installs `kith-coord@0.1.9` from the registry.

Publish the same commit you tag. The earlier Windows job tests a tarball packed from the tag. The later Windows job installs `kith-coord@0.1.9` from the registry and validates that copy.

```sh
git checkout main
git pull
npm publish --access public
npm view kith-coord@0.1.9 version
git tag v0.1.9
git push origin v0.1.9
```

Do not put an npm token in GitHub. The same skip applies to any later version that is already on the registry. A tag whose version is absent still runs `npm publish` through trusted publishing, once that publisher exists. Creating the publisher and then pushing a tag that skips publish does not count as its first successful publish.

## One-time npm trusted publisher

On npmjs.com, open **kith-coord → Settings → Trusted Publisher**, choose **GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `connorhriley` |
| Repository | `kith` |
| Workflow filename | `release.yml` |
| Environment name | `release` |

The workflow filename is only the file name, including `.yml`. All four values are case-sensitive. The file has to be `.github/workflows/release.yml` in this repository, and the tagged commit has to contain it.

For **Allowed actions**, turn on direct **`npm publish`**. A trusted publisher created after 3 September 2026 allows `npm stage publish` until you also allow `npm publish`. This workflow runs `npm publish`, not `npm stage publish`. Provenance is requested with `--provenance` and is also generated automatically for a public package from this public repository.

Create the publisher when you are ready to tag. A new publisher must complete its first successful publish within 2 days or it expires. An expired publisher cannot be edited; delete it and create it again. The connection cannot be edited in place.

After that first publish succeeds, set the package's **Publishing access** to **Require two-factor authentication and disallow tokens**, then revoke any leftover automation token. Trusted publishing keeps working. That setting blocks tokens that bypass 2FA.

`package.json` `repository.url` stays `git+https://github.com/connorhriley/kith.git`. npm checks it against this repository.

## GitHub environment

The npm publish, MCP Registry, GitHub release, and editor jobs select an environment named `release`. Use that exact name: it is part of the npm publisher above.

You do not have to create that environment before the tag. GitHub creates an environment the first time a workflow job references a name that does not exist yet. The created environment has no protection rules and no secrets, so the jobs are not waiting on a `release` environment that has not been set up. That is not an implicit Pages build, which is the case where GitHub would add a branch rule on its own. Only a repository admin can add rules or secrets afterward.

Leave required reviewers unset for an unattended tag. Adding a reviewer makes those four jobs wait for approval. The test jobs do not use the environment, so they still run first. The Windows job that installs the published package does not use the environment either.

The workflow's `GITHUB_TOKEN` creates the GitHub release. Actions permissions need write access to contents. The default token for this repository can do that.

## Editor marketplaces

The editor job publishes only when these secrets exist. It publishes neither marketplace when both are absent, and it still succeeds.

| Secret | Registry |
| --- | --- |
| `VSCE_PAT` | VS Code Marketplace, publisher `kith-coord` |
| `OVSX_PAT` | Open VSX, namespace `kith-coord` |

Store them as repository secrets or as secrets on the `release` environment. The job does not request an OIDC token. `OVSX_PAT` is what makes Open VSX use the personal access token; without it, current `ovsx` would try trusted publishing instead.

## MCP Registry

`server.json` uses namespace `io.github.connorhriley` and schema `2025-12-11`, which is the schema the registry documents. `package.json` `mcpName` is `io.github.connorhriley/kith`. The registry reads that field from the published npm package, so the MCP Registry job runs only after the npm job. That job has either just published the version or found the same version already on the registry.

`pnpm release:check` compares the versions and validates `server.json` against that schema. Pull-request CI runs the same check.
