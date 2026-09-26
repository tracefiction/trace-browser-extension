import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const read = (path) => fs.readFileSync(path, 'utf8');
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
    const permissionSurface = { permissions: definition.permissions.filter(permission => permission !== "scripting"),
      host_permissions: definition.host_permissions, content_scripts: definition.content_scripts };
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(permissionSurface)).digest('hex'),
      '09aa341fbcaf4a92b430bc4faf4a04ae5635b7d458219ec24f6aebf53daf5d83',
      'existing website access stays identical apart from the scripting capability');
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
    const restored = build();
    assert.equal(restored.status, 0, restored.stderr);
  }
});
