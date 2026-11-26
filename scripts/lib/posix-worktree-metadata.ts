// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
const inspectorTimeoutMs = 180_000;

// Keep the system inspector in the bundled CLI as well as in a source checkout. Use one
// descriptor-based walk per scan. A missing native facility only withholds release evidence.
const inspect = String.raw`
import array, contextlib, ctypes, errno, fcntl, hashlib, itertools, json, os, signal, stat, struct, sys
spec = json.loads(sys.argv[1])
digest = hashlib.sha256()
count = 0
current_path = b"."
class MetadataHold(Exception):
    pass
def require(ok, reason="metadata could not be verified"):
    if not ok:
        raise MetadataHold(reason)
def report_hold(kind, error, trace):
    if isinstance(error, MetadataHold):
        reason = str(error)
    elif isinstance(error, OSError) and error.errno:
        reason = errno.errorcode.get(error.errno, "OS error") + ": " + os.strerror(error.errno)
    else:
        reason = "inspector could not read the Git index or filesystem metadata"
    # Paths may have newlines, undecodable bytes, or many components. Never print native
    # command arguments, attribute values, or a traceback into the user's cleanup report.
    raw = current_path if len(current_path) <= 720 else current_path[:360] + b"..." + current_path[-360:]
    display = json.dumps(os.fsdecode(raw), ensure_ascii=True)
    if len(display) > 360:
        display = display[:140] + "..." + display[-217:]
    print(json.dumps({"path": display, "reason": reason}), file=sys.stderr)
if spec.get("tracked"):
    sys.excepthook = report_hold
    def timed_out(signum, frame):
        raise MetadataHold("POSIX metadata inspection timed out")
    # Return the current relative path before the parent's hard deadline kills the inspector.
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(int(sys.argv[2]))
def record(value):
    digest.update(struct.pack(">I", len(value)))
    digest.update(value)

if sys.platform == "darwin":
    libc = ctypes.CDLL(None, use_errno=True)
    libc.acl_get_fd_np.restype = ctypes.c_void_p
    libc.acl_free.argtypes = [ctypes.c_void_p]
    libc.flistxattr.restype = libc.fgetxattr.restype = ctypes.c_ssize_t
    names = ctypes.create_string_buffer(256)
    value = ctypes.create_string_buffer(256)
    attr = b"com.apple.provenance"
    def metadata(fd, st):
        require(st.st_flags == 0, "file flags")
        acl = libc.acl_get_fd_np(fd, 0x100)  # ACL_TYPE_EXTENDED
        if acl:
            libc.acl_free(acl)
            raise MetadataHold("extended ACL")
        require(ctypes.get_errno() == errno.ENOENT, "could not inspect the ACL")
        # Include normally hidden compression attributes. Every other attribute, including
        # a resource fork, holds the tree without loading its payload.
        size = libc.flistxattr(fd, names, len(names), 0x20)
        if size == 0:
            return b""
        require(size >= 0, "extended attributes could not be listed")
        require(b"com.apple.ResourceFork" not in names.raw[:size].split(b"\0"), "resource fork")
        require(size == len(attr) + 1 and names.raw[:size] == attr + b"\0", "extended attributes")
        size = libc.fgetxattr(fd, attr, value, len(value), 0, 0x20)
        require(0 < size <= len(value), "provenance could not be read")
        return value.raw[:size]
elif sys.platform == "linux":
    flags = array.array("l", [0])
    getflags = 0x80006601 | (flags.itemsize << 16)  # FS_IOC_GETFLAGS
    def metadata(fd, st):
        # Includes POSIX access/default ACLs and named user/security attributes.
        require(not os.listxattr(fd), "extended attributes or ACL")
        flags[0] = 0
        fcntl.ioctl(fd, getflags, flags, True)
        # Extent format and a directory's kernel-managed hash index can change with layout.
        layout = 0x80000 | (0x1000 if stat.S_ISDIR(st.st_mode) else 0)
        require(flags[0] & ~layout == 0, "file flags")
        return b""
else:
    raise MetadataHold("unsupported filesystem metadata inspector")

@contextlib.contextmanager
def opened(name, parent, directory):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                 (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    try:
        st = os.fstat(fd)
        require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode), "unexpected file type")
        yield fd, st
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(os.path.samestat(st, after), "entry replaced during inspection")
        if spec.get("tracked"):
            require(st.st_ctime_ns == after.st_ctime_ns, "entry changed during inspection")
    finally:
        os.close(fd)

def stable_metadata(fd, st):
    value = metadata(fd, st)
    after = os.fstat(fd)
    if st.st_ctime_ns != after.st_ctime_ns:
        # A pnpm alias may have changed while reading. Require a stable identical reread.
        require(metadata(fd, after) == value and os.fstat(fd).st_ctime_ns == after.st_ctime_ns,
                "metadata changed during inspection")
    return value

def tracked_entries():
    global current_path
    # The server already bounded and validated Git's output. Keep path bytes and delimiters
    # intact, including tabs and newlines, without putting a whole index in argv.
    limit = 64 * 1024 * 1024
    data = sys.stdin.buffer.read(limit + 1)
    require(len(data) <= limit, "Git index exceeds inspection limit")
    offset = 0
    while offset < len(data):
        end = data.index(b"\0", offset)
        header, name = data[offset:end].split(b"\t", 1)
        before, current_path = current_path, name
        require(b"\xef\xbf\xbd" not in name, "undecodable Git path")
        tag, mode, oid, stage = header.split(b" ")
        require(tag == b"H" and stage == b"0" and mode in (b"100644", b"100755", b"120000", b"160000"))
        require(len(oid) in (40, 64) and all(c in b"0123456789abcdef" for c in oid))
        parts = name.split(b"/")
        require(len(parts) <= 128 and all(p and p not in (b".", b"..") and p.lower() != b".git" for p in parts))
        current_path = before
        yield parts, mode
        offset = end + 1

def inspect_tracked(root, root_st):
    global current_path
    mask = os.umask(0)
    os.umask(mask)
    current_path = b".git"
    git_dir = stat.S_ISDIR(os.stat(".git", dir_fd=root, follow_symlinks=False).st_mode)
    with opened(".git", root, git_dir) as (marker, st):
        # OS-assigned provenance must agree with Git's own checkout marker. A foreign stamp
        # cannot be recreated by checking out the blob.
        provenance = stable_metadata(marker, st)
    current_path = b"."
    group = os.stat("..", dir_fd=root).st_gid if sys.platform == "darwin" else os.getegid()
    def plain(st, mode, value):
        require(st.st_uid == os.geteuid() and st.st_gid == group, "unexpected owner or group")
        require(stat.S_IMODE(st.st_mode) == mode, "nonstandard permissions")
        require(stat.S_ISDIR(st.st_mode) or st.st_nlink == 1, "unverified hard links")
        require(not value or value == provenance, "foreign provenance")
    def walk(parent, entries, depth):
        global current_path
        for name, related in itertools.groupby(entries, lambda entry: entry[0][depth]):
            first = next(related)
            parts, mode = first
            current_path = b"/".join(parts[:depth + 1])
            if len(parts) > depth + 1:
                with opened(name, parent, True) as (directory, st):
                    plain(st, 0o777 & ~mask, stable_metadata(directory, st))
                    walk(directory, itertools.chain([first], related), depth + 1)
                    current_path = b"/".join(parts[:depth + 1])
                continue
            require(next(related, None) is None)
            if mode == b"120000":
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISLNK(before.st_mode))
                if sys.platform == "darwin":
                    # Darwin's O_SYMLINK opens the link itself, including a dangling link.
                    fd = os.open(name, 0x200000 | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        st = os.fstat(fd)
                        require(os.path.samestat(before, st))
                        plain(st, 0o777 & ~mask, stable_metadata(fd, st))
                    finally:
                        os.close(fd)
                else:
                    # Linux cannot list xattrs via an O_PATH symlink descriptor. Anchor
                    # llistxattr at the pinned parent and verify the link's change time.
                    require(not os.listxattr(b"/proc/self/fd/%d/" % parent + name, follow_symlinks=False),
                            "extended attributes or ACL")
                    plain(before, 0o777, b"")
                after = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(os.path.samestat(before, after) and before.st_ctime_ns == after.st_ctime_ns)
            else:
                directory = mode == b"160000"
                with opened(name, parent, directory) as (fd, st):
                    perms = 0o666 if mode == b"100644" else 0o777
                    plain(st, perms & ~mask, stable_metadata(fd, st))
    plain(root_st, 0o777 & ~mask, stable_metadata(root, root_st))
    walk(root, tracked_entries(), 0)
    current_path = b"."

def scan(fd, st, path, is_dir, skipped, depth):
    global count
    require(depth <= 128)
    record(path)
    record(str((st.st_dev, st.st_ino)).encode("ascii"))
    record(stable_metadata(fd, st))
    if is_dir:
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                count += 1
                require(count <= 2_000_000)
                if entry.name not in skipped:
                    names.append(os.fsencode(entry.name))
        for child in sorted(names):
            mode = os.stat(child, dir_fd=fd, follow_symlinks=False).st_mode
            # Symlink metadata changes are already bound by the main proof's lstat ctime.
            if stat.S_ISLNK(mode):
                continue
            directory = stat.S_ISDIR(mode)
            require(directory or stat.S_ISREG(mode))
            with opened(child, fd, directory) as (child_fd, info):
                scan(child_fd, info, path + b"/" + child, directory, (), depth + 1)

with opened(".", None, True) as (root, root_st):
    if spec.get("tracked"):
        inspect_tracked(root, root_st)
    elif "modules" in spec:
        for name, skipped in sorted(spec["modules"].items()):
            with contextlib.ExitStack() as stack:
                fd = root
                for part in name.split("/"):
                    require(part not in ("", ".", "..", ".git"))
                    fd, st = stack.enter_context(opened(part, fd, True))
                scan(fd, st, os.fsencode(name), True, skipped, 0)
    else:
        with opened(".t3", root, True) as (directory, ds):
            with opened(spec["marker"], directory, False) as (fd, fs):
                dmeta, fmeta = stable_metadata(directory, ds), stable_metadata(fd, fs)
                # An existing marker directory must be plain, or bear the exact provenance
                # of our newly created running marker. Never adopt an unrelated stamp.
                require(not dmeta or dmeta == fmeta)
                require(ds.st_mode & 0o7000 == 0 and fs.st_nlink == 1)
                record(str((ds.st_dev, ds.st_ino, ds.st_mode, ds.st_uid, ds.st_gid)).encode("ascii"))
                record(str((fs.st_mode, fs.st_uid, fs.st_gid)).encode("ascii"))
                record(dmeta)
                record(fmeta)
print(digest.hexdigest())
`;

