const fs=require('fs');
function rep(p,a,b){let s=fs.readFileSync(p,'utf8');const crlf=s.includes('\r\n');if(crlf){a=a.replace(/\n/g,'\r\n');b=b.replace(/\n/g,'\r\n');}if(!s.includes(a))throw new Error('miss '+p+a.slice(0,40));fs.writeFileSync(p,s.split(a).join(b));}
let f='lib/routes/promotion-routes.js';
rep(f,"import { appendDeliveryAudit } from '../delivery-audit.js';","import { appendDeliveryAudit } from '../delivery-audit.js';\nimport { VOCAB_VERSION } from '../../packages/suite/core/delivery/vocab.js';");
rep(f,"    const passed = passedSwitches(report);\n    const wanted","    // A report from a suite that ran another switch vocabulary says nothing about this code.\n    if (Number(report?.code?.vocabVersion) !== VOCAB_VERSION) {\n      return res.status(422).json({ code: 'code-mismatch', message: `The report ran on vocabulary ${report?.code?.vocabVersion ?? 'unknown'}; this hub runs ${VOCAB_VERSION}.` });\n    }\n    const passed = passedSwitches(report);\n    const wanted");
f='scripts/promotion.test.mjs';
rep(f,"    code: { commit: '0123456789abcdef' },","    code: { commit: '0123456789abcdef', vocabVersion: (await import('../packages/suite/core/delivery/vocab.js')).VOCAB_VERSION },");
f='lib/release-suite.js';
rep(f,"import { dirname, join } from 'node:path';","import { dirname, join } from 'node:path';\nimport { ensurePrivateDir, restrictPath } from '../data/private-dir.js';");
rep(f,"  mkdirSync(dirname(file), { recursive: true });\n  writeFileSync(file, `${value}\n`, { mode: 0o600 });\n  try {\n    chmodSync(file, 0o600);\n  } catch {\n    // Windows keeps its own ACLs\n  }\n","  ensurePrivateDir(dirname(file));\n  writeFileSync(file, `${value}\n`, { mode: 0o600 });\n  restrictPath(file);\n");
f='lib/personal-data.js';
rep(f,"  'lib/hot-store.js:path':","  'lib/delivery-guards.js:hotPath(dataDir)': 'Mail guard counters: event times and types only.',\n  'lib/hot-store.js:path':");
f='scripts/personal-data-writers.test.mjs';
rep(f,"writeJsonAtomic|writeTextAtomic|createJsonOnce)","writeJsonAtomic|writeTextAtomic|createJsonOnce|updateHotJson)");
