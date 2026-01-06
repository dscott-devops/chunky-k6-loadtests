// loadtests/true_user.js

/**
 * JSDOC BEGIN
 * @file loadtests/true_user.js
 * @kind k6_test
 * @group LoadTest
 * @summary Chunky Sports “True User” scenario with one login per VU and /users/me re-hydration checks.
 *
 * @description
 * Scenario 1 behavior:
 *  - Each VU logs in ONCE to obtain a token (unless token becomes invalid/expired).
 *  - After login, immediately calls GET /users/me to validate token + simulate app bootstrap re-hydration.
 *  - On subsequent iterations, skips login and calls GET /users/me once per iteration.
 *  - If /users/me returns 401/403, the VU re-logins and continues.
 *
 * Original flow per iteration (preserved):
 *  1) Guest: GET /lumps/latest (+ comments threads for 3 lump_ids)
 *  2) (Now: login once per VU) POST /users/login (only if token missing/invalid)
 *  2b) (New) Auth re-hydration: GET /users/me (same payload shape as login)
 *  3) Authorized: GET /lumps/user-teams (after_date sometimes once/twice) (+ comments threads)
 *  4) Pick 2–5 random teams:
 *      - Public:  GET /lumps/team/:teamId (after_date sometimes once/twice) (+ comments threads)
 *      - Always together:
 *          Public: GET /games/by-team/:teamId/screen
 *          Auth:   GET /lumps/team/:teamId/top
 *      - Sometimes:
 *          Auth:   GET /lumps/summary/team/:teamId
 *
 * Observability:
 *  - Per-endpoint metrics: req count, fail count, duration (avg/p90/p95/max).
 *  - Global timing breakdown: connecting, tls_handshaking, waiting.
 *  - Compact custom table printed in handleSummary().
 *
 * @changelog
 *  - 2026-01-05: Scenario 1: token cached per VU (one login per VU) + added GET /users/me after login and once per iteration.
 *  - 2026-01-05: Added EP.me per-endpoint metrics and included in custom summary table.
 * JSDOC END
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import {
  randomIntBetween,
  randomItem,
  uuidv4,
} from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

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
const PROB_USERTEAMS_REFRESH_TWICE = parseFloat(
  __ENV.PROB_USERTEAMS_REFRESH_TWICE || "0.25"
);
const PROB_TEAMFEED_REFRESH_TWICE = parseFloat(
  __ENV.PROB_TEAMFEED_REFRESH_TWICE || "0.20"
);
const PROB_DO_SUMMARY = parseFloat(__ENV.PROB_DO_SUMMARY || "0.25");

// Comments thread behavior (always 3 if possible)
const COMMENTS_PER_FEED = parseInt(__ENV.COMMENTS_PER_FEED || "3", 10);

// “human-ish” pacing (seconds)
const SLEEP_AFTER_LATEST = [0.3, 1.2];
const SLEEP_AFTER_LOGIN = [0.2, 0.8];
const SLEEP_BETWEEN_FEEDS = [0.6, 2.2];
const SLEEP_BETWEEN_TEAM_ACTIONS = [0.4, 1.6];

// Valid team IDs (excluding NFL invalid 33–61, using your list)
const TEAM_IDS = [
  // NFL 1..32 (skip 33..61 invalid)
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  // NBA 63..92
  63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
  81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
  // MLB 93..123
  93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123,
  // NHL 123,125..154
  123, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138,
  139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153,
  154,
  // WNBA 156..167, 169, 170
  156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 169, 170,
];

// ------------------------
// k6 OPTIONS
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
    http_req_failed: ["rate<0.01"], // overall failure rate < 1%
    http_req_duration: ["p(95)<800"], // tune to your reality
  },
  tags: {
    test_tag: TEST_TAG,
    test_type: "true_user",
  },
};

// ------------------------
// Global timing breakdown (client-side components)
// ------------------------
const T_CONNECTING = new Trend("timing_connecting", true);
const T_TLS = new Trend("timing_tls_handshaking", true);
const T_WAITING = new Trend("timing_waiting", true);

// ------------------------
// Per-endpoint custom metrics
// ------------------------
const EP = {
  latest: {
    reqs: new Counter("ep_latest_reqs"),
    fails: new Counter("ep_latest_fails"),
    dur: new Trend("ep_latest_duration", true),
  },
  login: {
    reqs: new Counter("ep_login_reqs"),
    fails: new Counter("ep_login_fails"),
    dur: new Trend("ep_login_duration", true),
  },
  me: {
    reqs: new Counter("ep_me_reqs"),
    fails: new Counter("ep_me_fails"),
    dur: new Trend("ep_me_duration", true),
  },
  userTeams: {
    reqs: new Counter("ep_user_teams_reqs"),
    fails: new Counter("ep_user_teams_fails"),
    dur: new Trend("ep_user_teams_duration", true),
  },
  teamFeed: {
    reqs: new Counter("ep_team_feed_reqs"),
    fails: new Counter("ep_team_feed_fails"),
    dur: new Trend("ep_team_feed_duration", true),
  },
  gamesScreen: {
    reqs: new Counter("ep_games_screen_reqs"),
    fails: new Counter("ep_games_screen_fails"),
    dur: new Trend("ep_games_screen_duration", true),
  },
  teamTop: {
    reqs: new Counter("ep_team_top_reqs"),
    fails: new Counter("ep_team_top_fails"),
    dur: new Trend("ep_team_top_duration", true),
  },
  summary: {
    reqs: new Counter("ep_summary_reqs"),
    fails: new Counter("ep_summary_fails"),
    dur: new Trend("ep_summary_duration", true),
  },
  comments: {
    reqs: new Counter("ep_comments_reqs"),
    fails: new Counter("ep_comments_fails"),
    dur: new Trend("ep_comments_duration", true),
  },
};

function recordTimingBreakdown(res) {
  try {
    const t = res?.timings || {};
    if (Number.isFinite(t.connecting)) T_CONNECTING.add(t.connecting);
    if (Number.isFinite(t.tls_handshaking)) T_TLS.add(t.tls_handshaking);
    if (Number.isFinite(t.waiting)) T_WAITING.add(t.waiting);
  } catch (_) {
    // no-op
  }
}

const epAnyFailRate = new Rate("ep_any_fail_rate");

function recordEndpoint(epObj, res) {
  epObj.reqs.add(1);
  epObj.dur.add(res.timings.duration);
  recordTimingBreakdown(res);

  const failed = res.status < 200 || res.status >= 300;
  if (failed) epObj.fails.add(1);
  epAnyFailRate.add(failed ? 1 : 0);
}

function logDebug(msg, obj) {
  if (!DEBUG) return;
  console.log(
    `[DEBUG true_user] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`
  );
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
  try {
    const lumps = respJson?.lumps;
    if (!Array.isArray(lumps) || lumps.length === 0) return null;

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

function extractLumpIds(respJson, maxIds) {
  try {
    const candidates =
      (Array.isArray(respJson?.lumps) && respJson.lumps) ||
      (Array.isArray(respJson?.top_lumps) && respJson.top_lumps) ||
      [];

    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    const out = [];
    const seen = new Set();

    for (const item of candidates) {
      const raw = item?.id ?? item?.lump_id ?? null;
      if (raw === null || raw === undefined) continue;

      const idNum = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;

      if (seen.has(idNum)) continue;
      seen.add(idNum);
      out.push(idNum);

      if (out.length >= maxIds) break;
    }

    return out;
  } catch (_) {
    return [];
  }
}

function hitCommentsThreads(lumpIds, reqParams, labelPrefix) {
  for (let i = 0; i < lumpIds.length; i++) {
    const lumpId = lumpIds[i];

    const r = http.get(
      `${BASE_URL}/comments/thread?lump_id=${encodeURIComponent(lumpId)}`,
      reqParams
    );
    recordEndpoint(EP.comments, r);

    check(r, {
      [`${labelPrefix} /comments/thread 200`]: (x) => x.status === 200,
      [`${labelPrefix} /comments/thread ok true`]: (x) => {
        try {
          const j = x.json();
          return j?.ok === true;
        } catch (_) {
          return false;
        }
      },
      [`${labelPrefix} /comments/thread lump_id match`]: (x) => {
        try {
          const j = x.json();
          return Number(j?.lump_id) === Number(lumpId);
        } catch (_) {
          return false;
        }
      },
    });
  }
}

function getFeedWithComments(url, reqParams, feedLabel, epMetricObj) {
  const res = http.get(url, reqParams);
  if (epMetricObj) recordEndpoint(epMetricObj, res);

  check(res, {
    [`${feedLabel} 200`]: (r) => r.status === 200,
  });

  if (res.status === 200) {
    let j = null;
    try {
      j = res.json();
    } catch (e) {
      logDebug("feed json parse failed", { feedLabel, url });
      return { res, json: null, lumpIds: [], cursor: null };
    }

    const lumpIds = extractLumpIds(j, COMMENTS_PER_FEED);
    if (lumpIds.length > 0) {
      hitCommentsThreads(lumpIds, reqParams, `${feedLabel} (${lumpIds.length})`);
    } else {
      logDebug("no valid lump ids found for comments", { feedLabel, url });
    }

    return {
      res,
      json: j,
      lumpIds,
      cursor: extractAfterDateFromLumps(j) || null,
    };
  }

  return { res, json: null, lumpIds: [], cursor: null };
}

/**
 * Scenario 1 auth:
 * - Login once per VU (token cached in VU runtime)
 * - Then /users/me after login
 * - Each iteration runs /users/me once to simulate re-hydration checks
 * - If /users/me returns 401/403, token is invalidated and re-login occurs
 */
