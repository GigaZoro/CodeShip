const SKIPPED_DIRECTORY = /^(?:src|test|tests|__tests__|fixtures|testkit|node_modules)$/;
const CODE = /\.[cm]?[jt]sx?$/;

export function isRepositoryCommandSource(file: string): boolean {
  return (
    CODE.test(file) &&
    !file.startsWith(".repos/") &&
    !/\.test\.[cm]?[jt]sx?$/.test(file) &&
    !file
      .split("/")
      .slice(0, -1)
      .some((part) => SKIPPED_DIRECTORY.test(part))
  );
}
