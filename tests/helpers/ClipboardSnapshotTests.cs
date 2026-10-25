using System;
using HumanFixture;

public static class ClipboardSnapshotTests {
  private sealed class Source : IClipboardSnapshotSource {
    public bool Partial,Fail,Foreign;
    public int Closed;
    public byte[] Bytes=new byte[]{65,0,0,0};
    public bool Open(IntPtr owner) { return true; }
    public void Close() { Closed++; }
    public uint Sequence() { return 7; }
    public uint NextFormat(uint previous,out int error) {
      if(Partial&&previous==0){error=0;return 13;}
      if(Foreign&&previous==13){error=0;return 49161;}
      error=Fail?5:0;return 0;
    }
    public byte[] ReadFormat(uint format) { return Bytes; }
  }
  private static void Require(bool ok,string label) { if(!ok)throw new Exception(label); }
  public static void Run() {
    Source empty=new Source();ClipboardLease lease=new ClipboardLease(empty);
    Require(lease.Prepare(IntPtr.Zero)&&lease.Active&&lease.State=="ready","empty-success rejected");
    Require(empty.Closed==1,"empty lease not closed");
    Source startFailure=new Source();startFailure.Fail=true;
    lease=new ClipboardLease(startFailure);
    Require(!lease.Prepare(IntPtr.Zero)&&!lease.Active&&lease.State=="unavailable","initial enumeration error admitted mutation");
    Require(startFailure.Closed==1,"failed lease not closed");
    Source partialFailure=new Source();partialFailure.Partial=true;partialFailure.Fail=true;
    lease=new ClipboardLease(partialFailure);
    Require(!lease.Prepare(IntPtr.Zero)&&!lease.Active,"partial enumeration error admitted mutation");
    foreach(byte b in partialFailure.Bytes)Require(b==0,"partial backup bytes not wiped");
    Require(partialFailure.Closed==1,"partial lease not closed");
    Source complete=new Source();complete.Partial=true;
    lease=new ClipboardLease(complete);
    Require(lease.Prepare(IntPtr.Zero)&&lease.Active,"complete supported snapshot rejected");
    Require(complete.Bytes[0]==65,"successful snapshot was erased prematurely");
    Source foreign=new Source();foreign.Partial=true;foreign.Foreign=true;
    lease=new ClipboardLease(foreign);
    Require(!lease.Prepare(IntPtr.Zero)&&!lease.Active&&lease.State=="unsupported_formats","foreign format admitted without discard consent");
    foreach(byte b in foreign.Bytes)Require(b==0,"rejected backup bytes not wiped");
    Source discarded=new Source();discarded.Partial=true;discarded.Foreign=true;
    lease=new ClipboardLease(discarded);
    Require(lease.Prepare(IntPtr.Zero,true)&&lease.Active&&lease.State=="ready_discarding","explicit discard consent rejected");
    foreach(byte b in discarded.Bytes)Require(b==0,"discarded partial backup bytes not wiped");
    Require(discarded.Closed==1,"discarding lease not closed");
  }
}
