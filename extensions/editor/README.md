![Kith](lockup.png)

# Kith for VS Code and Cursor

One extension connects your editor's agent to Kith and adds a small read-only status indicator. Kith's coordination server is bundled; no global npm install is required.

## Install

Use **Extensions → Install from VSIX** and select `kith-editor.vsix`. Open a trusted local Git workspace with Node.js **22.13+ on 22.x or 24+** installed. Kith detects Node automatically; **Kith: Node Path** in user settings can select a different installation.

The extension offers Kith through the editor's native MCP API. The editor still controls server approval, tool permissions and start/stop. Existing Kith server entries are preserved and suppress a duplicate registration. Other MCP servers, hooks and permissions are untouched. VS Code 1.102+ and a Cursor version exposing its MCP extension API are required.

Tell the agent which repository contains the task. The same connection supports multiple repositories through Kith's `repository` argument; ownership stays scoped to each repository. Follow the returned worktree path and retain your normal verification and merge gates.

Click **Kith** in the status bar or run **Kith: Show Workspace Status**. It observes linked-worktree dirty paths and reads existing coordination state offline. It does not initialize a project database, attribute writes to processes, enforce non-cooperating editors, or certify that changes merge. An unavailable scan stays unavailable. No telemetry or model calls are added.

## Development

From the repository root, install core dependencies with `pnpm install --frozen-lockfile`, then run:

```sh
npm --prefix extensions/editor ci --ignore-scripts
npm --prefix extensions/editor run check
npm --prefix extensions/editor run package
npm --prefix extensions/editor run test:host
```

The VSIX is written to `artifacts/kith-editor.vsix`. Host validation opens an editor window with a disposable profile and synthetic Git workspace. On macOS only this empty test profile uses Electron's mock Keychain to avoid native credential prompts; never sign into it. Normal extension use does not change credential storage. Set `KITH_EDITOR_EXECUTABLE` to an installed editor executable to test Cursor, or `KITH_EDITOR_VERSION` to test a different VS Code version. Never use an active production workspace as the test profile.

Native API references: [VS Code MCP provider](https://code.visualstudio.com/api/extension-guides/ai/mcp#register-an-mcp-server-in-your-extension), [Cursor MCP registration](https://cursor.com/docs/extension-api).

Native host checks on macOS passed with VS Code 1.143.0 and Cursor 3.24.18 (VS Code API 1.128.0): extension activation, native MCP registration, refresh, and no workspace configuration or database creation. These checks do not sign in, approve tools, or make model calls. Separate real MCP workflow tests exercise the bundled server through verified integration in two disposable repositories, including refusal of a capability from the other repository. CI checks the minimum VS Code version too.