let VU_TOKEN = null;

function doLogin(email) {
  const loginPayload = JSON.stringify({ email, password: PASSWORD });
  const loginRes = http.post(`${BASE_URL}/users/login`, loginPayload, guestHeaders());
  recordEndpoint(EP.login, loginRes);

  const ok = check(loginRes, {
    "login 200": (r) => r.status === 200,
  });

  if (!ok) {
    logDebug("login failed", {
      email,
      status: loginRes.status,
      body: loginRes.body?.slice?.(0, 200),
    });
    return null;
  }

  let j = null;
  try {
    j = loginRes.json();
  } catch (_) {
    logDebug("login json parse failed", { email });
    return null;
  }

  const token = j?.token || null;
  if (!token) {
    logDebug("login missing token", { email });
    return null;
  }

  return token;
}

function doUsersMe(token) {
  const req = authHeaders(token);
  const meRes = http.get(`${BASE_URL}/users/me`, req);
  recordEndpoint(EP.me, meRes);

  const ok = check(meRes, {
    "users/me 200": (r) => r.status === 200,
  });

  // If token is invalid/expired, signal caller to re-login.
  if (!ok && (meRes.status === 401 || meRes.status === 403)) {
    logDebug("users/me unauthorized", { status: meRes.status });
    return { ok: false, invalidToken: true, res: meRes };
  }

  return { ok, invalidToken: false, res: meRes };
}

