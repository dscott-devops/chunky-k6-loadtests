// mobile_guest.js (guest-safe prod + games failure instrumentation)
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
    mobile_step: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 200 },
        { duration: '2m', target: 600 },
        { duration: '2m', target: 1200 },
        { duration: '2m', target: 2400 },
        { duration: '2m', target: 0 }
      ],
      gracefulRampDown: '20s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1800'],
    games_fail_5xx: ['count<250'] // generous; diagnosing first
  }
};

export default function () {
  const headers = {
    'User-Agent': 'ChunkySports-MobileLoadTest/1.0 (Expo)',
    'Accept': 'application/json',
    'X-Loadtest': __ENV.TEST_TAG || 'chunky-k6-guest'
  };

  // Launch-like burst: latest -> team -> games
  let res = getJSON(`${BASE}/api/v1/lumps/latest`, { headers });
  check(res, { 'latest 2xx': (r) => r.status >= 200 && r.status < 300 });

  const body = safeJSON(res);
  let teamId = 5;
  if (body && Array.isArray(body.lumps)) {
    const any = pick(body.lumps);
    if (any && (any.source_id || any.team_id)) teamId = (any.team_id || any.source_id);
  }

  randSleep(0.2, 0.8);

  res = getJSON(`${BASE}/api/v1/lumps/team/${teamId}`, { headers });
  check(res, { 'team 2xx': (r) => r.status >= 200 && r.status < 300 });

  randSleep(0.2, 0.8);

  res = getJSON(`${BASE}/api/v1/games/by-team/${teamId}/screen`, { headers });

  const ok = res.status >= 200 && res.status < 300;
  check(res, { 'games 2xx': () => ok });

  if (!ok) {
    if (res.status >= 400 && res.status < 500) games_fail_4xx.add(1);
    else if (res.status >= 500 && res.status < 600) games_fail_5xx.add(1);
    else games_fail_other.add(1);

    if (games_fail_logged.value < 10) {
      console.log(`GAMES_FAIL teamId=${teamId} status=${res.status} body="${safeBodyPreview(res, 200)}"`);
      games_fail_logged.add(1);
    }
  }

  // idle time
  randSleep(1.0, 3.0);
}
