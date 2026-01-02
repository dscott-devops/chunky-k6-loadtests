import http from "k6/http";
import { check, sleep } from "k6";
import { randomIntBetween, randomItem, uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

/**
 * Chunky Sports "True User" scenario
 * Flow per iteration:
 *  1) Guest: GET /lumps/latest
 *  2) Login (unique user per VU): POST /users/login
 *  3) Authorized: GET /lumps/user-teams (after_date sometimes once/twice)
 *  4) Pick 2–5 random teams:
 *      - Public:  GET /lumps/team/:teamId (after_date sometimes once/twice)
 *      - Always together:
 *          Public: GET /games/by-team/:teamId/screen
 *          Auth:   GET /team/:teamId/top
 *      - Sometimes:
 *          Auth:   GET /lumps/summary/team/:teamId
 *
 * Distribution support:
 *  - USER_OFFSET lets you run the same script on multiple loadgens
 *    without reusing the same test users.
 */

// ------------------------
// ENV / CONFIG
// ------------------------
const BASE_URL = __ENV.BASE_URL || "https://api.chunkysports.com/api/v1";
const PASSWORD = __ENV.PASSWORD || "Test1234!";
const USER_DOMAIN = __ENV.USER_DOMAIN || "chunky.test";
const USER_PREFIX = __ENV.USER_PREFIX || "testuser";
const USER_COUNT = parseInt(__ENV.USER_COUNT || "99", 10); // 01..99
const USER_OFFSET = parseInt(__ENV.USER_OFFSET || "0", 10); // per-loadgen offset
const TEST_TAG = __ENV.TEST_TAG || `true_user_${new Date().toISOString()}`;
const DEBUG = (__ENV.DEBUG || "0") === "1";

// endpoint toggles / weights
const PROB_USERTEAMS_REFRESH_TWICE = parseFloat(__ENV.PROB_USERTEAMS_REFRESH_TWICE || "0.25");
const PROB_TEAMFEED_REFRESH_TWICE = parseFloat(__ENV.PROB_TEAMFEED_REFRESH_TWICE || "0.20");
const PROB_DO_SUMMARY = parseFloat(__ENV.PROB_DO_SUMMARY || "0.25");

// “human-ish” pacing (seconds)
const SLEEP_AFTER_LATEST = [0.3, 1.2];
const SLEEP_AFTER_LOGIN = [0.2, 0.8];
const SLEEP_BETWEEN_FEEDS = [0.6, 2.2];
const SLEEP_BETWEEN_TEAM_ACTIONS = [0.4, 1.6];

// Valid team IDs (excluding NFL invalid 33–61, using your list)
const TEAM_IDS = [
  // NFL 1..32 (skip 33..61 invalid)
  1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
  // NBA 63..92
  63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,
  // MLB 93..123 (note: 124 missing in your list)
  93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,
  // NHL 123,125..154 (123 is Ducks in your list; 124 missing)
  123,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,
  // WNBA 156..167, 169, 170
  156,157,158,159,160,161,162,163,164,165,166,167,169,170

];

// ------------------------
// k6 OPTIONS (1 hour)
// ------------------------
export const options = {
  scenarios: {
    true_user: {
      executor: "constant-vus",
      vus: parseInt(__ENV.VUS || "50", 10),
      duration: __ENV.DURATION || "1h",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],           // overall failure rate < 1%
    http_req_duration: ["p(95)<800"],         // tune these to your reality
  },
  tags: {
    test_tag: TEST_TAG,
    test_type: "true_user",
  },
};

function logDebug(msg, obj) {
  if (!DEBUG) return;
  console.log(`[DEBUG true_user] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`);
}

function jitterSleep(minMax) {
  const [min, max] = minMax;
  const t = Math.random() * (max - min) + min;
  sleep(t);
}

function pad4(n) {
  const s = String(n);
  return s.length >= 4 ? s : "0".repeat(4 - s.length) + s;
}

function pickUniqueTeams(count) {
  const picked = new Set();
  while (picked.size < count) {
    picked.add(randomItem(TEAM_IDS));
  }
  return Array.from(picked);
}

function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Test-Tag": TEST_TAG,
      "X-Request-Id": uuidv4(),
    },
    tags: { test_tag: TEST_TAG },
  };
}

function guestHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Test-Tag": TEST_TAG,
      "X-Request-Id": uuidv4(),
    },
    tags: { test_tag: TEST_TAG },
  };
}

function extractAfterDateFromLumps(respJson) {
  // Best-effort: pick newest created_at or updated_at from response lumps list
  // If shape differs, returns null and we just skip after_date refresh.
  try {
    const lumps = respJson?.lumps;
    if (!Array.isArray(lumps) || lumps.length === 0) return null;

    // Prefer updated_at if present, else created_at
    let newest = null;
    for (const l of lumps) {
      const t = l?.updated_at || l?.created_at || null;
      if (!t) continue;
      if (!newest || t > newest) newest = t;
    }
    return newest;
  } catch (_) {
    return null;
  }
}

