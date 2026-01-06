import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import {
  randomIntBetween,
  randomItem,
  uuidv4,
} from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

/**
 * Chunky Sports "True User" scenario
 * Flow per iteration:
 *  1) Guest: GET /lumps/latest   (+ comments threads for 3 lump_ids)
 *  2) Login (unique user per VU): POST /users/login
 *  3) Authorized: GET /lumps/user-teams (after_date sometimes once/twice)
 *     (+ comments threads for 3 lump_ids each time)
 *  4) Pick 2–5 random teams:
 *      - Public:  GET /lumps/team/:teamId (after_date sometimes once/twice)
 *        (+ comments threads for 3 lump_ids each time)
 *      - Always together:
 *          Public: GET /games/by-team/:teamId/screen
 *          Auth:   GET /lumps/team/:teamId/top
 *      - Sometimes:
 *          Auth:   GET /lumps/summary/team/:teamId
 *
 * NOTE:
 *  - Adds custom per-endpoint metrics (duration, fail rate, req count),
 *    and prints them in a compact summary at the end.
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
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  // NBA 63..92
  63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
  81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
  // MLB 93..123 (note: 124 missing in your list)
  93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123,
  // NHL 123,125..154 (123 is Ducks in your list; 124 missing)
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
// We record these per request so we can compare:
// - connecting: TCP connect time (client -> ALB)
// - tls: TLS handshake time
// - waiting: time to first byte (server processing + upstream waits)
const T_CONNECTING = new Trend("timing_connecting", true);
const T_TLS = new Trend("timing_tls_handshaking", true);
const T_WAITING = new Trend("timing_waiting", true);


// ------------------------
// Per-endpoint custom metrics
// ------------------------
// We keep these as separate metrics so they appear in the end summary,
// AND we also print a compact custom table in handleSummary().
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
  // k6 timings are in ms
  // See: https://k6.io/docs/javascript-api/k6-http/response/#timings
  try {
    const t = res?.timings || {};
    if (Number.isFinite(t.connecting)) T_CONNECTING.add(t.connecting);
    if (Number.isFinite(t.tls_handshaking)) T_TLS.add(t.tls_handshaking);
    if (Number.isFinite(t.waiting)) T_WAITING.add(t.waiting);
  } catch (_) {
    // no-op
  }
}


// Optional: a global rate you can use in thresholds later if you want.
// (Not required for the table.)
const epAnyFailRate = new Rate("ep_any_fail_rate");

function recordEndpoint(epObj, res) {
  epObj.reqs.add(1);
  epObj.dur.add(res.timings.duration);

  // Record global timing components for this request
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

/**
 * Extract up to N "valid" lump ids from a feed response.
 * Supports common shapes:
 *  - { lumps: [{ id, ... }, ...] }
 *  - { top_lumps: [...] } (best-effort)
 */
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

/**
 * Call /comments/thread for each lump_id.
 * Tracks per-endpoint metrics + checks.
 */
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

/**
 * Wrapper: every time you hit a feed endpoint, ALSO hit comments/thread
 * for up to COMMENTS_PER_FEED valid lump ids from that response.
 *
 * Also records per-endpoint metrics for the feed itself.
 */
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
  // 2) Login
  // ------------------------
  const loginPayload = JSON.stringify({ email, password: PASSWORD });
  const loginRes = http.post(
    `${BASE_URL}/users/login`,
    loginPayload,
    guestHeaders()
  );
  recordEndpoint(EP.login, loginRes);

  const loginOk = check(loginRes, {
    "login 200": (r) => r.status === 200,
  });

  if (!loginOk) {
    logDebug("login failed", {
      status: loginRes.status,
      body: loginRes.body?.slice?.(0, 200),
    });
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
  // 3) Authorized: /lumps/user-teams (+ comments threads)
  // ------------------------
  const authReq = authHeaders(token);

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
      `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(
        userTeamsCursor
      )}`,
      authReq,
      "auth /lumps/user-teams after_date",
      EP.userTeams
    );

    if (doTwice) {
      getFeedWithComments(
        `${BASE_URL}/lumps/user-teams?after_date=${encodeURIComponent(
          userTeamsCursor
        )}`,
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
        `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(
          teamCursor
        )}`,
        guestHeaders(),
        `guest /lumps/team/${teamId} after_date`,
        EP.teamFeed
      );

      if (teamTwice) {
        getFeedWithComments(
          `${BASE_URL}/lumps/team/${teamId}?after_date=${encodeURIComponent(
            teamCursor
          )}`,
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
      const sumRes = http.get(
        `${BASE_URL}/lumps/summary/team/${teamId}`,
        authReq
      );
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
    epRowFromData(data, "POST /users/login", "ep_login"),
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
    // Keep default stdout summary AND append our table.
    // ------------------------
  // Global timing breakdown line
  // ------------------------
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
