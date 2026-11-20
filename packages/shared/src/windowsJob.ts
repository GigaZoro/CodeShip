// @effect-diagnostics nodeBuiltinImport:off -- Bootstrap compilation cannot use the spawner this host will wrap.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import * as HostProcess from "./HostProcess.ts";

// The native host creates the child inside the job; its private handle survives a server restart.
const SOURCE = String.raw`using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class CodeShipJobHost {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct Startup {
  public int cb;
  public IntPtr reserved, desktop, title;
  public int x, y, width, height, charsX, charsY, fill, flags;
  public short show, reservedSize;
  public IntPtr reservedData, input, output, error;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
 [StructLayout(LayoutKind.Sequential)]
 struct StartupEx { public Startup startup; public IntPtr attributes; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
 [DllImport("kernel32.dll")] static extern uint PssCaptureSnapshot(IntPtr process, uint flags, uint context, out IntPtr snapshot);
 [DllImport("kernel32.dll")] static extern uint PssFreeSnapshot(IntPtr process, IntPtr snapshot);
 [DllImport("kernel32.dll")] static extern uint PssWalkMarkerCreate(IntPtr allocator, out IntPtr marker);
 [DllImport("kernel32.dll")] static extern uint PssWalkMarkerFree(IntPtr marker);
 [DllImport("kernel32.dll")] static extern uint PssWalkSnapshot(IntPtr snapshot, int kind, IntPtr marker, IntPtr buffer, uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern void GetStartupInfo(out Startup startup);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, uint size, out uint read, IntPtr overlapped);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] bytes, uint size, out uint written, IntPtr overlapped);
 static readonly object controlWrite = new object();
 static int ReadControl(IntPtr control) {
  var bytes = new byte[1]; uint read;
  if(!ReadFile(control,bytes,1,out read,IntPtr.Zero)) {
   int error = Marshal.GetLastWin32Error();
   if(error==109 || error==232) return -1;
   throw new Win32Exception(error);
  }
  return read==0 ? -1 : bytes[0];
 }
 static void SendControl(IntPtr control, string line) {
  lock(controlWrite) {
   var bytes=Encoding.UTF8.GetBytes(line+"\n"); uint written;
   Check(WriteFile(control,bytes,(uint)bytes.Length,out written,IntPtr.Zero));
   if(written!=bytes.Length) throw new IOException("Incomplete ownership reply.");
  }
 }
 // Synchronous reads and writes on one inherited pipe can block one another's completion.
 static void WatchOwner(IntPtr control, IntPtr reply, bool referenced) {
  try {
   for(;;) {
    int next=ReadControl(control);
    if(next==-1) { if(referenced) Environment.Exit(125); return; }
    if(next!='R' && next!='U') throw new IOException("Invalid ownership message.");
    referenced=next=='R';
    SendControl(reply, referenced ? "R" : "U");
   }
  } catch { Environment.Exit(125); }
 }
 static long Created(IntPtr process) {
  long made, exited, kernel, user;
  Check(GetProcessTimes(process, out made, out exited, out kernel, out user));
  return (made - 116444736000000000L) / 10000;
 }
 static void Publish(string path, string text) {
  File.WriteAllText(path + ".tmp", text);
  File.Move(path + ".tmp", path);
 }
 static void Check(bool ok) { if(!ok) throw new Win32Exception(); }
 static uint Count(IntPtr job) {
  IntPtr p=Marshal.AllocHGlobal(48);
  try { Check(QueryInformationJobObject(job,1,p,48,IntPtr.Zero)); return unchecked((uint)Marshal.ReadInt32(p,40)); }
  finally { Marshal.FreeHGlobal(p); }
 }
 static void Limits(IntPtr job, bool closed) {
  int size=IntPtr.Size==8?144:112;
  IntPtr p=Marshal.AllocHGlobal(size);
  try {
   for(int i=0;i<size;i++) Marshal.WriteByte(p,i,0);
   Marshal.WriteInt32(p,16,0x2000 | (closed?8:0));
   Check(SetInformationJobObject(job,9,p,(uint)size));
  } finally { Marshal.FreeHGlobal(p); }
 }
 static void Stop(IntPtr job) {
  Limits(job,true);
  Check(TerminateJobObject(job,1));
  var wait=Stopwatch.StartNew();
  while(Count(job)!=0) {
   if(wait.ElapsedMilliseconds>=20000) throw new TimeoutException("Windows job still has active processes after 20 seconds of termination.");
   Thread.Sleep(10);
  }
 }
 static HashSet<IntPtr> StreamHandles(Startup startup) {
  var handles=new HashSet<IntPtr> { startup.input, startup.output, startup.error };
  if(startup.reservedData!=IntPtr.Zero && startup.reservedSize>=4) {
   int count=Marshal.ReadInt32(startup.reservedData);
   if(count<0 || count>(startup.reservedSize-4)/(1+IntPtr.Size)) throw new IOException("Invalid inherited stream handles.");
   for(int fd=0;fd<count;fd++) handles.Add(Marshal.ReadIntPtr(startup.reservedData,4+count+fd*IntPtr.Size));
  }
  handles.Remove(IntPtr.Zero); handles.Remove(new IntPtr(-1)); handles.Remove(new IntPtr(-2));
  return handles;
 }
 static void ReleaseStreams(Startup startup, IntPtr control, IntPtr reply, bool keepError) {
  var handles=StreamHandles(startup);
  handles.Remove(control); handles.Remove(reply);
  if(keepError) handles.Remove(startup.error);
  // Runtime-created copies are not necessarily present in STARTUPINFO's descriptor table.
  uint entrySize=IntPtr.Size==8 ? 136u : 104u;
  IntPtr snapshot=IntPtr.Zero, marker=IntPtr.Zero, entry=Marshal.AllocHGlobal((int)entrySize);
  var copies=new HashSet<IntPtr>();
  try {
   uint status=PssCaptureSnapshot(new IntPtr(-1),4,0,out snapshot);
   if(status!=0) throw new Win32Exception((int)status);
   status=PssWalkMarkerCreate(IntPtr.Zero,out marker);
   if(status!=0) throw new Win32Exception((int)status);
   for(;;) {
    status=PssWalkSnapshot(snapshot,2,marker,entry,entrySize);
    if(status==259) break;
    if(status!=0) throw new Win32Exception((int)status);
    IntPtr candidate=Marshal.ReadIntPtr(entry);
    if(CompareObjectHandles(candidate,control) || CompareObjectHandles(candidate,reply) || (keepError && CompareObjectHandles(candidate,startup.error))) continue;
    foreach(var handle in handles) if(CompareObjectHandles(candidate,handle)) { copies.Add(candidate); break; }
   }
  } finally {
   Marshal.FreeHGlobal(entry);
   if(marker!=IntPtr.Zero) PssWalkMarkerFree(marker);
   if(snapshot!=IntPtr.Zero) PssFreeSnapshot(new IntPtr(-1),snapshot);
  }
  foreach(var handle in copies) CloseHandle(handle);
 }
 static string Quote(string arg) {
  if(arg.IndexOf('\0') >= 0) throw new ArgumentException("A process argument contains NUL.");
  return "\"" + Regex.Replace(arg, "(\\\\*)\"", "$1$1\\\"")
    + new string('\\', arg.Length-arg.TrimEnd('\\').Length) + "\"";
 }
 public static int Main(string[] args) {
  IntPtr job=IntPtr.Zero;
  IntPtr attributes=IntPtr.Zero, jobList=IntPtr.Zero, descriptors=IntPtr.Zero, inheritedList=IntPtr.Zero, control=IntPtr.Zero, reply=IntPtr.Zero;
  bool initialized=false;
  ProcessInfo child=new ProcessInfo();
  string record = args.Length > 2 && args[0] == "run" ? args[2] : "";
  try {
   if(args.Length < 2) throw new ArgumentException("Expected an operation and a job name or pid.");
   if(args[0]=="stop-process") {
    IntPtr process=OpenProcess(0x101001,false,int.Parse(args[1]));
    if(process==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==87) return 0; throw new Win32Exception(); }
    try {
     if(Created(process)==long.Parse(args[2])) {
      Check(TerminateProcess(process,1));
      Check(WaitForSingleObject(process,0xffffffff)!=0xffffffff);
     }
    } finally { CloseHandle(process); }
    return 0;
   }
   if(args[0]=="git-path") {
    string target=args[2];
    bool script=target.EndsWith(".cmd",StringComparison.OrdinalIgnoreCase)||target.EndsWith(".bat",StringComparison.OrdinalIgnoreCase);
    args=script ? new[] { "run-raw",args[1],"",Path.Combine(Environment.SystemDirectory,"cmd.exe"),"/d","/s","/c","\"\""+target+"\" --exec-path\"" }
     : new[] { "run",args[1],"",target,"--exec-path" };
   }
   if(args[0]=="identity") {
    IntPtr process = OpenProcess(0x1000, false, int.Parse(args[1]));
    if(process == IntPtr.Zero) { if(Marshal.GetLastWin32Error() == 87) return 0; throw new Win32Exception(); }
    try { Console.WriteLine(Created(process)); } finally { CloseHandle(process); }
    return 0;
   }
   if(args[0]=="stop" || args[0]=="count") {
    job=OpenJobObject(14,false,args[1]);
    if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) { Console.WriteLine(args[0]=="count" ? "0" : "Job already gone."); return 0; } throw new Win32Exception(); }
    if(args[0]=="count") { Console.WriteLine(Count(job)); return 0; }
    if(args.Length!=4) throw new ArgumentException("Stopping a job requires its recorded child pid and creation time.");
    IntPtr owner=OpenProcess(0x1000,false,int.Parse(args[2]));
    if(owner==IntPtr.Zero) {
     if(Marshal.GetLastWin32Error()==87) { Console.WriteLine("Job not ours: recorded child is gone."); return 0; }
     throw new Win32Exception();
    }
    try {
     bool member;
     if(Created(owner)!=long.Parse(args[3])) { Console.WriteLine("Job not ours: child identity changed."); return 0; }
     Check(IsProcessInJob(owner,job,out member));
     if(!member) { Console.WriteLine("Job not ours: recorded child is not a member."); return 0; }
     Stop(job);
    } finally { CloseHandle(owner); }
    return 0;
   }
   bool owned=args[0]=="owned" || args[0]=="owned-raw";
   if((args[0]!="run" && args[0]!="run-raw" && !owned) || args.Length < 4) throw new ArgumentException("Expected run or owned, job name, pid file or control descriptor and command.");
   Startup startup;
   GetStartupInfo(out startup);
   if(owned) {
    int fd=int.Parse(args[2]);
    if(startup.reservedData==IntPtr.Zero || startup.reservedSize<4) throw new IOException("Ownership descriptors are missing.");
    int count=Marshal.ReadInt32(startup.reservedData);
    if(fd<3 || fd+1>=count || startup.reservedSize<4+count*(1+IntPtr.Size)) throw new IOException("Invalid ownership descriptors.");
    control=Marshal.ReadIntPtr(startup.reservedData,4+count+fd*IntPtr.Size);
    reply=Marshal.ReadIntPtr(startup.reservedData,4+count+(fd+1)*IntPtr.Size);
    Check(SetHandleInformation(control,1,0));
    Check(SetHandleInformation(reply,1,0));
    descriptors=Marshal.AllocHGlobal(startup.reservedSize);
    var bytes=new byte[startup.reservedSize];
    Marshal.Copy(startup.reservedData,bytes,0,bytes.Length);
    Marshal.Copy(bytes,0,descriptors,bytes.Length);
    for(int i=fd;i<=fd+1;i++) {
     Marshal.WriteByte(descriptors,4+i,0);
     Marshal.WriteIntPtr(descriptors,4+count+i*IntPtr.Size,new IntPtr(-1));
    }
    startup.reservedData=descriptors;
    SendControl(reply,"W");
    int first=ReadControl(control);
    if(first==-1) return 125;
    if(first!='R' && first!='U') throw new IOException("Expected startup ownership.");
    var owner=new Thread(()=>WatchOwner(control, reply, first=='R'));
    owner.IsBackground=true;
    owner.Start();
   }
   job=CreateJobObject(IntPtr.Zero,args[1]);
   Check(job!=IntPtr.Zero);
   if(Marshal.GetLastWin32Error()==183) throw new InvalidOperationException("Job name already exists");
   Limits(job,false);
   startup.cb=Marshal.SizeOf(typeof(StartupEx));
   startup.flags|=0x100;
   startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
   var command=new StringBuilder();
   for(int i=3;i<args.Length;i++) { if(i>3)command.Append(' '); command.Append((args[0]=="owned-raw" || args[0]=="run-raw") && i>3 ? args[i] : Quote(args[i])); }
   IntPtr size=IntPtr.Zero;
   InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
   attributes=Marshal.AllocHGlobal(size);
   Check(InitializeProcThreadAttributeList(attributes,2,0,ref size));
   initialized=true;
   jobList=Marshal.AllocHGlobal(IntPtr.Size);
   Marshal.WriteIntPtr(jobList,job);
   Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   var inherited=StreamHandles(startup);
   inherited.Remove(control); inherited.Remove(reply);
   inheritedList=Marshal.AllocHGlobal(IntPtr.Size*inherited.Count);
   int index=0;
   foreach(var handle in inherited) {
    Check(SetHandleInformation(handle,1,1));
    Marshal.WriteIntPtr(inheritedList,index++*IntPtr.Size,handle);
   }
   Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),inheritedList,new IntPtr(IntPtr.Size*inherited.Count),IntPtr.Zero,IntPtr.Zero));
   var extended=new StartupEx { startup=startup, attributes=attributes };
   Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x80004,IntPtr.Zero,null,ref extended,out child));
   ReleaseStreams(startup,control,reply,!owned);
   Directory.SetCurrentDirectory(Environment.SystemDirectory);
   if(record.Length != 0) Publish(record, child.pid + " " + Created(child.process));
   if(owned) SendControl(reply,"S " + child.pid + " " + Created(child.process));
   Check(ResumeThread(child.thread)!=0xffffffff);
   Check(WaitForSingleObject(child.process,0xffffffff)!=0xffffffff);
   uint code;
   Check(GetExitCodeProcess(child.process,out code));
   Stop(job);
   return unchecked((int)code);
  } catch(Exception error) {
   if(reply==IntPtr.Zero) Console.Error.WriteLine(error.Message);
   if(reply!=IntPtr.Zero) {
    try { SendControl(reply,"E " + (error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0) + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message))); } catch {}
   }
   if(record.Length != 0) {
    try {
     string folder = Path.GetDirectoryName(record);
     File.AppendAllText(Path.Combine(folder, "output.log"), "Could not start the command: " + error.Message + Environment.NewLine);
     Publish(Path.Combine(folder, "exit-status"), "125");
    } catch(Exception outputError) { Console.Error.WriteLine(outputError.Message); }
   }
   return 125;
  }
  finally {
   if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,125); CloseHandle(child.process); }
   if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);
   if(initialized)DeleteProcThreadAttributeList(attributes);
   if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);
   if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);
   if(inheritedList!=IntPtr.Zero)Marshal.FreeHGlobal(inheritedList);
   if(descriptors!=IntPtr.Zero)Marshal.FreeHGlobal(descriptors);
   if(job!=IntPtr.Zero)CloseHandle(job);
  }
 }
}
`;

