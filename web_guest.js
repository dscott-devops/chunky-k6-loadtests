// web_guest.js (guest-safe prod + games failure instrumentation)
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { randSleep, getJSON, safeJSON, pick, safeBodyPreview } from './common.js';

const BASE = __ENV.BASE_URL || 'https://api.chunkysports.com';

const games_fail_4xx = new Counter('games_fail_4xx');
const games_fail_5xx = new Counter('games_fail_5xx');
const games_fail_other = new Counter('games_fail_other');
const games_fail_logged = new Counter('games_fail_logged');

export const options = {
  scenarios: {
    web_step: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '2m', target: 200 },
        { duration: '3m', target: 400 },
        { duration: '3m', target: 1000 },
        { duration: '3m', target: 2000 },
        { duration: '2m', target: 0 }
      ],
      gracefulRampDown: '30s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
    games_fail_5xx: ['count<200'] // keep generous; we’re diagnosing first
  }
};

export default function () {
  const headers = {
    'User-Agent': 'ChunkySports-WebLoadTest/1.0',
    'Accept': 'application/json',
    'X-Loadtest': __ENV.TEST_TAG || 'chunky-k6-guest'
  };

  // 1) Latest
  let res = getJSON(`${BASE}/api/v1/lumps/latest`, { headers });
  check(res, { 'latest 2xx': (r) => r.status >= 200 && r.status < 300 });
  randSleep();

  // Derive teamId if possible (fallback to 5)
  const body = safeJSON(res);
  let teamId = 5;
  if (body && Array.isArray(body.lumps)) {
    const any = pick(body.lumps);
    if (any && (any.source_id || any.team_id)) teamId = (any.team_id || any.source_id);
  }

  // 2) Team feed (guest-safe)
  res = getJSON(`${BASE}/api/v1/lumps/team/${teamId}`, { headers });
  check(res, { 'team 2xx': (r) => r.status >= 200 && r.status < 300 });
  randSleep(0.6, 1.8);

  // 3) Games screen (guest-safe) with failure classification
  res = getJSON(`${BASE}/api/v1/games/by-team/${teamId}/screen`, { headers });

  const ok = res.status >= 200 && res.status < 300;
  check(res, { 'games 2xx': () => ok });

  if (!ok) {
    if (res.status >= 400 && res.status < 500) games_fail_4xx.add(1);
    else if (res.status >= 500 && res.status < 600) games_fail_5xx.add(1);
    else games_fail_other.add(1);

    // Log a tiny sample (max 10)
    if (games_fail_logged.value < 10) {
      console.log(`GAMES_FAIL teamId=${teamId} status=${res.status} body="${safeBodyPreview(res, 200)}"`);
      games_fail_logged.add(1);
    }
  }

  randSleep(1.0, 2.5);
}
