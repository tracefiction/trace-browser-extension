import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const read = (path) => fs.readFileSync(path, 'utf8');
const IMPORT_CONTRACT = 'trace-native-library-import-v1';
function build(extra = {}) {
  return spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8', env: {
    ...process.env, TRACE_BUILD_MODE: 'release', TRACE_SESSION_MODE: 'kernel',
    TRACE_IOS_EARNED_PERMISSION_ONBOARDING: '1',
    TRACE_API_BASE: 'https://api.tracefiction.com', TRACE_WEB_ORIGIN: 'https://www.tracefiction.com',
    TRACE_NATIVE_IMPORT_CONTRACT: '', ...extra,
  } });
}
test('native Import needs the exact paired package opt-in; ordinary generated package stays disabled', () => {
  let manifest;
  try {
    const ordinary = build();
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(read('Shared (Extension)/Resources/background.js'), /nativeImportHandoff: false/);
    manifest = read('Shared (Extension)/Resources/manifest.json');
    const definition = JSON.parse(manifest);
    // The iPhone package's own permission model, which the opt-in below must
    // leave exactly as it is: no required website, no tabs permission, five
    // optional story-site patterns, no declared page script.
    assert.deepEqual(definition.permissions, ['alarms', 'storage', 'nativeMessaging', 'activeTab', 'scripting']);
    assert.deepEqual(definition.host_permissions, []);
    assert.deepEqual(definition.optional_host_permissions, ['https://*.archiveofourown.org/*',
      'https://*.archiveofourown.gay/*', 'https://archive.transformativeworks.org/*',
      'https://www.fanfiction.net/*', 'https://m.fanfiction.net/*']);
    assert.equal(Object.hasOwn(definition, 'content_scripts'), false);
    const optedIn = build({ TRACE_NATIVE_IMPORT_CONTRACT: 'trace-native-library-import-v1' });
    assert.equal(optedIn.status, 0, optedIn.stderr);
    assert.match(read('Shared (Extension)/Resources/background.js'), /nativeImportHandoff: true/);
    assert.equal(read('Shared (Extension)/Resources/manifest.json'), manifest);
    const invalid = build({ TRACE_NATIVE_IMPORT_CONTRACT: 'true' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Unsupported TRACE_NATIVE_IMPORT_CONTRACT/);
    const legacy = build({ TRACE_NATIVE_IMPORT_CONTRACT: 'trace-native-library-import-v1', TRACE_SESSION_MODE: 'legacy' });
    assert.notEqual(legacy.status, 0);
    assert.match(legacy.stderr, /kernel paired package/);
    const wrongOrigin = build({ TRACE_NATIVE_IMPORT_CONTRACT: 'trace-native-library-import-v1',
      TRACE_BUILD_MODE: 'dev', TRACE_API_BASE: 'http://localhost:3001' });
    assert.notEqual(wrongOrigin.status, 0);
    assert.match(wrongOrigin.stderr, /exact HTTPS API origin/);
    const handler = read('Shared (Extension)/SafariWebExtensionHandler.swift');
    const start = handler.indexOf('private static func importResponse');
    const end = handler.indexOf('\n    private static', start + 1);
    const route = handler.slice(start, end);
    assert.match(route, /#if TRACE_NATIVE_IMPORT_HANDOFF && os\(iOS\)/);
    assert.match(route, /object\(forInfoDictionaryKey: "TraceNativeImportContract"\)/);
    assert.match(route, /object\(forInfoDictionaryKey: "TraceNativeImportAPIOrigin"\)/);
    assert.match(route, /#else\s+return failure\("unsupported"\)/);
    assert.doesNotMatch(route, /UserDefaults|os_log|print\(/);
  } finally {
    // Restore the committed iPhone release package, which opts in.
    const restored = build({ TRACE_NATIVE_IMPORT_CONTRACT: IMPORT_CONTRACT });
    assert.equal(restored.status, 0, restored.stderr);
  }
});

test('the committed iOS release package opts in to native Import', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['build:ios-earned-permission-onboarding:release'],
    new RegExp(`(^|\\s)TRACE_NATIVE_IMPORT_CONTRACT=${IMPORT_CONTRACT}(\\s|$)`));
  const committed = execFileSync('git', ['show', 'HEAD:Shared (Extension)/Resources/background.js'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(committed, /nativeImportHandoff: true/);
  assert.doesNotMatch(committed, /nativeImportHandoff: false/);
});
