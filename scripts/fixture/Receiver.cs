using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace HumanFixture {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct GUI {
      public int size,flags; public IntPtr active,focus,capture,menu,move,caret; public RECT caretRect;
    }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetMessageTime();
    [DllImport("user32.dll")] public static extern IntPtr GetMessageExtraInfo();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder name,int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GUI gui);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);
    [DllImport("user32.dll")] public static extern bool CloseClipboard();
    [DllImport("user32.dll",SetLastError=true)] public static extern uint EnumClipboardFormats(uint format);
    [DllImport("kernel32.dll")] public static extern void SetLastError(uint error);
    [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint format,IntPtr data);
    [DllImport("user32.dll")] public static extern bool EmptyClipboard();
    [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags,UIntPtr bytes);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
    public static object Rect(IntPtr h,bool client) {
      RECT r; if(client) GetClientRect(h,out r); else GetWindowRect(h,out r);
      POINT p=new POINT(); if(client) ClientToScreen(h,ref p);
      return new Dictionary<string,object>{{"x",client?p.X:r.L},{"y",client?p.Y:r.T},{"width",r.R-r.L},{"height",r.B-r.T}};
    }
    // Diagnostics only: which foreign top-level window covers a control's center.
    // Reports class and process name, never window titles.
    public static string Occluder(Control control) {
      RECT r; GetWindowRect(control.Handle,out r);
      POINT p=new POINT(); p.X=(r.L+r.R)/2; p.Y=(r.T+r.B)/2;
      IntPtr root=GetAncestor(WindowFromPoint(p),2);
      if(root==IntPtr.Zero||root==GetAncestor(control.Handle,2)) return null;
      System.Text.StringBuilder name=new System.Text.StringBuilder(256); GetClassName(root,name,name.Capacity);
      uint pid; GetWindowThreadProcessId(root,out pid);
      string process; try { process=Process.GetProcessById((int)pid).ProcessName; } catch { process="pid "+pid; }
      return name+" / "+process;
    }
    public static string Focused() { GUI g=new GUI();g.size=Marshal.SizeOf(g);GetGUIThreadInfo(0,ref g);return g.focus.ToInt64().ToString(); }
  }

  public interface IClipboardSnapshotSource {
    bool Open(IntPtr owner);
    void Close();
    uint NextFormat(uint previous,out int error);
    byte[] ReadFormat(uint format);
    uint Sequence();
  }

  public sealed class Win32ClipboardSnapshotSource : IClipboardSnapshotSource {
    public bool Open(IntPtr owner) { return Native.OpenClipboard(owner); }
    public void Close() { Native.CloseClipboard(); }
    public uint Sequence() { return Native.GetClipboardSequenceNumber(); }
    public uint NextFormat(uint previous,out int error) {
      Native.SetLastError(0);
      uint format=Native.EnumClipboardFormats(previous);
      error=Marshal.GetLastWin32Error();
      return format;
    }
    public byte[] ReadFormat(uint format) {
      IntPtr handle=Native.GetClipboardData(format);
      ulong size=Native.GlobalSize(handle).ToUInt64();
      if(handle==IntPtr.Zero||size==0||size>1048576)throw new InvalidOperationException("unsupported_size");
      IntPtr pointer=Native.GlobalLock(handle);
      if(pointer==IntPtr.Zero)throw new InvalidOperationException("unavailable");
      byte[] bytes=new byte[(int)size];
      try { Marshal.Copy(pointer,bytes,0,bytes.Length);return bytes; }
      catch { Array.Clear(bytes,0,bytes.Length);throw; }
      finally { Native.GlobalUnlock(handle); }
    }
  }

  // Clipboard backup is opaque, eager, process-local raw HGLOBAL bytes. Never serialized.
  // Other formats are deliberately unsupported; reject the phase before any mutation.
  public sealed class ClipboardLease {
    private readonly IClipboardSnapshotSource source;
    private Dictionary<uint,byte[]> backup;
    private uint expected;
    public string State="not_requested";
    public bool Active { get { return backup!=null; } }
    public ClipboardLease() : this(new Win32ClipboardSnapshotSource()) {}
    public ClipboardLease(IClipboardSnapshotSource snapshotSource) { source=snapshotSource; }
    public bool Prepare(IntPtr owner) { return Prepare(owner,false); }
    // allowDiscard: the operator explicitly accepted that a clipboard holding
    // non-text formats is emptied (not restored) after the run.
    public bool Prepare(IntPtr owner,bool allowDiscard) {
      if(Active) return false;
      if(!source.Open(owner)){State="unavailable";return false;}
      Dictionary<uint,byte[]> saved=new Dictionary<uint,byte[]>();
      try {
        int total=0;
        int error;
        string rejected=null;
        for(uint f=source.NextFormat(0,out error);f!=0;f=source.NextFormat(f,out error)) {
          if((f!=1&&f!=7&&f!=13&&f!=16)||saved.ContainsKey(f)){rejected="unsupported_formats";break;}
          byte[] bytes=source.ReadFormat(f);
          saved.Add(f,bytes);
          if(bytes==null||bytes.Length==0||bytes.Length>1048576||(total+=bytes.Length)>1048576){rejected="unsupported_size";break;}
        }
        if(rejected!=null) {
          if(!allowDiscard){State=rejected;return false;}
          expected=source.Sequence();backup=new Dictionary<uint,byte[]>();State="ready_discarding";return true;
        }
        if(error!=0){State="unavailable";return false;}
        expected=source.Sequence();backup=saved;State="ready";return true;
      } catch {State="unavailable";return false;}
      finally {
        if(!Object.ReferenceEquals(backup,saved)) {
          foreach(byte[] bytes in saved.Values)if(bytes!=null)Array.Clear(bytes,0,bytes.Length);
        }
        source.Close();
      }
    }
    public bool Check() { if(!Active)return false;if(expected!=Native.GetClipboardSequenceNumber()){State="conflict";return false;}return true; }
    public bool AcceptOwnWrite(uint before,string token,IntPtr owner) {
      if(!Active||before!=expected||Native.GetClipboardSequenceNumber()==before){State="conflict";return false;}
      if(!Native.OpenClipboard(owner)){State="conflict";return false;}
      try {
        // Compare raw Unicode only to the known run token. Never export foreign data.
        IntPtr h=Native.GetClipboardData(13);ulong bytes=Native.GlobalSize(h).ToUInt64();
        if(h==IntPtr.Zero||bytes<2||bytes>1024){State="conflict";return false;}
        IntPtr p=Native.GlobalLock(h);if(p==IntPtr.Zero){State="conflict";return false;}
        string text;try{text=Marshal.PtrToStringUni(p,(int)bytes/2).TrimEnd('\0');}finally{Native.GlobalUnlock(h);}
        if(text!=token){State="conflict";return false;}
        expected=Native.GetClipboardSequenceNumber();return true;
      } finally {Native.CloseClipboard();}
    }
    public bool Restore(IntPtr owner) {
      if(!Active)return true;if(!Check())return false;
      if(!Native.OpenClipboard(owner)){State="restore_failed";return false;}
      try {
        if(expected!=Native.GetClipboardSequenceNumber()){State="conflict";return false;}
        // Allocate every raw format before destroying test contents.
        Dictionary<uint,IntPtr> handles=new Dictionary<uint,IntPtr>();
        try {
          foreach(KeyValuePair<uint,byte[]> item in backup) {
            IntPtr h=Native.GlobalAlloc(2,new UIntPtr((uint)item.Value.Length));
            if(h==IntPtr.Zero)throw new Exception("allocation");handles.Add(item.Key,h);
            IntPtr p=Native.GlobalLock(h);if(p==IntPtr.Zero)throw new Exception("lock");
            try{Marshal.Copy(item.Value,0,p,item.Value.Length);}finally{Native.GlobalUnlock(h);}
          }
          if(!Native.EmptyClipboard())throw new Exception("empty");
          foreach(uint f in new List<uint>(handles.Keys)) {
            if(Native.SetClipboardData(f,handles[f])==IntPtr.Zero)throw new Exception("restore");
            handles[f]=IntPtr.Zero;
          }
          foreach(byte[] bytes in backup.Values)Array.Clear(bytes,0,bytes.Length);
          backup=null;State="restored";return true;
        } catch {State="restore_failed";return false;}
        finally {foreach(IntPtr h in handles.Values)if(h!=IntPtr.Zero)Native.GlobalFree(h);}
      } finally {Native.CloseClipboard();}
    }
  }

  public sealed class Canvas : Panel {
    public int Moves,Downs,Ups,Clicks,Drops,DragMoves,Vertical,Horizontal,WheelCount;
    // Windows also posts WM_MOUSEMOVE without movement, so only position changes
    // count. The worker tags SendInput with dwExtraInfo 'HIMC'; anything else is
    // a person. LastInjectedTick is GetMessageTime of the newest tagged input.
    public int LastInjectedTick,PhysicalInputs;
    private void Input(){if(Native.GetMessageExtraInfo().ToInt64()==0x48494d43)LastInjectedTick=Native.GetMessageTime();else PhysicalInputs++;}
    private bool held,hasLast;
    private Point last;
    protected override void OnMouseMove(MouseEventArgs e){
      if(!hasLast||e.Location!=last){Moves++;if(held)DragMoves++;Input();}
      last=e.Location;hasLast=true;base.OnMouseMove(e);Invalidate();
    }
    protected override void OnMouseDown(MouseEventArgs e){Downs++;Input();held=e.Button==MouseButtons.Left;base.OnMouseDown(e);}
    protected override void OnMouseUp(MouseEventArgs e){Ups++;Input();if(held&&e.X>Width/2)Drops++;held=false;base.OnMouseUp(e);Invalidate();}
    protected override void OnMouseClick(MouseEventArgs e){Clicks++;base.OnMouseClick(e);}
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x20A||m.Msg==0x20E) {
        int delta=(short)((m.WParam.ToInt64()>>16)&65535);WheelCount++;Input();
        if(m.Msg==0x20A)Vertical+=delta;else Horizontal+=delta;
        Invalidate();m.Result=IntPtr.Zero;return;
      }
      base.WndProc(ref m);
    }
    protected override void OnPaint(PaintEventArgs e) {
      base.OnPaint(e);e.Graphics.DrawString("Canvas / wheel receiver. Drag to right half.\nVertical="+Vertical+" Horizontal="+Horizontal+" Drops="+Drops,Font,Brushes.Black,8,8);
      e.Graphics.DrawRectangle(Pens.SteelBlue,Width/2,45,Width/2-10,Height-55);
    }
  }

  public sealed class Session : IDisposable {
    public readonly Form Receiver=new Form(),Parking=new Form();
    public readonly ClipboardLease Clipboard=new ClipboardLease();
    public readonly TextBox A=new TextBox(),B=new TextBox();
    public readonly Canvas Canvas=new Canvas();
    public readonly Panel Activation=new Panel(),ParkPad=new Panel();
    public readonly Label Instruction=new Label();
    public readonly Stopwatch Clock=Stopwatch.StartNew();
    public readonly string Nonce,Identity;
    public bool Shown,Closing,Watchdog;
    public int ParkDown,ParkUp,ADown,AUp,BDown,BUp,Changes,ActivationDown,ActivationUp;
    public long Sequence;
    private readonly Queue<object> keys=new Queue<object>();
    public string Phase="startup",CommandError=null;
    public Session(string nonce) {
      Nonce=nonce;Process process=Process.GetCurrentProcess();Identity=process.Id+":"+process.StartTime.ToUniversalTime().ToFileTimeUtc();
      Rectangle area=Screen.PrimaryScreen.WorkingArea;
      Receiver.Text="Human Input receiver "+nonce;Receiver.StartPosition=FormStartPosition.Manual;
      Receiver.Bounds=new Rectangle(area.X+15,area.Y+15,Math.Min(850,area.Width-260),Math.Min(720,area.Height-40));
      Receiver.WindowState=FormWindowState.Normal;Receiver.TopMost=true;
      Parking.Text="Parking "+nonce;Parking.StartPosition=FormStartPosition.Manual;
      Parking.Bounds=new Rectangle(Receiver.Right+10,area.Y+15,220,180);Parking.WindowState=FormWindowState.Normal;Parking.TopMost=true;
      Instruction.SetBounds(15,10,Receiver.ClientSize.Width-30,65);Instruction.Text="Automated acceptance in progress. Do not touch the mouse or keyboard.";
      A.SetBounds(15,120,Receiver.ClientSize.Width-30,80);A.Multiline=true;A.AcceptsReturn=true;A.TabIndex=1;
      B.SetBounds(15,210,Receiver.ClientSize.Width-30,80);B.Multiline=true;B.AcceptsReturn=true;B.TabIndex=2;
      A.TextChanged+=delegate{Changes++;};B.TextChanged+=delegate{Changes++;};
      A.KeyDown+=delegate(object sender,KeyEventArgs e){ADown++;Key("A","down",e);};
      A.KeyUp+=delegate(object sender,KeyEventArgs e){AUp++;Key("A","up",e);};
      B.KeyDown+=delegate(object sender,KeyEventArgs e){BDown++;Key("B","down",e);};
      B.KeyUp+=delegate(object sender,KeyEventArgs e){BUp++;Key("B","up",e);};
      Canvas.SetBounds(15,305,Receiver.ClientSize.Width-30,Math.Max(130,Receiver.ClientSize.Height-390));Canvas.BackColor=Color.AliceBlue;
      Activation.SetBounds(15,Receiver.ClientSize.Height-65,Receiver.ClientSize.Width-30,45);Activation.BackColor=Color.LightGreen;
      Label inert=new Label();inert.Text="Neutral activation pad (no content action)";inert.AutoSize=true;inert.Location=new Point(8,12);inert.Enabled=false;Activation.Controls.Add(inert);
      Activation.MouseDown+=delegate{ActivationDown++;};Activation.MouseUp+=delegate{ActivationUp++;};
      Receiver.Controls.AddRange(new Control[]{Instruction,A,B,Canvas,Activation});
      // Neutral pad: the harness moves foreground here before testing safe activation.
      ParkPad.Dock=DockStyle.Fill;ParkPad.BackColor=Color.Khaki;
      ParkPad.MouseDown+=delegate{ParkDown++;};ParkPad.MouseUp+=delegate{ParkUp++;};Parking.Controls.Add(ParkPad);
      Receiver.Shown+=delegate{Shown=true;};
      Receiver.FormClosing+=delegate(object sender,FormClosingEventArgs e){if(Clipboard.Active){e.Cancel=true;Instruction.Text="Clipboard retained in memory: "+Clipboard.State+". Resolve before closing.";}else{Closing=true;Parking.Close();}};
      Parking.FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!Closing)e.Cancel=true;};
    }
    private void Key(string editor,string edge,KeyEventArgs e) {
      // Numeric allowlisted editing/shortcut evidence; never record arbitrary typed characters.
      int k=(int)e.KeyCode;if(!(k==13||k==9||k==8||k==46||k>=35&&k<=40||e.Control&&(k==65||k==67||k==86||k==88)))return;
      keys.Enqueue(new Dictionary<string,object>{{"editor",editor},{"edge",edge},{"key",k},{"ctrl",e.Control},{"shift",e.Shift},{"at_ms",Clock.ElapsedMilliseconds}});
      while(keys.Count>64)keys.Dequeue();
    }
    private object Editor(TextBox box) {
      Dictionary<string,object> matches=new Dictionary<string,object>();
      matches.Add("empty",box.Text=="");matches.Add("typed",box.Text=="Hi 4!字");
      matches.Add("newline",box.Text=="Hi 4!字\r\n");matches.Add("token",box.Text=="clip-"+Nonce);
      matches.Add("double_token",box.Text=="clip-"+Nonce+"clip-"+Nonce);
      matches.Add("long",box.Text=="01234567890123456789");
      return new Dictionary<string,object> {
        {"hwnd",box.Handle.ToInt64().ToString()},
        {"rect",Native.Rect(box.Handle,false)},
        {"length",box.TextLength},
        {"selection_start",box.SelectionStart},
        {"selection_length",box.SelectionLength},
        {"matches",matches}
      };
    }
    private object Window(Form form) {
      return new Dictionary<string,object> {
        {"hwnd",form.Handle.ToInt64().ToString()},
        {"identity",Identity},
        {"rect",Native.Rect(form.Handle,false)},
        {"client",Native.Rect(form.Handle,true)},
        {"dpi",Native.GetDpiForWindow(form.Handle)},
        {"visible",form.Visible},
        {"enabled",Native.IsWindowEnabled(form.Handle)},
        {"window_state",form.WindowState.ToString()}
      };
    }
    public object Snapshot() {
      return new Dictionary<string,object> {
        {"nonce",Nonce}, {"pid",Process.GetCurrentProcess().Id},
        {"sequence",++Sequence}, {"elapsed_ms",Clock.ElapsedMilliseconds}, {"tick",Environment.TickCount},
        {"shown",Shown}, {"phase",Phase},
        {"focus",Native.Focused()}, {"receiver",Window(Receiver)}, {"parking",Window(Parking)},
        {"a",Editor(A)}, {"b",Editor(B)},
        {"canvas",new Dictionary<string,object> {
          {"rect",Native.Rect(Canvas.Handle,false)},
          {"moves",Canvas.Moves}, {"downs",Canvas.Downs}, {"ups",Canvas.Ups},
          {"clicks",Canvas.Clicks}, {"drops",Canvas.Drops}, {"drag_moves",Canvas.DragMoves},
          {"vertical",Canvas.Vertical}, {"horizontal",Canvas.Horizontal}, {"wheel_count",Canvas.WheelCount},
          {"last_injected_tick",Canvas.LastInjectedTick}, {"physical_inputs",Canvas.PhysicalInputs}
        }},
        {"activation",new Dictionary<string,object> {
          {"rect",Native.Rect(Activation.Handle,false)}, {"downs",ActivationDown}, {"ups",ActivationUp}
        }},
        {"park",new Dictionary<string,object> {
          {"rect",Native.Rect(ParkPad.Handle,false)}, {"downs",ParkDown}, {"ups",ParkUp}
        }},
        {"occluders",new Dictionary<string,object> {
          {"a",Native.Occluder(A)}, {"b",Native.Occluder(B)}, {"canvas",Native.Occluder(Canvas)}, {"activation",Native.Occluder(Activation)}
        }},
        {"keys",keys.ToArray()}, {"changes",Changes}, {"clipboard",Clipboard.State},
        {"clipboard_sequence",Native.GetClipboardSequenceNumber()},
        {"closing",Closing}, {"watchdog",Watchdog}, {"command_error",CommandError}
      };
    }
    public void Close() {if(!Clipboard.Active){Closing=true;Receiver.Close();Parking.Close();}}
    public void Dispose(){Receiver.Dispose();Parking.Dispose();}
  }
}
