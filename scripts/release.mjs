#!/usr/bin/env node
/**
 * Publish every public workspace package whose version is not on npm yet.
 *
 * Runs in the release workflow after the "Release packages" PR is merged.
 * `npm publish` authenticates with GitHub's OIDC token (npm trusted
 * publishing, npm >= 11.5.1), so no NPM_TOKEN secret exists anywhere.
 * Prints `New tag: <name>@<version>` lines, which changesets/action turns
 * into GitHub releases after pushing the tags created here.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

/** Asks the registry directly, so a missing version is a quiet 404, not an npm error log. */
async function isPublished(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`registry lookup ${name}@${version}: HTTP ${res.status}`);
  return true;
}

let published = 0;
for (const dir of readdirSync(join(root, 'packages'))) {
  const cwd = join(root, 'packages', dir);
  const { name, version, private: isPrivate } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (isPrivate) continue;
  if (await isPublished(name, version)) {
    console.log(`${name}@${version} already on npm`);
    continue;
  }
  execFileSync('npm', ['publish', '--access', 'public'], { cwd, stdio: 'inherit' });
  run('git', ['tag', `${name}@${version}`]);
  console.log(`New tag: ${name}@${version}`);
  published++;
}
console.log(published ? `Published ${published} package(s).` : 'Nothing to publish.');
