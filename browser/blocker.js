'use strict';

/**
 * blocker.js — lightweight ad / tracker request blocker for Norya browser.
 *
 * Cancels requests to known advertising and tracking hosts at the Electron
 * session level (session.webRequest.onBeforeRequest). This flips EFF Cover Your
 * Tracks' "Blocking tracking ads / invisible trackers" to YES and stops the bulk
 * of real-world trackers — without the weight of a full EasyList engine.
 *
 * Matching: a request is blocked if its hostname equals a listed domain OR is a
 * subdomain of one (host === d || host.endsWith('.' + d)). O(labels) per request.
 *
 * The list is a curated subset of the highest-impact ad/analytics/tracking
 * domains (Disconnect / EasyPrivacy / uBlock heavyweights). Not exhaustive by
 * design — covers what matters for privacy + the EFF test without 100k rules.
 */

// Curated high-impact ad + tracker domains.
const BLOCK_DOMAINS = [
  // Google ads / analytics / tag management
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'pagead2.googlesyndication.com', 'analytics.google.com',
  'g.doubleclick.net', 'stats.g.doubleclick.net', 'adsense.google.com',
  '2mdn.net', 'app-measurement.com', 'firebaseinstallations.googleapis.com',
  // Facebook / Meta tracking
  'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com',
  'graph.facebook.com', 'analytics.facebook.com',
  // Amazon ads
  'amazon-adsystem.com', 'aax.amazon-adsystem.com', 'fls-na.amazon.com',
  // Microsoft / Bing ads
  'bat.bing.com', 'clarity.ms', 'ads.microsoft.com',
  // Major analytics / measurement
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com',
  'mixpanel.com', 'segment.com', 'segment.io', 'amplitude.com',
  'fullstory.com', 'hotjar.com', 'mouseflow.com', 'crazyegg.com',
  'heap.io', 'heapanalytics.com', 'kissmetrics.com', 'chartbeat.com',
  'newrelic.com', 'nr-data.net', 'bugsnag.com', 'sentry.io',
  'matomo.cloud', 'plausible.io', 'statcounter.com', 'hs-analytics.net',
  'mc.yandex.ru', 'yandex.ru', 'top-fwz1.mail.ru',
  // Ad networks / exchanges / SSPs
  'criteo.com', 'criteo.net', 'adnxs.com', 'adsrvr.org', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', 'rlcdn.com', 'taboola.com',
  'outbrain.com', 'sharethrough.com', 'smartadserver.com', 'adform.net',
  'gumgum.com', 'media.net', 'indexww.com', 'bidswitch.net', 'mathtag.com',
  'serving-sys.com', 'flashtalking.com', 'teads.tv', 'spotxchange.com',
  'spotx.tv', 'moatads.com', 'adroll.com', 'bluekai.com', 'agkn.com',
  'demdex.net', 'everesttech.net', 'omtrdc.net', 'adobedtm.com',
  'krxd.net', 'turn.com', 'tapad.com', 'liadm.com', 'crwdcntrl.net',
  'exelator.com', 'eyeota.net', 'pippio.com', 'narrative.io', 'id5-sync.com',
  'zorosrv.com', 'sundaysky.com', 'yieldmo.com', 'districtm.io',
  '3lift.com', 'contextweb.com', 'gammaplatform.com', 'lijit.com',
  'sonobi.com', 'gemius.pl', 'onaudience.com', 'adscale.de',
  // Social widgets / sharing trackers
  'platform.twitter.com', 'analytics.twitter.com', 'ads-twitter.com',
  't.co', 'addthis.com', 'sharethis.com', 'disqusads.com',
  'snap.licdn.com', 'px.ads.linkedin.com', 'bizographics.com',
  'analytics.tiktok.com', 'ads.tiktok.com', 'business-api.tiktok.com',
  'ads.pinterest.com', 'ct.pinterest.com', 'log.pinterest.com',
  // Tag / consent / misc tracking
  'cdn.cookielaw.org', 'onetrust.com', 'cookiebot.com', 'usercentrics.eu',
  'branch.io', 'adjust.com', 'appsflyer.com', 'kochava.com', 'singular.net',
  'bounceexchange.com', 'optimizely.com', 'omappapi.com', 'cdn.optimizely.com',
  'tiqcdn.com', 'tealiumiq.com', 'ensighten.com', 'evidon.com',
  'parsely.com', 'zqtk.net', 'go-mpulse.net', 'd41chssnpqdne.cloudfront.net',
  'cdn.permutive.com', 'permutive.com', 'cdn.confiant-integrations.net',
  'btttag.com', 'inmobi.com', 'mopub.com', 'unityads.unity3d.com',
  'applovin.com', 'adcolony.com', 'vungle.com', 'chartboost.com',
  'pubnative.net', 'smaato.net', 'fyber.com', 'inner-active.mobi',
];

// Build a Set for O(1) lookups.
const BLOCK_SET = new Set(BLOCK_DOMAINS);

/**
 * Is this hostname a blocked tracker/ad host (exact or subdomain)?
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (BLOCK_SET.has(h)) return true;
  // Walk parent domains: a.b.doubleclick.net → b.doubleclick.net → doubleclick.net
  let idx = h.indexOf('.');
  while (idx !== -1) {
    const parent = h.slice(idx + 1);
    if (BLOCK_SET.has(parent)) return true;
    idx = h.indexOf('.', idx + 1);
  }
  return false;
}

/**
 * Register the blocker on an Electron session. Idempotent-ish: replaces any
 * existing onBeforeRequest filter on the session.
 *
 * @param {Electron.Session} session
 * @param {{ enabled?: boolean }} [opts]
 * @returns {{ count: () => number }} a handle exposing how many requests blocked
 */
function applyBlocker(session, { enabled = true } = {}) {
  let blocked = 0;
  if (!enabled) {
    try { session.webRequest.onBeforeRequest(null); } catch {}
    return { count: () => 0 };
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch {}
    if (host && isBlockedHost(host)) {
      blocked++;
      return callback({ cancel: true });
    }
    callback({});
  });
  return { count: () => blocked };
}

module.exports = { applyBlocker, isBlockedHost, BLOCK_DOMAINS };
