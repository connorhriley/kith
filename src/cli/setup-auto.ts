import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ClientDetectionResult {
  clientName: string;
  found: boolean;
  configPath: string;
  configured: boolean;
  notes: string;
}

export function autoConfigureAllClients(targetWorkspace = process.cwd()): ClientDetectionResult[] {
  const home = os.homedir();
  const nodeBinary = '/opt/homebrew/bin/node';
  const kithEntry = '/Users/user/Projects/kith/dist/cli/index.js';
  const results: ClientDetectionResult[] = [];

  // 1. Claude Desktop App
  const claudeDesktopConfig = path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  if (fs.existsSync(claudeDesktopConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(claudeDesktopConfig, 'utf8'));
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.kith = {
        command: nodeBinary,
        args: [kithEntry, 'mcp'],
        cwd: targetWorkspace,
        env: {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
        }
      };
      fs.writeFileSync(claudeDesktopConfig, JSON.stringify(cfg, null, 2), 'utf8');
      results.push({
        clientName: 'Claude Desktop App',
        found: true,
        configPath: claudeDesktopConfig,
        configured: true,
        notes: `Configured with cwd: ${targetWorkspace}`
      });
    } catch (e) {
      results.push({
        clientName: 'Claude Desktop App',
        found: true,
        configPath: claudeDesktopConfig,
        configured: false,
        notes: `Error: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  } else {
    results.push({
      clientName: 'Claude Desktop App',
      found: false,
      configPath: claudeDesktopConfig,
      configured: false,
      notes: 'Not installed or no config found'
    });
  }

  // 2. Claude Code CLI
  const claudeCliConfig = path.join(home, '.claude/settings.json');
  if (fs.existsSync(path.dirname(claudeCliConfig))) {
    try {
      const cfg = fs.existsSync(claudeCliConfig) ? JSON.parse(fs.readFileSync(claudeCliConfig, 'utf8')) : {};
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.kith = {
        command: nodeBinary,
        args: [kithEntry, 'mcp']
      };
      fs.writeFileSync(claudeCliConfig, JSON.stringify(cfg, null, 2), 'utf8');
      results.push({
        clientName: 'Claude Code CLI',
        found: true,
        configPath: claudeCliConfig,
        configured: true,
        notes: 'Added mcpServers.kith'
      });
    } catch (e) {
      results.push({
        clientName: 'Claude Code CLI',
        found: true,
        configPath: claudeCliConfig,
        configured: false,
        notes: `Error: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }

  // 3. Codex (ChatGPT App / Codex CLI)
  const codexConfig = path.join(home, '.codex/config.toml');
  if (fs.existsSync(path.dirname(codexConfig))) {
    try {
      let content = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : '';
      if (!content.includes('[mcp_servers.kith]')) {
        content = content.trimEnd() + '\n\n[mcp_servers.kith]\ncommand = "' + nodeBinary + '"\nargs = ["' + kithEntry + '", "mcp"]\n';
        fs.writeFileSync(codexConfig, content, 'utf8');
      }
      results.push({
        clientName: 'Codex (ChatGPT App)',
        found: true,
        configPath: codexConfig,
        configured: true,
        notes: 'Configured [mcp_servers.kith]'
      });
    } catch (e) {
      results.push({
        clientName: 'Codex (ChatGPT App)',
        found: true,
        configPath: codexConfig,
        configured: false,
        notes: `Error: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }

  // 4. Cursor
  const cursorConfig = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/cursor.mcp/mcp.json');
  const cursorLocalConfig = path.join(targetWorkspace, '.cursor/mcp.json');
  try {
    fs.mkdirSync(path.join(targetWorkspace, '.cursor'), { recursive: true });
    fs.writeFileSync(cursorLocalConfig, JSON.stringify({
      mcpServers: {
        kith: {
          command: nodeBinary,
          args: [kithEntry, 'mcp']
        }
      }
    }, null, 2), 'utf8');
    results.push({
      clientName: 'Cursor',
      found: true,
      configPath: cursorLocalConfig,
      configured: true,
      notes: 'Configured workspace .cursor/mcp.json'
    });
  } catch {
    // Ignore
  }

  return results;
}
