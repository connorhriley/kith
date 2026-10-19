import fs from 'node:fs';
import path from 'node:path';
import { KithEngine } from '../core/engine.js';

export interface InitReport {
  repoRoot: string;
  indexedFiles: number;
  configuredFiles: string[];
}

export function initializeKithRepository(
  repoRoot = process.cwd(),
  cliBinaryCommand = 'npx kith'
): InitReport {
  const absRoot = path.resolve(repoRoot);
  const engine = new KithEngine(absRoot);
  const configuredFiles: string[] = [];

  try {
    // 1. Update .gitignore
    const gitignorePath = path.join(absRoot, '.gitignore');
    let gitignoreContent = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : '';
    if (!gitignoreContent.includes('.coord/')) {
      gitignoreContent =
        gitignoreContent.trimEnd() +
        (gitignoreContent.length > 0 ? '\n' : '') +
        '\n# Kith parallel agent state & worktrees\n.coord/\n';
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf8');
      configuredFiles.push('.gitignore');
    }

    // 2. Configure Claude Code (.claude/settings.json) with MCP + PreToolUse/PostToolUse hooks
    const claudeDir = path.join(absRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    let claudeSettings: Record<string, unknown> = {};
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        claudeSettings = {};
      }
    }

    const mcpServers = (claudeSettings.mcpServers as Record<string, unknown>) ?? {};
    mcpServers.kith = {
      command: 'npx',
      args: ['-y', 'kith', 'mcp'],
    };
    claudeSettings.mcpServers = mcpServers;

    claudeSettings.hooks = {
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
          hooks: [
            {
              type: 'command',
              command: `${cliBinaryCommand} hook pre`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
          hooks: [
            {
              type: 'command',
              command: `${cliBinaryCommand} hook post`,
            },
          ],
        },
      ],
    };

    fs.writeFileSync(
      claudeSettingsPath,
      JSON.stringify(claudeSettings, null, 2) + '\n',
      'utf8'
    );
    configuredFiles.push('.claude/settings.json');

    // 3. Configure Cursor (.cursor/mcp.json)
    const cursorDir = path.join(absRoot, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    const cursorMcp = {
      mcpServers: {
        kith: {
          command: 'npx',
          args: ['-y', 'kith', 'mcp'],
        },
      },
    };
    fs.writeFileSync(cursorMcpPath, JSON.stringify(cursorMcp, null, 2) + '\n', 'utf8');
    configuredFiles.push('.cursor/mcp.json');

    // 4. Configure Antigravity / Agent Skill (.agent/skills/kith/SKILL.md)
    const skillDir = path.join(absRoot, '.agent', 'skills', 'kith');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    const skillContent = `---
name: kith
description: Zero-trust parallel agent coordination protocol. Use before editing files, claiming tasks, starting dev servers, or merging branches when parallel agents may be active.
---

# Kith Parallel Agent Coordination Skill

Always coordinate with sibling agents via Kith MCP tools (\`kith_*\`) or the \`kith\` CLI:

1. **Before editing files:** Call \`kith_begin_work\` (or run \`kith begin --agent <id> --title "<intent>" --scope "src/**"\`) to verify no sibling agent holds a conflicting lock or duplicate intent.
2. **After modifying shared interfaces/exports:** Call \`kith_record_file_edit\` (or let the PostToolUse hook run automatically) to check transitive blast radius, semantic duplicate symbols, and live dirty-tree \`git merge-tree\` conflicts.
3. **When running dev servers or package installs:**
   - Lease a unique port: \`kith port --agent <id> --service web\`
   - Serialize installs/migrations: \`kith mutex --agent <id> --name package-install -- pnpm install\`
4. **When finishing work:** Call \`kith_complete_work\` (or \`kith complete --agent <id>\`) to run the Speculative Merge Train and release all locks.
`;
    fs.writeFileSync(skillPath, skillContent, 'utf8');
    configuredFiles.push('.agent/skills/kith/SKILL.md');

    // 5. Update AGENTS.md idempotently
    const agentsMdPath = path.join(absRoot, 'AGENTS.md');
    const kithBlock = `<!-- KITH:START -->
## Parallel Agent Coordination (\`kith\`)

This repository uses **Kith** for zero-trust coordination across parallel coding agents (Claude Code, Antigravity, Codex, Cursor).
- **Begin Work & Lock Scope:** \`kith begin --agent <id> --title "<intent>" --scope "<glob>"\` (or MCP tool \`kith_begin_work\`)
- **Claim Queued Task:** \`kith task claim --agent <id>\` (or MCP tool \`kith_claim_next_task\`)
- **Lease Collision-Free Port:** \`kith port --agent <id> --service <name>\`
- **Serialize Package Installs:** \`kith mutex --agent <id> --name install -- pnpm install\`
- **Live TUI Dashboard:** \`kith top\`
- **Complete & Verify Merge:** \`kith complete --agent <id>\`
<!-- KITH:END -->`;

    let agentsMd = fs.existsSync(agentsMdPath)
      ? fs.readFileSync(agentsMdPath, 'utf8')
      : '# Repository Agent Instructions\n\n';

    if (agentsMd.includes('<!-- KITH:START -->')) {
      agentsMd = agentsMd.replace(
        /<!-- KITH:START -->[\s\S]*?<!-- KITH:END -->/,
        kithBlock
      );
    } else {
      agentsMd = agentsMd.trimEnd() + '\n\n' + kithBlock + '\n';
    }
    fs.writeFileSync(agentsMdPath, agentsMd, 'utf8');
    configuredFiles.push('AGENTS.md');

    // 6. Install Git pre-commit hook if .git/hooks exists
    const gitHooksDir = path.join(absRoot, '.git', 'hooks');
    if (fs.existsSync(gitHooksDir)) {
      const preCommitPath = path.join(gitHooksDir, 'pre-commit');
      const hookMarker = '# KITH-PRE-COMMIT-HOOK';
      const hookScript = `#!/usr/bin/env sh
${hookMarker}
${cliBinaryCommand} hook pre-commit || exit 1
`;
      if (!fs.existsSync(preCommitPath)) {
        fs.writeFileSync(preCommitPath, hookScript, { mode: 0o755 });
        configuredFiles.push('.git/hooks/pre-commit');
      } else {
        const existingHook = fs.readFileSync(preCommitPath, 'utf8');
        if (!existingHook.includes(hookMarker)) {
          fs.writeFileSync(
            preCommitPath,
            existingHook.trimEnd() + '\n\n' + hookMarker + '\n' + `${cliBinaryCommand} hook pre-commit || exit 1\n`,
            { mode: 0o755 }
          );
          configuredFiles.push('.git/hooks/pre-commit');
        }
      }
    }

    // 7. Create shell PATH shims in .coord/bin for pnpm/npm mutex serialization
    const shimBinDir = path.join(engine.coordDb.coordDir, 'bin');
    fs.mkdirSync(shimBinDir, { recursive: true });
    for (const pkgMgr of ['npm', 'pnpm', 'yarn']) {
      const shimPath = path.join(shimBinDir, pkgMgr);
      const shimContent = `#!/usr/bin/env sh
# Kith auto-serialized package manager shim
case "$1" in
  install|i|add|remove|ci)
    exec ${cliBinaryCommand} mutex --agent "\${KITH_AGENT_ID:-shim-$$}" --name package-install -- /usr/bin/env ${pkgMgr} "$@"
    ;;
  *)
    exec /usr/bin/env ${pkgMgr} "$@"
    ;;
esac
`;
      fs.writeFileSync(shimPath, shimContent, { mode: 0o755 });
    }
    configuredFiles.push('.coord/bin/{npm,pnpm,yarn}');

    // 8. Index repository AST exports & import dependency graph
    const indexedFiles = engine.depGraph.indexRepositoryFiles(absRoot);

    return {
      repoRoot: absRoot,
      indexedFiles,
      configuredFiles,
    };
  } finally {
    engine.close();
  }
}