const inspectorPath = "/usr/bin/python3";

async function trackedInspectionError(cause: unknown): Promise<Error> {
  if (cause instanceof Error) {
    if ("stderr" in cause && typeof cause.stderr === "string") {
      try {
        const issue = JSON.parse(cause.stderr) as { path?: unknown; reason?: unknown } | null;
        if (
          typeof issue?.path === "string" &&
          typeof issue.reason === "string" &&
          /^"[\x20-\x7e]{0,360}"$/.test(issue.path) &&
          /^[\x20-\x7e]{1,160}$/.test(issue.reason)
        ) {
          return new Error(`${issue.reason} at ${issue.path}`);
        }
      } catch {
        // Startup failures have no structured report. Only expose the process status below.
      }
    }
    if ("killed" in cause && cause.killed && "signal" in cause && cause.signal === "SIGTERM")
      return new Error("POSIX metadata inspection timed out");
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,48}$/.test(cause.code)
    ) {
      if (cause.code === "ENOENT") {
        const available = await NodeFSP.access(inspectorPath).then(
          () => true,
          () => false,
        );
        return new Error(
          available
            ? "ENOENT: POSIX metadata inspector could not start in the checkout directory"
            : `ENOENT: POSIX metadata inspector ${inspectorPath} is unavailable`,
        );
      }
      return new Error(`POSIX metadata inspector failed (${cause.code})`);
    }
  }
  return new Error("POSIX metadata inspector exited without a valid report");
}

