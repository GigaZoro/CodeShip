// @effect-diagnostics nodeBuiltinImport:off -- Worktree setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup runs before workspace dependencies are available.
export const windowsSetupHost = NodeOS.platform() === "win32";

// NTFS exposes streams and reparse tags on the entry itself when opened without traversal.
const inspect = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class WorktreeFiles {
  const uint Directory = 0x10, Reparse = 0x400;
  const uint SafeAttributes = Directory | Reparse | 0x02 | 0x20 | 0x80;
  const uint Junction = 0xa0000003, Symlink = 0xa000000c;
  const int FileStreamInfo = 7, FileAttributeTagInfo = 9, FileEaInformation = 7;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FindData {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint SizeHigh, SizeLow, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, byte[] buffer, int length);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationFile(SafeFileHandle h, IntPtr status, out int result, int length, int kind);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetKernelObjectSecurity(SafeFileHandle h, uint info, byte[] descriptor, int length,
    out int needed);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr FindFirstFileW(string pattern, out FindData data);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool FindNextFileW(IntPtr h, out FindData data);
  [DllImport("kernel32.dll")]
  static extern bool FindClose(IntPtr h);

  static void Require(bool ok) {
    if (!ok) throw new IOException("Unverifiable Windows worktree entry");
  }

  public static void Check(string root, string[] links, string[] modules, bool privateStage) {
    var drive = new DriveInfo(Path.GetPathRoot(root));
    Require(drive.DriveType == DriveType.Fixed && drive.DriveFormat == "NTFS");
    using (var user = WindowsIdentity.GetCurrent()) {
      var scan = new Scan(links, modules, privateStage, user.Owner);
      try { scan.Entry(@"\\?\" + root, "", false, 0); }
      finally { Marshal.FreeHGlobal(scan.Status); }
    }
  }

  sealed class Scan {
    readonly HashSet<string> Links, Modules;
    readonly bool PrivateStage;
    readonly SecurityIdentifier Owner;
    readonly byte[] Buffer = new byte[65536];
    public readonly IntPtr Status = Marshal.AllocHGlobal(2 * IntPtr.Size);
    int Count;

    public Scan(string[] links, string[] modules, bool privateStage, SecurityIdentifier owner) {
      Links = new HashSet<string>(links, StringComparer.Ordinal);
      Modules = new HashSet<string>(modules, StringComparer.Ordinal);
      PrivateStage = privateStage;
      Owner = owner;
    }

    public void Entry(string path, string relative, bool insideModules, int depth) {
      Require(depth < 128 && ++Count <= 2000000);
      const uint readControlAttributesAndEa = 0x20088, shareReadWrite = 3, openExisting = 3;
      const uint backupSemanticsAndOpenReparse = 0x02200000;
      using (var handle = CreateFileW(path, readControlAttributesAndEa, shareReadWrite,
        IntPtr.Zero, openExisting, backupSemanticsAndOpenReparse, IntPtr.Zero)) {
        Require(!handle.IsInvalid && GetFileInformationByHandleEx(handle, FileAttributeTagInfo, Buffer, Buffer.Length));
        uint attrs = BitConverter.ToUInt32(Buffer, 0), tag = BitConverter.ToUInt32(Buffer, 4);
        Require((attrs & ~SafeAttributes) == 0);
        bool directory = (attrs & Directory) != 0, reparse = (attrs & Reparse) != 0;
        if (reparse)
          Require(depth > 0 && (tag == Junction && directory || tag == Symlink) &&
            (PrivateStage || insideModules || Links.Contains(relative)));
        else
          insideModules = insideModules || Modules.Contains(relative);

        if (GetFileInformationByHandleEx(handle, FileStreamInfo, Buffer, Buffer.Length)) {
          Require(BitConverter.ToInt32(Buffer, 0) == 0 && BitConverter.ToInt32(Buffer, 4) == 14 &&
            System.Text.Encoding.Unicode.GetString(Buffer, 24, 14) == "::$DATA");
        } else {
          Require((directory || reparse) && Marshal.GetLastWin32Error() == 38); // ERROR_HANDLE_EOF
        }
        int eaSize, needed;
        Require(NtQueryInformationFile(handle, Status, out eaSize, 4, FileEaInformation) == 0 && eaSize == 0);
        Require(GetKernelObjectSecurity(handle, 5, Buffer, Buffer.Length, out needed)); // OWNER | DACL
        var security = new RawSecurityDescriptor(Buffer, 0);
        Require(Owner.Equals(security.Owner) && security.DiscretionaryAcl != null &&
          (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0);
        foreach (GenericAce ace in security.DiscretionaryAcl)
          Require((ace.AceFlags & AceFlags.Inherited) != 0);

        if (directory && !reparse) Children(path, relative, insideModules, depth);
      }
    }

    void Children(string path, string relative, bool insideModules, int depth) {
      FindData data;
      var find = FindFirstFileW(path + @"\*", out data);
      if (find == new IntPtr(-1)) {
        Require(Marshal.GetLastWin32Error() == 2); // ERROR_FILE_NOT_FOUND for an empty directory
        return;
      }
      try {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        do {
          string name = data.Name;
          if (name == "." || name == "..") continue;
          Require(names.Add(name) && !name.EndsWith(".") && !name.EndsWith(" ") && !name.Contains("\ufffd"));
          Entry(path + @"\" + name, relative.Length == 0 ? name : relative + "/" + name,
            insideModules, depth + 1);
        } while (FindNextFileW(find, out data));
        Require(Marshal.GetLastWin32Error() == 18); // ERROR_NO_MORE_FILES
      } finally { FindClose(find); }
    }
  }
}
'@
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
[WorktreeFiles]::Check($inputData.root, [string[]]$inputData.links, [string[]]$inputData.modules, $inputData.privateStage)
[Console]::Write('verified')
`;

export const checkWindowsWorktreeFiles = (
  root: string,
  options: {
    links?: readonly string[];
    modules?: readonly string[];
    privateStage?: boolean;
    signal?: AbortSignal;
  } = {},
) =>
  new Promise<void>((resolve, reject) => {
    const systemRoot = process.env.SystemRoot;
    if (!windowsSetupHost || !systemRoot || !/^[a-z]:\\/i.test(root)) {
      reject(new Error("Windows worktree inspection requires local NTFS"));
      return;
    }
    const child = NodeChildProcess.execFile(
      NodePath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(inspect, "utf16le").toString("base64"),
      ],
      { windowsHide: true, signal: options.signal, timeout: 600_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else if (stdout !== "verified") reject(new Error("Incomplete Windows worktree inspection"));
        else resolve();
      },
    );
    const { links = [], modules = [], privateStage = false } = options;
    // PowerShell 5.1 can read redirected stdin in the console codepage.
    const payload = JSON.stringify({ root, links, modules, privateStage }).replace(
      /[^\x20-\x7e]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    child.stdin?.on("error", reject).end(payload);
  });
