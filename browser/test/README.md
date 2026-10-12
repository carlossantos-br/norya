# Norya Browser Smoke Tests

End-to-end smoke harness for the per-profile anonymous browser feature.
Two modes: module-level tests (no Electron required) and live integration tests.

---

## Mode A: Module tests (no Electron needed)

```
node app/browser/test/smoke.js --module
```

Tests each browser module in isolation using plain Node.js `require()` calls.
No Electron, no running app.

**What is tested:**

| Test | Module | Checks |
|------|--------|--------|
| `tor.*` | TorManager | Spawn, getStatus (IP + country), newCircuit, killForProfile |
| `hardener.*` | PrivacyHardener | getNoiseSeed determinism, getRandomUserAgent UA format, getPreloadArgs array shape |
| `auth_router.*` | AuthFlowRouter | start (socket path + env), auth-url event, stop removes socket |
| `ext_loader.*` | ExtensionLoader | addExtension with synthetic manifest, list |

**Tor binary requirement:**

TorManager tests only run if the binary exists at:

```
app/bin/tor/darwin-arm64/tor   (macOS Apple Silicon)
```

If not found those tests are skipped with a `[SKIP]` line.

---

## Mode B: Live integration tests

```
REAL_IP=<your-real-ip> node app/browser/test/smoke.js --running
```

Requires Norya running with the browser feature integrated AND at least one
profile's browser panel opened so the Unix socket exists.

**Default profile:** 1  
**Override:** `NORYA_TEST_PROFILE=N` to test a different profile.

**What is tested (connects to the per-user socket from `MCPServer.socketPathFor()`):**

| Test | Checks |
|------|--------|
| `running.socket_exists` | Socket file exists |
| `running.browser_open` | browser_open returns tab ID |
| `running.tor_exit_ip` | body text from api.ipify.org is a valid IP; differs from `REAL_IP` |
| `running.screenshot` | File returned by browser_screenshot exists and is non-empty |
| `running.ua_not_electron` | navigator.userAgent contains "Chrome" but not "electron" |
| `running.canvas_stable_same_tab` | Canvas fingerprint is stable within the same tab/session |
| `running.list_tabs` | browser_list_tabs returns at least 1 tab |
| `running.close_tab` | browser_close_tab succeeds |

**Environment variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `REAL_IP` | _(none)_ | Your real public IP for the Tor anonymity check. If unset, IP check is skipped |
| `NORYA_TEST_PROFILE` | `1` | Profile ID to use for integration tests |

---

## Output format

Each test prints one line:

```
[PASS] auth_router.stop_removes_socket — socket file removed
[FAIL] running.canvas_stable_same_tab — expected stable hash, got different values

SUMMARY: 7 passed, 1 failed
```

Exit code `0` if all tests pass, `1` if any fail.

---

## Expected results before full integration

Running `--module` before all other modules are complete will produce
mixed results depending on which modules are present. The harness
isolates each test in a try/catch, so a missing module causes that
group to fail gracefully without crashing the runner.
