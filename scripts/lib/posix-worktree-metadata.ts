// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Keep the system inspector in the bundled CLI as well as in a source checkout. Use one
// descriptor-based walk per scan. A missing native facility only withholds release evidence.
const inspect = String.raw`
import array, contextlib, ctypes, errno, fcntl, hashlib, json, os, stat, struct, sys
spec = json.loads(sys.argv[1])
digest = hashlib.sha256()
count = 0
def require(ok):
    if not ok:
        raise ValueError("Cannot verify setup metadata")
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
        require(st.st_flags == 0)
        acl = libc.acl_get_fd_np(fd, 0x100)  # ACL_TYPE_EXTENDED
        if acl:
            libc.acl_free(acl)
            raise ValueError("Extended ACL")
        require(ctypes.get_errno() == errno.ENOENT)
        # Include normally hidden compression attributes. Every other attribute, including
        # a resource fork, holds the tree without loading its payload.
        size = libc.flistxattr(fd, names, len(names), 0x20)
        if size == 0:
            return b""
        require(size == len(attr) + 1 and names.raw[:size] == attr + b"\0")
        size = libc.fgetxattr(fd, attr, value, len(value), 0, 0x20)
        require(0 < size <= len(value))
        return value.raw[:size]
elif sys.platform == "linux":
    flags = array.array("l", [0])
    getflags = 0x80006601 | (flags.itemsize << 16)  # FS_IOC_GETFLAGS
    def metadata(fd, st):
        # Includes POSIX access/default ACLs and named user/security attributes.
        require(not os.listxattr(fd))
        flags[0] = 0
        fcntl.ioctl(fd, getflags, flags, True)
        # Extent format and a directory's kernel-managed hash index can change with layout.
        layout = 0x80000 | (0x1000 if stat.S_ISDIR(st.st_mode) else 0)
        require(flags[0] & ~layout == 0)
        return b""
else:
    raise ValueError("Unsupported setup filesystem")

@contextlib.contextmanager
def opened(name, parent, directory):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                 (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    try:
        st = os.fstat(fd)
        require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode))
        yield fd, st
        require(os.path.samestat(st, os.stat(name, dir_fd=parent, follow_symlinks=False)))
    finally:
        os.close(fd)

def stable_metadata(fd, st):
    value = metadata(fd, st)
    after = os.fstat(fd)
    if st.st_ctime_ns != after.st_ctime_ns:
        # A pnpm alias may have changed while reading. Require a stable identical reread.
        require(metadata(fd, after) == value and os.fstat(fd).st_ctime_ns == after.st_ctime_ns)
    return value

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

with opened(".", None, True) as (root, _):
    if "modules" in spec:
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

export async function inspectPosixMetadata(
  cwd: string,
  selection: { modules: Record<string, string[]> } | { marker: "setup-running" | "setup-done" },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runFile(
      "/usr/bin/python3",
      ["-I", "-S", "-c", inspect, JSON.stringify(selection)],
      { cwd, signal, timeout: 180_000, maxBuffer: 1024, encoding: "utf8" },
    );
    return !stderr && /^[a-f0-9]{64}\n$/.test(stdout) ? stdout.slice(0, -1) : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}