export async function inspectPosixMetadata(
  cwd: string,
  selection:
    | { modules: Record<string, string[]> }
    | { marker: "setup-running" | "setup-done" }
    | { tracked: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const command = runFile(
      inspectorPath,
      [
        "-I",
        "-S",
        "-c",
        inspect,
        JSON.stringify("tracked" in selection ? { tracked: true } : selection),
        String(inspectorTimeoutMs / 1000 - 1),
      ],
      { cwd, signal, timeout: inspectorTimeoutMs, maxBuffer: 1024, encoding: "utf8" },
    );
    const [processResult, inputResult] = await Promise.allSettled([
      command,
      "tracked" in selection
        ? NodeStreamPromises.pipeline([selection.tracked], command.child.stdin!)
        : undefined,
    ]);
    if (processResult.status === "rejected") throw processResult.reason;
    if (inputResult.status === "rejected") throw inputResult.reason;
    const { stdout, stderr } = processResult.value;
    if (!stderr && /^[a-f0-9]{64}\n$/.test(stdout)) return stdout.slice(0, -1);
  } catch (error) {
    signal.throwIfAborted();
    if ("tracked" in selection) throw await trackedInspectionError(error);
  }
  if ("tracked" in selection)
    throw new Error("POSIX metadata inspector returned an incomplete report");
  return undefined;
}
