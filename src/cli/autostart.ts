import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { physicalPath } from '../core/repository.js';
import { applySetupPlan } from './setup-ledger.js';

export const KITH_LAUNCHAGENT_LABEL = 'dev.kith.radar';

export interface AutostartResult {
  supported: boolean;
  configured: boolean;
  bootstrapped?: boolean;
  configPath: string;
  notes: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function launchAgentPath(home: string): string {
  return path.join(physicalPath(home), 'Library/LaunchAgents', `${KITH_LAUNCHAGENT_LABEL}.plist`);
}

export function buildLaunchAgentPlist(params: {
  label: string;
  programArgs: string[];
  logDir: string;
}): string {
  const argsXml = params.programArgs
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(params.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(params.logDir, 'radar.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(params.logDir, 'radar.err.log'))}</string>
</dict>
</plist>
`;
}

export function installAutostart(params: {
  home: string;
  targetDir: string;
  cliPath: string;
  dryRun: boolean;
  warnings: string[];
  noAutostart?: boolean;
}): AutostartResult {
  const realHome = physicalPath(params.home);
  const plistPath = launchAgentPath(realHome);
  if (params.noAutostart) {
    return {
      supported: process.platform === 'darwin',
      configured: false,
      configPath: plistPath,
      notes: 'Skipped (--no-autostart).',
    };
  }
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      configured: false,
      configPath: plistPath,
      notes: 'Login autostart currently targets macOS LaunchAgents.',
    };
  }

  const helper = path.resolve(path.dirname(params.cliPath), '../../bin/kith-menubar');
  if (!fs.existsSync(helper) && !params.dryRun) {
    return {
      supported: true,
      configured: false,
      configPath: plistPath,
      notes: 'Menu-bar binary unavailable; login autostart skipped.',
    };
  }

  const logDir = path.join(realHome, '.local/share/kith/logs');
  const plist = buildLaunchAgentPlist({
    label: KITH_LAUNCHAGENT_LABEL,
    programArgs: [physicalPath(helper), physicalPath(params.targetDir), physicalPath(process.execPath), physicalPath(params.cliPath)],
    logDir,
  });

  const relPath = path.relative(realHome, plistPath);
  let bootstrapped = false;
  if (!params.dryRun) {
    if (fs.existsSync(plistPath) && physicalPath(plistPath) !== plistPath) {
      throw new Error(`LaunchAgent path is redirected: ${plistPath}`);
    }
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const homeCoord = path.join(realHome, '.coord');
    fs.mkdirSync(homeCoord, { recursive: true, mode: 0o700 });
    applySetupPlan(realHome, homeCoord, new Map([[relPath, { content: plist, mode: 0o644 }]]), params.warnings);

    // Only interact with the live launchd GUI domain on the actual host user home outside Vitest.
    if (!process.env.VITEST && typeof process.getuid === 'function') {
      try {
        const currentRealHome = fs.realpathSync(process.env.HOME || os.homedir());
        if (realHome === currentRealHome) {
          const domain = `gui/${process.getuid()}`;
          const service = `${domain}/${KITH_LAUNCHAGENT_LABEL}`;
          let hadService = false;
          try {
            execFileSync('launchctl', ['bootout', service], { stdio: 'ignore', timeout: 3000 });
            hadService = true;
          } catch { /* Not previously loaded. */ }
          if (hadService) {
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
              try {
                execFileSync('launchctl', ['print', service], { stdio: 'ignore', timeout: 1000 });
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
              } catch { break; }
            }
          }
          execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore', timeout: 3000 });
          bootstrapped = true;
        }
      } catch {
        params.warnings.push('LaunchAgent plist written; load manually or re-login to activate.');
      }
    }
  }

  return {
    supported: true,
    configured: true,
    ...(bootstrapped ? { bootstrapped: true } : {}),
    configPath: plistPath,
    notes: params.dryRun
      ? 'Would register macOS login LaunchAgent for Kith Radar.'
      : 'Registered macOS login LaunchAgent for Kith Radar.',
  };
}

/** Check whether the LaunchAgent service currently owns a running Radar PID. */
export async function waitForHostAutostartRunning(timeoutMs = 2500): Promise<boolean> {
  if (process.platform !== 'darwin' || process.env.VITEST || typeof process.getuid !== 'function') return false;
  const service = `gui/${process.getuid()}/${KITH_LAUNCHAGENT_LABEL}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('launchctl', ['print', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
      if (/state\s*=\s*running/i.test(out) && /\bpid\s*=\s*\d+/.test(out)) return true;
    } catch { /* Service unavailable or exited. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

export function bootoutHostAutostart(home: string, dryRun: boolean): void {
  if (dryRun || process.platform !== 'darwin' || process.env.VITEST || typeof process.getuid !== 'function') return;
  try {
    const realHome = physicalPath(home);
    const currentRealHome = fs.realpathSync(process.env.HOME || os.homedir());
    if (realHome !== currentRealHome) return;
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${KITH_LAUNCHAGENT_LABEL}`], { stdio: 'ignore', timeout: 3000 });
  } catch { /* Best effort during uninstall. */ }
}