export default function () {
  // ------------------------
  // Unique user per VU (distributed friendly)
  // ------------------------
  const vuBase = USER_OFFSET + (__VU - 1); // 0-based
  const userNum = (vuBase % USER_COUNT) + 1; // 1..USER_COUNT
  const email = `${USER_PREFIX}${pad4(userNum)}@${USER_DOMAIN}`;

  // ------------------------
  // 1) Guest: /lumps/latest (+ comments threads)
  // ------------------------
  getFeedWithComments(
    `${BASE_URL}/lumps/latest`,
    guestHeaders(),
    "guest /lumps/latest",
    EP.latest
  );
  jitterSleep(SLEEP_AFTER_LATEST);

  // ------------------------
  // 2) Auth bootstrap:
  //    - Login ONCE per VU (cached token), unless missing/invalid
  //    - Always hit /users/me once per iteration (realistic “rehydrate”)
  // ------------------------
  if (!VU_TOKEN) {
    VU_TOKEN = doLogin(email);
    if (!VU_TOKEN) {
      jitterSleep([1.0, 2.5]);
      return;
    }
    jitterSleep(SLEEP_AFTER_LOGIN);

    // Immediately validate + rehydrate after login
    const meAfterLogin = doUsersMe(VU_TOKEN);
    if (meAfterLogin.invalidToken) {
      VU_TOKEN = null;
      jitterSleep([1.0, 2.5]);
      return;
    }
  }

  // Per-iteration re-hydration check (token saved, app starts, /users/me called)
  const meThisIter = doUsersMe(VU_TOKEN);
  if (meThisIter.invalidToken) {
    // Token expired/invalid; re-login and continue next iteration
    VU_TOKEN = null;
    jitterSleep([0.8, 1.8]);
    return;
  }

  const authReq = authHeaders(VU_TOKEN);

  // ------------------------
  // 3) Authorized: /lumps/user-teams (+ comments threads)
  // ------------------------
  const ut1 = getFeedWithComments(
    `${BASE_URL}/lumps/user-teams`,
    authReq,
    "auth /lumps/user-teams",
    EP.userTeams
  );

  const userTeamsCursor = ut1.cursor;
  const doTwice = Math.random() < PROB_USERTEAMS_REFRESH_TWICE;

  if (userTeamsCursor) {
    getFeedWithComments(
      `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(userTeamsCursor)}`,
      authReq,
      "auth /lumps/user-teams after_date",
      EP.userTeams
    );

    if (doTwice) {
      getFeedWithComments(
        `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(userTeamsCursor)}`,
        authReq,
        "auth /lumps/user-teams after_date x2",
        EP.userTeams
      );
    }
  }

  jitterSleep(SLEEP_BETWEEN_FEEDS);

  // ------------------------
  // 4) Team hops: 2–5 random teams
  // ------------------------
  const teamCount = randomIntBetween(2, 5);
  const teams = pickUniqueTeams(teamCount);

  for (const teamId of teams) {
    // 4a) Public team feed (+ comments threads)
    const tf1 = getFeedWithComments(
      `${BASE_URL}/lumps/team/${teamId}`,
      guestHeaders(),
      `guest /lumps/team/${teamId}`,
      EP.teamFeed
    );

    // sometimes do after_date refresh once/twice
    const teamCursor = tf1.cursor;
    const teamTwice = Math.random() < PROB_TEAMFEED_REFRESH_TWICE;

    if (teamCursor) {
      getFeedWithComments(
        `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(teamCursor)}`,
        guestHeaders(),
        `guest /lumps/team/${teamId} after_date`,
        EP.teamFeed
      );

      if (teamTwice) {
        getFeedWithComments(
          `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(teamCursor)}`,
          guestHeaders(),
          `guest /lumps/team/${teamId} after_date x2`,
          EP.teamFeed
        );
      }
    }

    jitterSleep(SLEEP_BETWEEN_TEAM_ACTIONS);

    // 4b) Always together: games (public) + team top (auth)
    const gamesRes = http.get(
      `${BASE_URL}/games/by-team/${teamId}/screen`,
      guestHeaders()
    );
    recordEndpoint(EP.gamesScreen, gamesRes);

    check(gamesRes, {
      "guest /games/by-team/:id/screen 200": (r) => r.status === 200,
    });

    const topRes = http.get(`${BASE_URL}/lumps/team/${teamId}/top`, authReq);
    recordEndpoint(EP.teamTop, topRes);

    check(topRes, {
      "auth /team/:id/top 200": (r) => r.status === 200,
    });

    // 4c) Sometimes: summary (auth)
    if (Math.random() < PROB_DO_SUMMARY) {
      const sumRes = http.get(`${BASE_URL}/lumps/summary/team/${teamId}`, authReq);
      recordEndpoint(EP.summary, sumRes);

      check(sumRes, {
        "auth /lumps/summary/team/:id 200": (r) => r.status === 200,
      });
    }

    jitterSleep(SLEEP_BETWEEN_FEEDS);
  }
}

