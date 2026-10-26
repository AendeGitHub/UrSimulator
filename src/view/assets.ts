// Game data and models live under public/assets with fixed names; the build id in the query
// string makes browsers download them again after each deploy instead of using an old copy.

export function asset(path: string): string {
  return `${path}?v=${__BUILD_ID__}`;
}
