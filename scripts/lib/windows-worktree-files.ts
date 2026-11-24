// @effect-diagnostics nodeBuiltinImport:off -- Worktree setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup runs before workspace dependencies are available.
export const windowsSetupHost = NodeOS.platform() === "win32";

// NTFS exposes streams and reparse tags on the entry itself when opened without traversal.
const inspect = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
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
  const uint ReadControl = 0x20000, ReadAttributes = 0x80, ReadEa = 8;
  const uint ShareReadWrite = 3, OpenExisting = 3, BackupSemanticsAndOpenReparse = 0x02200000;
  const uint OwnerAndDacl = 5, DaclAutoInherit = 1;

  [StructLayout(LayoutKind.Sequential)]
  struct GenericMapping {
    public uint Read, Write, Execute, All;
  }

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
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreatePrivateObjectSecurityEx(byte[] parent, IntPtr creator, out IntPtr result,
    IntPtr objectType, bool directory, uint flags, IntPtr token, ref GenericMapping mapping);
  [DllImport("advapi32.dll")]
  static extern bool DestroyPrivateObjectSecurity(ref IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern int GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr FindFirstFileW(string pattern, out FindData data);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool FindNextFileW(IntPtr h, out FindData data);
  [DllImport("kernel32.dll")]
  static extern bool FindClose(IntPtr h);

  sealed class Refusal : Exception {
    public Refusal(string check, int code) : base(
      check + (code == 0 ? "" : "/" + code.ToString(CultureInfo.InvariantCulture))) {}
  }

  static void Require(bool ok, string check, int code = 0) {
    if (!ok) throw new Refusal(check, code);
  }

  public static string Check(string root, string[] links, string[] modules, bool privateStage) {
    try {
      var drive = new DriveInfo(Path.GetPathRoot(root));
      Require(drive.DriveType == DriveType.Fixed && drive.DriveFormat == "NTFS", "volume");
      using (var user = WindowsIdentity.GetCurrent()) {
        var scan = new Scan(links, modules, privateStage, user);
        try { scan.Root(root); }
        finally { Marshal.FreeHGlobal(scan.Status); }
      }
      return "verified";
    } catch (Refusal refusal) {
      return refusal.Message;
    } catch (Exception) {
      return "native-inspection";
    }
  }

  sealed class Scan {
    readonly HashSet<string> Links, Modules;
    readonly bool PrivateStage;
    readonly SecurityIdentifier Owner;
    readonly IntPtr Token;
    readonly byte[] Buffer = new byte[65536];
    public readonly IntPtr Status = Marshal.AllocHGlobal(2 * IntPtr.Size);
    int Count;

    public Scan(string[] links, string[] modules, bool privateStage, WindowsIdentity user) {
      Links = new HashSet<string>(links, StringComparer.Ordinal);
      Modules = new HashSet<string>(modules, StringComparer.Ordinal);
      PrivateStage = privateStage;
      Owner = user.Owner;
      Token = user.Token;
    }

    SafeFileHandle Open(string path, uint access) {
      var handle = CreateFileW(path, access, ShareReadWrite, IntPtr.Zero, OpenExisting,
        BackupSemanticsAndOpenReparse, IntPtr.Zero);
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        Require(false, "open-entry", error);
      }
      return handle;
    }

    uint ReadAttributesAndTag(SafeFileHandle handle, out uint tag) {
      Require(GetFileInformationByHandleEx(handle, FileAttributeTagInfo, Buffer, Buffer.Length),
        "read-attributes", Marshal.GetLastWin32Error());
      tag = BitConverter.ToUInt32(Buffer, 4);
      return BitConverter.ToUInt32(Buffer, 0);
    }

    RawSecurityDescriptor ReadSecurity(SafeFileHandle handle) {
      int needed;
      Require(GetKernelObjectSecurity(handle, OwnerAndDacl, Buffer, Buffer.Length, out needed),
        "read-security", Marshal.GetLastWin32Error());
      return new RawSecurityDescriptor(Buffer, 0);
    }

    public void Root(string root) {
      const string extended = @"\\?\";
      using (var parent = Open(extended + Path.GetDirectoryName(root), ReadControl | ReadAttributes)) {
        uint tag;
        Require((ReadAttributesAndTag(parent, out tag) & (Directory | Reparse)) == Directory,
          "reparse-parent");
        Entry(extended + root, "", false, 0, ReadSecurity(parent));
      }
    }

    void CheckSecurity(RawSecurityDescriptor entry, RawSecurityDescriptor parent, bool directory) {
      var acl = entry.DiscretionaryAcl;
      Require(Owner.Equals(entry.Owner), "entry-owner");
      Require(acl != null && (entry.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0,
        "acl-inheritance");
      bool allInherited = true;
      foreach (GenericAce ace in acl) allInherited &= (ace.AceFlags & AceFlags.Inherited) != 0;
      if (allInherited) return;
      Require((entry.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) == 0,
        "explicit-ace");

      // Older NTFS DACLs can contain inherited entries without INHERITED_ACE.
      // Accept that representation only when it matches Windows' inheritance calculation.
      var parentBytes = new byte[parent.BinaryLength];
      parent.GetBinaryForm(parentBytes, 0);
      var mapping = new GenericMapping { Read = 0x120089, Write = 0x120116,
        Execute = 0x1200a0, All = 0x1f01ff };
      IntPtr expected;
      Require(CreatePrivateObjectSecurityEx(parentBytes, IntPtr.Zero, out expected, IntPtr.Zero,
        directory, DaclAutoInherit, Token, ref mapping), "derive-acl", Marshal.GetLastWin32Error());
      try {
        int length = GetSecurityDescriptorLength(expected);
        Require(length > 0 && length <= Buffer.Length, "derived-acl-size");
        Marshal.Copy(expected, Buffer, 0, length);
        var inherited = new RawSecurityDescriptor(Buffer, 0).DiscretionaryAcl;
        Require(inherited != null && inherited.Revision == acl.Revision && inherited.Count == acl.Count,
          "explicit-ace");
        for (int i = 0; i < acl.Count; i++) {
          inherited[i].AceFlags &= ~AceFlags.Inherited;
          Require(acl[i].Equals(inherited[i]), "explicit-ace");
        }
      } finally { DestroyPrivateObjectSecurity(ref expected); }
    }

    void Entry(string path, string relative, bool insideModules, int depth, RawSecurityDescriptor parent) {
      Require(depth < 128 && ++Count <= 2000000, "inspection-limit");
      using (var handle = Open(path, ReadControl | ReadAttributes | ReadEa)) {
        uint tag;
        uint attrs = ReadAttributesAndTag(handle, out tag);
        Require((attrs & ~SafeAttributes) == 0, "unsupported-attributes");
        bool directory = (attrs & Directory) != 0, reparse = (attrs & Reparse) != 0;
        if (reparse)
          Require(depth > 0 && (tag == Junction && directory || tag == Symlink) &&
            (PrivateStage || insideModules || Links.Contains(relative)), "reparse-point");
        else
          insideModules = insideModules || Modules.Contains(relative);

        if (GetFileInformationByHandleEx(handle, FileStreamInfo, Buffer, Buffer.Length)) {
          Require(BitConverter.ToInt32(Buffer, 0) == 0 && BitConverter.ToInt32(Buffer, 4) == 14 &&
            System.Text.Encoding.Unicode.GetString(Buffer, 24, 14) == "::$DATA", "private-stream");
        } else {
          int error = Marshal.GetLastWin32Error();
          Require((directory || reparse) && error == 38, "read-streams", error); // ERROR_HANDLE_EOF
        }
        int eaSize;
        int eaStatus = NtQueryInformationFile(handle, Status, out eaSize, 4, FileEaInformation);
        Require(eaStatus == 0, "read-extended-attributes", eaStatus);
        Require(eaSize == 0, "private-extended-attributes");
        var security = ReadSecurity(handle);
        CheckSecurity(security, parent, directory);
        if (directory && !reparse) Children(path, relative, insideModules, depth, security);
      }
    }

    void Children(string path, string relative, bool insideModules, int depth, RawSecurityDescriptor parent) {
      FindData data;
      var find = FindFirstFileW(path + @"\*", out data);
      if (find == new IntPtr(-1)) {
        int error = Marshal.GetLastWin32Error();
        Require(error == 2, "open-directory", error); // ERROR_FILE_NOT_FOUND for an empty directory
        return;
      }
      try {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        do {
          string name = data.Name;
          if (name == "." || name == "..") continue;
          Require(names.Add(name) && !name.EndsWith(".") && !name.EndsWith(" ") && !name.Contains("\ufffd"),
            "ambiguous-entry-name");
          Entry(path + @"\" + name, relative.Length == 0 ? name : relative + "/" + name,
            insideModules, depth + 1, parent);
        } while (FindNextFileW(find, out data));
        int error = Marshal.GetLastWin32Error();
        Require(error == 18, "enumerate-directory", error); // ERROR_NO_MORE_FILES
      } finally { FindClose(find); }
    }
  }
}
'@
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Console]::Write([WorktreeFiles]::Check($inputData.root, [string[]]$inputData.links, [string[]]$inputData.modules, $inputData.privateStage))
} catch {
  [Console]::Write('powershell-bootstrap')
}
`;

export class WindowsWorktreeInspectionError extends Error {
  constructor(readonly check: string) {
    super(`Windows worktree inspection failed (${check})`);
  }
}

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
      reject(new WindowsWorktreeInspectionError("local-ntfs-required"));
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
        if (error) reject(new WindowsWorktreeInspectionError("powershell-process"));
        else if (stdout !== "verified")
          reject(
            new WindowsWorktreeInspectionError(
              /^[a-z-]{1,40}(?:\/-?\d{1,10})?$/.test(stdout) ? stdout : "incomplete-result",
            ),
          );
        else resolve();
      },
    );
    const { links = [], modules = [], privateStage = false } = options;
    // PowerShell 5.1 can read redirected stdin in the console codepage.
    const payload = JSON.stringify({ root, links, modules, privateStage }).replace(
      /[^\x20-\x7e]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    child.stdin
      ?.on("error", () => reject(new WindowsWorktreeInspectionError("powershell-input")))
      .end(payload);
  });