export class WindowsJobError extends Schema.TaggedError<WindowsJobError>()("WindowsJobError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

/** A job's global name also reaches a WMI-created command in another Windows session. */
export const windowsJobName = (nonce: string) => `Global\\CodeShip.Job.${nonce}`;

/** Shared with the inline spawn worker; this function must not capture module state. */
export const windowsHostSpawnError = (host: string, cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const code = "code" in error ? error.code : undefined;
  const policy =
    code === "EACCES" ||
    code === "UNKNOWN" ||
    code === 1260 ||
    code === 5 ||
    code === "1260" ||
    code === "5";
  const message = `Could not start the Windows process host ${host}${code === undefined ? "" : ` (${String(code)})`}: ${error.message}${policy ? " AppLocker or WDAC may block this unsigned executable in the user cache." : ""}`;
  return Object.assign(new Error(message, { cause }), {
    path: host,
    ...("code" in error ? { code: error.code } : {}),
    ...("errno" in error ? { errno: error.errno } : {}),
    ...("syscall" in error ? { syscall: error.syscall } : {}),
  });
};

const isFileError = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

interface PreparedWindowsHost {
  readonly executable: string;
  readonly manifestError?: unknown;
}

const preparedHosts = new Map<string, Promise<PreparedWindowsHost>>();
const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const prepareHost = async (
  cache: string,
  manifest: string,
  systemRoot: string,
): Promise<PreparedWindowsHost> => {
  try {
    const [expected, name] = (await NodeFSP.readFile(manifest, "utf8")).trim().split("\n");
    if (expected !== undefined && /^[a-f0-9]{64}$/.test(expected)) {
      const filename = name ?? `${expected}.exe`;
      if (new RegExp(`^${expected}(?:-[a-f0-9]{32})?\\.exe$`).test(filename)) {
        const executable = NodePath.join(cache, filename);
        if (sha256(await NodeFSP.readFile(executable)) === expected) return { executable };
      }
    }
  } catch (error) {
    // An unreadable cache entry is replaceable; a failed write below identifies unusable storage.
    if (!(error instanceof Error && "code" in error)) throw error;
  }
  await NodeFSP.mkdir(cache, { recursive: true });
  const build = await NodeFSP.mkdtemp(NodePath.join(cache, "build-"));
  try {
    const source = NodePath.join(build, "JobHost.cs");
    const binary = NodePath.join(build, "JobHost.exe");
    await NodeFSP.writeFile(source, SOURCE);
    const compiler = NodePath.join(
      systemRoot,
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe",
    );
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        compiler,
        ["/nologo", "/target:exe", "/platform:anycpu", `/out:${binary}`, source],
        { windowsHide: true, timeout: 120_000 },
        (error, stdout, stderr) =>
          error === null ? resolve() : reject(new Error(`${error.message}: ${stdout}${stderr}`)),
      );
    });
    const digest = sha256(await NodeFSP.readFile(binary));
    // Publishers never replace or unlink another server's executable, including a damaged one.
    const filename = `${digest}-${NodeCrypto.randomUUID().replaceAll("-", "")}.exe`;
    const executable = NodePath.join(cache, filename);
    await NodeFSP.link(binary, executable);
    if (sha256(await NodeFSP.readFile(executable)) !== digest)
      throw new Error(
        `The published Windows process host failed SHA-256 verification: ${executable}`,
      );
    const prepared = NodePath.join(build, "host.sha256");
    await NodeFSP.writeFile(prepared, `${digest}\n${filename}`);
    try {
      await NodeFSP.rename(prepared, manifest);
    } catch (manifestError) {
      if (
        !isFileError(manifestError, "EPERM") &&
        !isFileError(manifestError, "EACCES") &&
        !isFileError(manifestError, "EBUSY")
      )
        throw manifestError;
      // A locked index must not prevent using the verified executable this preparation published.
      return { executable, manifestError };
    }
    return { executable };
  } finally {
    await NodeFSP.rm(build, { recursive: true, force: true });
  }
};

