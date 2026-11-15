import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const printNotes = process.argv.includes('--print-notes');
const schemaUrl = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

const manifest = readJson('package.json');
const listing = readJson('server.json');
const versionSource = fs.readFileSync(path.join(root, 'src/version.ts'), 'utf8');
const versionMatch = versionSource.match(/export const KITH_VERSION = '([^']+)';/);
if (!versionMatch) fail('src/version.ts must export KITH_VERSION as a string literal.');
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version must be a plain X.Y.Z release, got ${version}.`);
if (versionMatch[1] !== version) fail(`src/version.ts KITH_VERSION is ${versionMatch[1]}, package.json is ${version}.`);
if (typeof manifest.mcpName !== 'string' || manifest.mcpName.length === 0) {
  fail('package.json mcpName is required so the MCP Registry can verify the npm package.');
}
if (listing.name !== manifest.mcpName) fail(`server.json name is ${listing.name}, package.json mcpName is ${manifest.mcpName}.`);
if (listing.version !== version) fail(`server.json version is ${listing.version}, package.json is ${version}.`);
if (listing.packages?.[0]?.identifier !== manifest.name) {
  fail(`server.json package identifier is ${listing.packages?.[0]?.identifier}, package.json name is ${manifest.name}.`);
}
if (listing.packages?.[0]?.version !== version) {
  fail(`server.json package version is ${listing.packages?.[0]?.version}, package.json is ${version}.`);
}
if (listing.$schema !== schemaUrl) fail(`server.json $schema must be ${schemaUrl}.`);

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
const lines = changelog.split('\n');
const start = lines.findIndex((line) => heading.test(line));
if (start < 0) fail(`CHANGELOG.md has no "## ${version}" section.`);
let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join('\n').trim();
if (notes.length === 0) fail(`CHANGELOG.md section ${version} is empty.`);

if (process.env.KITH_REQUIRE_RELEASE_TAG === '1') {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  const refType = process.env.GITHUB_REF_TYPE ?? '';
  if (refType !== 'tag' || tag !== `v${version}`) {
    fail(`This release ref is ${refType || 'unknown'} ${tag || '(none)'}. Push tag v${version}, or run the workflow from that tag.`);
  }
}

if (printNotes) {
  process.stdout.write(`${notes}\n`);
  process.exit(0);
}

const sdkPackage = fs.realpathSync(path.join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'));
const requireFromSdk = createRequire(sdkPackage);
const ajvModule = requireFromSdk('ajv');
const formatsModule = requireFromSdk('ajv-formats');
const Ajv = typeof ajvModule === 'function' ? ajvModule : ajvModule.default;
const addFormats = typeof formatsModule === 'function' ? formatsModule : formatsModule.default;
let response;
try {
  response = await fetch(schemaUrl, { signal: AbortSignal.timeout(20_000) });
} catch (error) {
  fail(`MCP Registry schema request failed: ${error instanceof Error ? error.message : error}`);
}
if (!response.ok) fail(`MCP Registry schema request failed: ${response.status} ${schemaUrl}`);
const schema = await response.json();
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(listing)) {
  const details = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('\n');
  fail(`server.json does not match the MCP Registry schema:\n${details}`);
}

console.log(`Release manifest checks passed for ${version}.`);