export default function () {
  // ------------------------
  // Unique user per VU (distributed friendly)
  // ------------------------
  const vuBase = USER_OFFSET + (__VU - 1); // 0-based
  const userNum = (vuBase % USER_COUNT) + 1; // 1..USER_COUNT
  // Pattern you described: testuser00## => 0001..0099 => testuser0001@chunky.test
  const email = `${USER_PREFIX}${pad4(userNum)}@${USER_DOMAIN}`;

  // ------------------------
  // 1) Guest: /lumps/latest
  // ------------------------
  const latestRes = http.get(`${BASE_URL}/lumps/latest`, guestHeaders());
  check(latestRes, {
    "guest /lumps/latest 200": (r) => r.status === 200,
  });
  jitterSleep(SLEEP_AFTER_LATEST);

  // ------------------------
  // 2) Login
  // ------------------------
  const loginPayload = JSON.stringify({ email, password: PASSWORD });

  const loginRes = http.post(`${BASE_URL}/users/login`, loginPayload, guestHeaders());
  const loginOk = check(loginRes, {
    "login 200": (r) => r.status === 200,
  });

  if (!loginOk) {
    // fail-soft: don’t spam the API with downstream auth calls if login fails
    logDebug("login failed", { status: loginRes.status, body: loginRes.body?.slice?.(0, 200) });
    jitterSleep([1.0, 2.5]);
    return;
  }

  const loginJson = loginRes.json();
  const token = loginJson?.token;
  if (!token) {
    logDebug("login missing token", { email });
    jitterSleep([1.0, 2.5]);
    return;
  }

  jitterSleep(SLEEP_AFTER_LOGIN);

  // ------------------------
  // 3) Authorized: /lumps/user-teams (after_date sometimes once/twice)
  // ------------------------
  let userTeamsCursor = null;

  const userTeamsRes1 = http.get(`${BASE_URL}/lumps/user-teams`, authHeaders(token));
  check(userTeamsRes1, {
    "auth /lumps/user-teams 200": (r) => r.status === 200,
  });

  userTeamsCursor = extractAfterDateFromLumps(userTeamsRes1.json()) || null;

  // Sometimes refresh once or twice using after_date
  const doTwice = Math.random() < PROB_USERTEAMS_REFRESH_TWICE;

  if (userTeamsCursor) {
    const userTeamsRes2 = http.get(
      `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(userTeamsCursor)}`,
      authHeaders(token)
    );
    check(userTeamsRes2, {
      "auth /lumps/user-teams after_date 200": (r) => r.status === 200,
    });

    if (doTwice) {
      const userTeamsRes3 = http.get(
        `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(userTeamsCursor)}`,
        authHeaders(token)
      );
      check(userTeamsRes3, {
        "auth /lumps/user-teams after_date x2 200": (r) => r.status === 200,
      });
    }
  }

  jitterSleep(SLEEP_BETWEEN_FEEDS);

  // ------------------------
  // 4) Team hops: 2–5 random teams
  // ------------------------
  const teamCount = randomIntBetween(2, 5);
  const teams = pickUniqueTeams(teamCount);

  for (const teamId of teams) {
    // 4a) Public team feed
    const teamRes1 = http.get(`${BASE_URL}/lumps/team/${teamId}`, guestHeaders());
    check(teamRes1, {
      "guest /lumps/team/:id 200": (r) => r.status === 200,
    });

    // sometimes do after_date refresh once/twice
    const teamCursor = extractAfterDateFromLumps(teamRes1.json()) || null;
    const teamTwice = Math.random() < PROB_TEAMFEED_REFRESH_TWICE;

    if (teamCursor) {
      const teamRes2 = http.get(
        `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(teamCursor)}`,
        guestHeaders()
      );
      check(teamRes2, {
        "guest /lumps/team/:id after_date 200": (r) => r.status === 200,
      });

      if (teamTwice) {
        const teamRes3 = http.get(
          `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(teamCursor)}`,
          guestHeaders()
        );
        check(teamRes3, {
          "guest /lumps/team/:id after_date x2 200": (r) => r.status === 200,
        });
      }
    }

    jitterSleep(SLEEP_BETWEEN_TEAM_ACTIONS);

    // 4b) Always together: games (public) + team top (auth)
    const gamesRes = http.get(`${BASE_URL}/games/by-team/${teamId}/screen`, guestHeaders());
    check(gamesRes, {
      "guest /games/by-team/:id/screen 200": (r) => r.status === 200,
    });

    const topRes = http.get(`${BASE_URL}/lumps/team/${teamId}/top`, authHeaders(token));
    check(topRes, {
      "auth /team/:id/top 200": (r) => r.status === 200,
    });

    // 4c) Sometimes: summary (auth)
    if (Math.random() < PROB_DO_SUMMARY) {
      const sumRes = http.get(`${BASE_URL}/lumps/summary/team/${teamId}`, authHeaders(token));
      check(sumRes, {
        "auth /lumps/summary/team/:id 200": (r) => r.status === 200,
      });
    }

    jitterSleep(SLEEP_BETWEEN_FEEDS);
  }

  // end iteration; loop continues for the full duration
}