/** The framework compiler ships with Windows PowerShell; immutable cached hosts also serve older jobs. */
export const prepareWindowsJobHost = Effect.fn("WindowsJob.prepare")(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (systemRoot === undefined)
    return yield* new WindowsJobError({ detail: "Windows SystemRoot is missing." });
  const cache = NodePath.join(home, ".cache", "t3", "windows-job");
  const manifest = NodePath.join(cache, `${sha256(SOURCE)}.sha256`);
  let preparation = preparedHosts.get(manifest);
  const first = preparation === undefined;
  if (preparation === undefined) {
    preparation = prepareHost(cache, manifest, systemRoot);
    preparedHosts.set(manifest, preparation);
    // One cancelled caller cannot abort compilation shared by other launches.
    void preparation.catch(() => preparedHosts.delete(manifest));
  }
  const pending = preparation;
  const result = yield* Effect.tryPromise({
    try: () => pending,
    catch: (cause) =>
      new WindowsJobError({
        detail: `Could not prepare the Windows process host in ${cache}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  if (first && result.manifestError !== undefined)
    yield* Effect.logWarning("windows-job.cache-index-unavailable", {
      manifest,
      cause: result.manifestError,
    });
  return result.executable;
});

/** Override the native boundary when simulating Windows on another platform. */
export const WindowsJobHost = Context.Reference<ReturnType<typeof prepareWindowsJobHost>>(
  "@t3tools/shared/WindowsJobHost",
  { defaultValue: () => prepareWindowsJobHost() },
);

export interface WindowsJob {
  readonly host: string;
  readonly name: string;
  child?: { readonly pid: number; readonly created: number };
  hostExited?: true;
}

const jobs = new WeakMap<object, WindowsJob>();

/** Retain OS ownership when an adapter passes a handle through another spawner. */
export const attachWindowsJob = (handle: object, job: WindowsJob): void => {
  jobs.set(handle, job);
};

export const windowsJobOf = (handle: object): WindowsJob | undefined => jobs.get(handle);
