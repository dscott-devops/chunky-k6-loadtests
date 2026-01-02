// common.js
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

export const ttfb = new Trend('ttfb_ms', true);
export const endpointFail = new Rate('endpoint_fail');

export function randSleep(minSec = 0.3, maxSec = 1.3) {
  const s = minSec + Math.random() * (maxSec - minSec);
  sleep(s);
}

export function getJSON(url, params) {
  const res = http.get(url, params);
  ttfb.add(res.timings.waiting);
  const ok = res.status >= 200 && res.status < 300;
  endpointFail.add(ok ? 0 : 1);
  return res;
}

export function pick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

export function safeJSON(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

export function safeBodyPreview(res, maxLen = 200) {
  try {
    if (!res || typeof res.body !== 'string') return '';
    return res.body.length > maxLen ? res.body.slice(0, maxLen) : res.body;
  } catch {
    return '';
  }
}
