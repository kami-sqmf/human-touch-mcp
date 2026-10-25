import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyPublicDocumentation} from '../scripts/package-docs.mjs';

test('public package documentation includes current contracts and history but excludes internal audits', async()=>{
  const source=fileURLToPath(new URL('../',import.meta.url));
  const destination=await mkdtemp(join(tmpdir(),'human-public-docs-'));
  await copyPublicDocumentation({source,destination});
  const docs=await readdir(join(destination,'docs'));
  assert.ok(docs.includes('TOOLS-V2.md'));
  assert.ok(docs.includes('VERIFICATION.md'));
  assert.ok(docs.includes('LIVE-ACCEPTANCE.md'));
  assert.ok(!docs.some(name=>/audit|superpowers|report|PLAN/i.test(name)));
  assert.deepEqual((await readdir(destination)).sort(),['LICENSE','README.md','THIRD-PARTY-NOTICES.md','docs']);
  for(const name of ['README.md','docs/CONTRACT.md','docs/VERIFICATION.md','docs/LIVE-ACCEPTANCE.md']) {
    const content=await readFile(join(destination,name),'utf8');
    for(const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if(!/^[a-z]+:|^#/i.test(match[1]))assert.ok((await stat(join(destination,dirname(name),match[1]))).isFile(),`${name} link ${match[1]}`);
    }
  }
});