// ------------------------
// Custom end-of-test summary table
// ------------------------
function fmtMs(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return `${x.toFixed(1)}ms`;
}
function fmtPct(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return `${(x * 100).toFixed(2)}%`;
}
function fmtInt(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return `${Math.round(x)}`;
}

function metricVals(data, metricName) {
  const v = data?.metrics?.[metricName]?.values || null;
  return v || null;
}

function fmtTimingLine(label, v) {
  if (!v) return `${label}: -`;
  const avg = v.avg ?? null;
  const p90 = v["p(90)"] ?? null;
  const p95 = v["p(95)"] ?? null;
  const max = v.max ?? null;
  return `${label}: avg=${fmtMs(avg)} p90=${fmtMs(p90)} p95=${fmtMs(p95)} max=${fmtMs(max)}`;
}

function epRowFromData(data, name, prefix) {
  const reqs = data.metrics[`${prefix}_reqs`]?.values?.count ?? 0;
  const fails = data.metrics[`${prefix}_fails`]?.values?.count ?? 0;

  const dur = data.metrics[`${prefix}_duration`]?.values || {};
  const avg = dur.avg ?? null;
  const p90 = dur["p(90)"] ?? null;
  const p95 = dur["p(95)"] ?? null;
  const max = dur.max ?? null;

  const failRate = reqs > 0 ? fails / reqs : 0;

  return {
    name,
    reqs,
    fails,
    failRate,
    avg,
    p90,
    p95,
    max,
  };
}

