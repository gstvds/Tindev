module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/'],
  // jest-expo's default test environment hardcodes the `react-native` package
  // export condition, which resolves axios to its XHR-based browser bundle —
  // under Jest that adapter never does real network I/O, so any test that
  // hits a real local HTTP server (as client.test.ts does) hangs/fails with a
  // generic "network" error. Plain node gives axios its real http-based
  // adapter instead. Nothing here touches the app's own Metro/Expo build —
  // this only affects how test files resolve modules.
  testEnvironment: 'node',
};
