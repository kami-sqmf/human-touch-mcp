// Adapter outside the original official package; only finalized exported installer APIs are used.
import {pathToFileURL} from 'node:url';
const [launcher,home,mode]=process.argv.slice(2);
process.env.DESKTOP_TOUCH_MCP_HOME=home;
delete process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED;delete process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK;
const original=await import(pathToFileURL(launcher).href);
const spec=original.expectedReleaseSpec();if(!/^[a-f0-9]{64}$/i.test(spec.sha256??''))throw Error('Finalized original release SHA256 required');
if(mode==='install')await original.ensureRelease();
process.stdout.write(JSON.stringify(spec)+'\n');