export function handleSummary(data) {
  const rows = [
    epRowFromData(data, "GET /lumps/latest", "ep_latest"),
    epRowFromData(data, "POST /users/login (once per VU)", "ep_login"),
    epRowFromData(data, "GET /users/me", "ep_me"),
    epRowFromData(data, "GET /lumps/user-teams (+after)", "ep_user_teams"),
    epRowFromData(data, "GET /lumps/team/:id (+after)", "ep_team_feed"),
    epRowFromData(data, "GET /games/by-team/:id/screen", "ep_games_screen"),
    epRowFromData(data, "GET /lumps/team/:id/top", "ep_team_top"),
    epRowFromData(data, "GET /lumps/summary/team/:id", "ep_summary"),
    epRowFromData(data, "GET /comments/thread", "ep_comments"),
  ];

  const header =
    "\n=== Per-endpoint summary (custom) ===\n" +
    "endpoint | reqs | fails | fail% | avg | p90 | p95 | max\n" +
    "-------- | ----:| ----:| -----:| ----:| ---:| ---:| ---:\n";

  const lines = rows
    .map((r) => {
      return [
        r.name,
        fmtInt(r.reqs).padStart(4),
        fmtInt(r.fails).padStart(4),
        fmtPct(r.failRate).padStart(6),
        fmtMs(r.avg).padStart(8),
        fmtMs(r.p90).padStart(8),
        fmtMs(r.p95).padStart(8),
        fmtMs(r.max).padStart(8),
      ].join(" | ");
    })
    .join("\n");

  const vConn = metricVals(data, "timing_connecting");
  const vTls = metricVals(data, "timing_tls_handshaking");
  const vWait = metricVals(data, "timing_waiting");

  const timingLine =
    "\n=== TIMINGS breakdown (global) ===\n" +
    fmtTimingLine("connecting", vConn) + "\n" +
    fmtTimingLine("tls_handshaking", vTls) + "\n" +
    fmtTimingLine("waiting", vWait) + "\n\n";

  const text = header + lines + "\n" + timingLine;

  return {
    stdout: text,
  };
}
