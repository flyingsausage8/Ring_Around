// Find companies to call.
//
//   node find.js                    live search, Redmond area
//   node find.js --fixture          the saved list, offline
//   node find.js --query "..."      search for something else
//   node find.js --area "..."       somewhere else
//   node find.js --save             overwrite contractors.local.json
//
// Nothing here dials anything. It prints a list and optionally saves it.

import fs from 'node:fs';
import { cfg } from './config.js';
import { discover, printContractors, rank } from './discovery.js';
import * as log from './log.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const source = flag('fixture') ? 'fixture' : 'places';
const query = arg('query', 'appliance repair');
const area = arg('area', `${cfg.job.area} ${cfg.job.zip}`.trim());
const limit = Number(arg('limit', 10)) || 10;

try {
  const list = await discover({ source, query, area, limit });

  if (!list.length) {
    log.warn('discovery', 'nothing came back with a dialable number');
    process.exit(1);
  }

  console.log('');
  console.log(`  Best first - a rating counts for more once enough people have left one.`);
  console.log('');
  printContractors(list);
  console.log('');

  if (flag('save')) {
    if (source !== 'places') {
      log.fail('discovery', 'refusing to save the fixture back over itself');
      process.exit(1);
    }
    const out = {
      _readme: 'Real businesses, saved from a Google Places search. Gitignored on purpose.',
      _fetched: new Date().toISOString(),
      _query: `${query} in ${area}`,
      appliance_repair: list.map((c) => ({
        name: c.name,
        phone: c.phoneRaw,
        address: c.address,
        rating: c.rating,
        reviews: c.reviews,
        placeId: c.placeId,
      })),
    };
    fs.writeFileSync('contractors.local.json', JSON.stringify(out, null, 2));
    log.info('discovery', `saved ${list.length} to contractors.local.json`);
  }
} catch (err) {
  log.fail('DISCOVERY_SEARCH', err.message);
  console.log('\nNo list, and no stale fallback either - fix the above and try again.');
  console.log('To work offline against the saved list: node find.js --fixture\n');
  process.exit(1);
}
