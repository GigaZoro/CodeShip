const SKIPPED_DIRECTORY = /^(?:src|test|tests|__tests__|fixtures|testkit|node_modules)$/;
const CODE = /\.[cm]?[jt]sx?$/;

function inRepositoryCommandDirectory(file: string): boolean {
  return (
    !file.startsWith(".repos/") &&
    !file
      .split("/")
      .slice(0, -1)
      .some((part) => SKIPPED_DIRECTORY.test(part))
  );
}

export function isRepositoryCommandSource(file: string): boolean {
  return (
    CODE.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file) && inRepositoryCommandDirectory(file)
  );
}

export function isRepositoryCommandManifest(file: string): boolean {
  return (
    (file === "package.json" || file.endsWith("/package.json")) &&
    inRepositoryCommandDirectory(file)
  );
}
