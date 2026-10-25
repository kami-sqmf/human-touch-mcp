import {cp, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';

const publicDocuments = [
  'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md',
  'docs/PORTABLE.md', 'docs/CONTRACT.md', 'docs/TOOLS-V2.md',
  'docs/NATIVE-PROTOCOL-V2.md', 'docs/REQUIREMENTS-MAPPING.md',
  'docs/VERIFICATION.md', 'docs/LIVE-ACCEPTANCE.md',
  'docs/history/VERIFICATION-0.1.0.md', 'docs/history/CONTRACT-0.1.0.md',
];

// Explicit allowlist: never distribute local run reports, internal audits or plans.
export async function copyPublicDocumentation({source, destination}) {
  for (const name of publicDocuments) {
    const target = join(destination, name);
    await mkdir(dirname(target), {recursive:true});
    await cp(join(source, name), target);
  }
}
