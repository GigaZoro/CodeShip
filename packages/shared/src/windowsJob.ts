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
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr data, int size, out int needed);
 [DllImport("ntdll.dll")] static extern int RtlNtStatusToDosError(int status);
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr data, int size, out int needed);
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
  return made;
 }
 // ProcessCommandLineInformation: a UNICODE_STRING whose text follows it in the same buffer.
 static string CommandLine(IntPtr process) {
  int size;
  NtQueryInformationProcess(process,60,IntPtr.Zero,0,out size);
  size=Math.Max(size,2*IntPtr.Size);
  IntPtr p=Marshal.AllocHGlobal(size);
  try {
   int status=NtQueryInformationProcess(process,60,p,size,out size);
   if(status<0) throw new Win32Exception(RtlNtStatusToDosError(status));
   int length=(ushort)Marshal.ReadInt16(p);
   return length==0 ? "" : Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,IntPtr.Size),length/2);
  } finally { Marshal.FreeHGlobal(p); }
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
 static void ReleaseStreams(Startup startup, IntPtr control, IntPtr reply) {
  var handles=StreamHandles(startup);
  handles.Remove(control); handles.Remove(reply);
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
    if(CompareObjectHandles(candidate,control) || CompareObjectHandles(candidate,reply)) continue;
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
 struct Listed { public int pid, parent; public long created; }
 // SystemProcessInformation: every process at one moment, with its parent's pid and its start.
 static List<Listed> Processes() {
  for(int size=1<<20;;) {
   IntPtr p=Marshal.AllocHGlobal(size);
   try {
    int needed;
    int status=NtQuerySystemInformation(5,p,size,out needed);
    if(status==unchecked((int)0xC0000004)) { size=Math.Max(size*2,needed+65536); continue; }
    if(status<0) throw new Win32Exception(RtlNtStatusToDosError(status));
    var listed=new List<Listed>();
    int pidAt=IntPtr.Size==8 ? 80 : 68, parentAt=IntPtr.Size==8 ? 88 : 72;
    for(int offset=0;;) {
     IntPtr entry=IntPtr.Add(p,offset);
     listed.Add(new Listed { created=Marshal.ReadInt64(entry,32), pid=(int)Marshal.ReadIntPtr(entry,pidAt).ToInt64(), parent=(int)Marshal.ReadIntPtr(entry,parentAt).ToInt64() });
     int next=Marshal.ReadInt32(entry);
     if(next==0) return listed;
     offset+=next;
    }
   } finally { Marshal.FreeHGlobal(p); }
  }
 }
 // A legacy command has no job. A process is its member's child when its parent pid names a
 // member that still holds that pid and it started after that member, which tells it from the
 // orphan of an earlier holder of the pid. A process whose parent ended unseen cannot be traced.
 static List<Listed> Started(List<Listed> listed, Dictionary<int,long> members, Dictionary<int,IntPtr> open) {
  var parents=new Dictionary<int,long>();
  foreach(var entry in listed) { long created; if(members.TryGetValue(entry.pid,out created) && created==entry.created) parents[entry.pid]=created; }
  foreach(var pid in open.Keys) parents[pid]=members[pid];
  var found=new List<Listed>();
  for(bool grew=true;grew;) {
   grew=false;
   foreach(var entry in listed) {
    long parent;
    if(entry.pid==0 || parents.ContainsKey(entry.pid) || !parents.TryGetValue(entry.parent,out parent) || entry.created<=parent) continue;
    parents[entry.pid]=entry.created;
    found.Add(entry);
    grew=true;
   }
  }
  return found;
 }
 // An open handle keeps the pid from passing on, so it names the process its start time proves.
 static void Pin(int pid, long created, Dictionary<int,long> members, Dictionary<int,IntPtr> open, Dictionary<int,string> left) {
  if(open.ContainsKey(pid)) return;
  IntPtr process=OpenProcess(0x101001,false,pid);
  if(process==IntPtr.Zero) {
   int error=Marshal.GetLastWin32Error();
   if(error==87) { left.Remove(pid); return; }
   members[pid]=created;
   left[pid]="could not open it: "+new Win32Exception(error).Message;
   return;
  }
  long actual;
  try { actual=Created(process); }
  catch(Exception error) { CloseHandle(process); members[pid]=created; left[pid]="could not read when it started: "+error.Message; return; }
  if(actual!=created) { CloseHandle(process); left.Remove(pid); return; }
  members[pid]=created;
  left.Remove(pid);
  open[pid]=process;
 }
 static void PrintLeft(Dictionary<int,long> members, Dictionary<int,string> left) {
  foreach(var pair in left) Console.WriteLine("left "+pair.Key+" "+members[pair.Key]+" "+pair.Value.Replace("\r"," ").Replace("\n"," ").Trim());
 }
 // Stops each root a pid and full FILETIME prove with the processes it started, and prints a
 // "left <pid> <created> <reason>" line for each one still running, which a later stop starts from.
 static int StopTree(string[] args) {
  var members=new Dictionary<int,long>();
  var open=new Dictionary<int,IntPtr>();
  var left=new Dictionary<int,string>();
  var stopped=new HashSet<int>();
  try {
   if(args.Length<3 || args.Length%2==0) throw new ArgumentException("stop-tree takes pairs of a pid and its full FILETIME creation identity.");
   var roots=new List<KeyValuePair<int,long>>();
   for(int i=1;i<args.Length;i+=2) roots.Add(new KeyValuePair<int,long>(int.Parse(args[i]),long.Parse(args[i+1])));
   foreach(var root in roots) Pin(root.Key,root.Value,members,open,left);
   var wait=Stopwatch.StartNew();
   for(int round=0;;round++) {
    // A member stopped in an earlier round may have started a process before it ended.
    foreach(var entry in Started(Processes(),members,open)) Pin(entry.pid,entry.created,members,open,left);
    var stopping=new List<int>();
    foreach(var pid in open.Keys) if(!stopped.Contains(pid)) stopping.Add(pid);
    if(stopping.Count==0) break;
    if(round==16) { foreach(var pid in stopping) left[pid]="the command kept starting processes while CodeShip stopped them"; break; }
    foreach(var pid in stopping) {
     stopped.Add(pid);
     if(TerminateProcess(open[pid],1)) continue;
     int error=Marshal.GetLastWin32Error();
     // A process that already ended refuses to be terminated.
     if(WaitForSingleObject(open[pid],0)!=0) left[pid]="could not stop it: "+new Win32Exception(error).Message;
    }
    foreach(var pid in stopping) {
     if(left.ContainsKey(pid)) continue;
     uint waited=WaitForSingleObject(open[pid],(uint)Math.Max(0,20000-wait.ElapsedMilliseconds));
     if(waited==0xffffffff) throw new Win32Exception();
     if(waited!=0) left[pid]="it did not end within 20 seconds of being stopped";
    }
   }
   PrintLeft(members,left);
   return 0;
  } catch(Exception error) {
   foreach(var pid in members.Keys) if(!left.ContainsKey(pid) && !(open.ContainsKey(pid) && stopped.Contains(pid) && WaitForSingleObject(open[pid],0)==0)) left[pid]=error.Message;
   Console.Error.WriteLine("Could not stop the command's processes: "+error.Message);
   PrintLeft(members,left);
   return 1;
  } finally { foreach(var handle in open.Values) CloseHandle(handle); }
 }
 public static int Main(string[] args) {
  IntPtr job=IntPtr.Zero;
  IntPtr attributes=IntPtr.Zero, jobList=IntPtr.Zero, descriptors=IntPtr.Zero, inheritedList=IntPtr.Zero, control=IntPtr.Zero, reply=IntPtr.Zero;
  bool initialized=false, started=false;
  ProcessInfo child=new ProcessInfo();
  string diagnostic=null;
  string record = args.Length > 2 && (args[0] == "run" || args[0] == "run-raw") ? args[2] : "";
  try {
   if(args.Length < 2) throw new ArgumentException("Expected an operation and a job name or pid.");
   if(args[0]=="stop-tree") return StopTree(args);
   if(args[0]=="git-path") {
    string target=args[2];
    bool script=target.EndsWith(".cmd",StringComparison.OrdinalIgnoreCase)||target.EndsWith(".bat",StringComparison.OrdinalIgnoreCase);
    // cmd expands a variable once, so a % or ! in the path stays as written; the shim never sees it.
    if(script) Environment.SetEnvironmentVariable("T3CODE_GIT_SHIM",target);
    args=script ? new[] { "run-raw",args[1],"",Path.Combine(Environment.SystemDirectory,"cmd.exe"),"/d","/v:off","/s","/c","\"set \"T3CODE_GIT_SHIM=\" & \"%T3CODE_GIT_SHIM%\" --exec-path\"" }
     : new[] { "run",args[1],"",target,"--exec-path" };
   }
   if(args[0]=="identity") {
    IntPtr process = OpenProcess(0x1000, false, int.Parse(args[1]));
    if(process == IntPtr.Zero) { if(Marshal.GetLastWin32Error() == 87) return 0; throw new Win32Exception(); }
    // The open handle keeps the pid from passing on, so both answers are about one process.
    try { Console.WriteLine(args.Length<3 ? Created(process).ToString() : Created(process)+(CommandLine(process).IndexOf(args[2],StringComparison.Ordinal)>=0 ? " named" : " other")); }
    finally { CloseHandle(process); }
    return 0;
   }
   if(args[0]=="stop" || args[0]=="count") {
    job=OpenJobObject(14,false,args[1]);
    if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) { Console.WriteLine(args[0]=="count" ? "0" : "Job already gone."); return 0; } throw new Win32Exception(); }
    bool counting=args[0]=="count";
    if(args.Length!=4) throw new ArgumentException("A job operation requires its recorded child pid and full FILETIME creation identity.");
    IntPtr owner=OpenProcess(0x1000,false,int.Parse(args[2]));
    if(owner==IntPtr.Zero) {
     if(Marshal.GetLastWin32Error()==87) { Console.WriteLine(counting ? "0" : "Job not ours: recorded child is gone."); return 0; }
     throw new Win32Exception();
    }
    try {
     bool member;
     if(Created(owner)!=long.Parse(args[3])) { Console.WriteLine(counting ? "0" : "Job not ours: child identity changed."); return 0; }
     Check(IsProcessInJob(owner,job,out member));
     if(!member) { Console.WriteLine(counting ? "0" : "Job not ours: recorded child is not a member."); return 0; }
     if(counting) Console.WriteLine(Count(job));
     else Stop(job);
    } finally { CloseHandle(owner); }
    return 0;
   }
   bool owned=args[0]=="owned" || args[0]=="owned-raw";
   if((args[0]!="run" && args[0]!="run-raw" && !owned) || args.Length < 4) throw new ArgumentException("Expected run or owned, job name, pid file or control descriptor and command.");
   if(!owned) {
    string destination=record.Length==0 ? Environment.GetEnvironmentVariable("T3CODE_WINDOWS_JOB_DIAGNOSTIC") : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(record)),"output.log");
    Environment.SetEnvironmentVariable("T3CODE_WINDOWS_JOB_DIAGNOSTIC",null);
    if(String.IsNullOrEmpty(destination)) throw new ArgumentException("An unrecorded command host requires a separate diagnostic file.");
    diagnostic=Path.GetFullPath(destination);
    // cmd.exe opens redirected output without sharing existing writers.
    using(var writable=new FileStream(diagnostic,FileMode.Append,FileAccess.Write,FileShare.ReadWrite)) {}
   }
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
   ReleaseStreams(startup,control,reply);
   Directory.SetCurrentDirectory(Environment.SystemDirectory);
   if(record.Length != 0) Publish(record, child.pid + " ft:" + Created(child.process));
   if(owned) SendControl(reply,"S " + child.pid + " " + Created(child.process));
   Check(ResumeThread(child.thread)!=0xffffffff);
   started=true;
   Check(WaitForSingleObject(child.process,0xffffffff)!=0xffffffff);
   uint code;
   Check(GetExitCodeProcess(child.process,out code));
   Stop(job);
   return unchecked((int)code);
  } catch(Exception error) {
   string message=(started ? "Could not end the command's job: " : "Could not start the command: ")+error.Message;
   if(diagnostic!=null) File.AppendAllText(diagnostic,message+Environment.NewLine);
   else if(reply==IntPtr.Zero) Console.Error.WriteLine(message);
   if(reply!=IntPtr.Zero) {
    try { SendControl(reply,"E " + (error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0) + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(started ? message : error.Message))); } catch {}
   }
   if(!started && record.Length != 0) {
    try {
     Publish(Path.Combine(Path.GetDirectoryName(record), "exit-status"), "125");
    } catch(Exception outputError) {
     if(diagnostic!=null) File.AppendAllText(diagnostic,outputError.Message+Environment.NewLine);
     else Console.Error.WriteLine(outputError.Message);
    }
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

/**
 * The 64-bit compiler, present on x64 and ARM64 Windows. A 32-bit one would run under WOW64, and
 * fspy hangs `vp run` when a traced test starts a WOW64 process (AB#7374), so there is no fallback.
 */
export const windowsFrameworkCompiler = (systemRoot: string) =>
  NodePath.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

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
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        windowsFrameworkCompiler(systemRoot),
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

/** FILETIME stays a decimal string across IPC, persistence and native process handles. */
export const parseWindowsProcessIdentity = (value: string | undefined) =>
  value !== undefined &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9_223_372_036_854_775_807n
    ? value
    : undefined;

/** Milliseconds are for display and legacy loss evidence only, never stop authorization. */
export const windowsCreationTimeMillis = (identity: string) =>
  Number((BigInt(identity) - 116_444_736_000_000_000n) / 10_000n);

export interface WindowsJob {
  readonly host: string;
  readonly name: string;
  child?: { readonly pid: number; readonly created: string };
  hostExited?: true;
}

const jobs = new WeakMap<object, WindowsJob>();

/** Retain OS ownership when an adapter passes a handle through another spawner. */
export const attachWindowsJob = (handle: object, job: WindowsJob): void => {
  jobs.set(handle, job);
};

export const windowsJobOf = (handle: object): WindowsJob | undefined => jobs.get(handle);
