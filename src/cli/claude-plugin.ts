import fs from 'node:fs';
import path from 'node:path';

/** Marketplace, inline, and skills-directory ids all use this shape. */
const KITH_PLUGIN_ID = /^kith@[A-Za-z0-9._-]+$/;

export interface ClaudePluginStatus {
  /** Enabled in Claude Code settings, or installed and not turned off. */
  active: boolean;
  id: string | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function settingsFiles(home: string, projectRoot?: string): string[] {
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
  ];
  if (projectRoot) {
    const projectSettings = path.join(projectRoot, '.claude', 'settings.json');
    const projectLocal = path.join(projectRoot, '.claude', 'settings.local.json');
    if (projectSettings !== files[0]) files.push(projectSettings);
    if (projectLocal !== files[1]) files.push(projectLocal);
  }
  return files;
}

function idsFromInstallRecord(file: string): string[] {
  const parsed = readJson(file);
  if (!parsed) return [];
  const table = parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
    ? parsed.plugins as Record<string, unknown>
    : parsed;
  return Object.keys(table).filter((key) => KITH_PLUGIN_ID.test(key));
}

/**
 * Whether this machine has the Kith Claude Code plugin turned on.
 * Reads settings and `installed_plugins.json` only. It does not start Claude Code.
 */
export function claudeKithPluginStatus(home: string, projectRoot?: string): ClaudePluginStatus {
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const file of settingsFiles(home, projectRoot)) {
    const map = readJson(file)?.enabledPlugins;
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [id, value] of Object.entries(map)) {
      if (!KITH_PLUGIN_ID.test(id)) continue;
      if (value === true) enabled.add(id);
      else if (value === false) disabled.add(id);
    }
  }
  const installed = idsFromInstallRecord(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const activeIds = new Set<string>(enabled);
  for (const id of installed) {
    if (!disabled.has(id)) activeIds.add(id);
  }
  const id = [...activeIds][0] ?? null;
  return { active: activeIds.size > 0, id };
}

/** Appended to the Claude hook note when `kith install` and the plugin are both present. */
export function claudeInstallHookNote(base: string, pluginActive: boolean): string {
  if (!pluginActive) return base;
  return `${base} The Claude Code plugin is also enabled; its hooks defer to these, so each tool call is checked once.`;
}
