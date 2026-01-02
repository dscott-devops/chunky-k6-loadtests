// blended.js
import webFlow from './web_guest.js';
import mobileFlow from './mobile_guest.js';

export const options = {
  scenarios: {
    web: {
      executor: 'ramping-vus',
      exec: 'webScenario',
      startVUs: 5,
      stages: [
        { duration: '2m', target: 40 },
        { duration: '3m', target: 80 },
        { duration: '3m', target: 120 },
        { duration: '3m', target: 160 },
        { duration: '2m', target: 0 }
      ]
    },
    mobile: {
      executor: 'ramping-vus',
      exec: 'mobileScenario',
      startVUs: 3,
      stages: [
        { duration: '2m', target: 15 },
        { duration: '3m', target: 35 },
        { duration: '3m', target: 50 },
        { duration: '3m', target: 65 },
        { duration: '2m', target: 0 }
      ]
    }
  }
};

export function webScenario() {
  return webFlow();
}

export function mobileScenario() {
  return mobileFlow();
}

