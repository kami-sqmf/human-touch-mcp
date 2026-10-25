param([ValidateSet('Default','Legacy','Enabled','Fixture')][string]$Mode='Fixture')
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'This regression requires Windows PowerShell 5 / .NET Framework' }
$switchName='Switch.System.Windows.Forms.DoNotSupportSelectAllShortcutInMultilineTextBox'
if ($Mode -eq 'Legacy') { [AppContext]::SetSwitch($switchName,$true) }
if ($Mode -eq 'Enabled') { [AppContext]::SetSwitch($switchName,$false) }
if ($Mode -eq 'Fixture') { & (Join-Path $PSScriptRoot '../../scripts/test-window.ps1') -CompileOnly }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
public sealed class EditorCommandProbe : TextBox {
  public bool Command(Keys key) {
    Message message = new Message();
    return base.ProcessCmdKey(ref message,key);
  }
  static void Require(bool value,string message) { if(!value)throw new Exception(message); }
  public static void Run(bool legacy) {
    using(EditorCommandProbe box=new EditorCommandProbe()) {
      box.Multiline=true;box.AcceptsReturn=true;box.Text="Hi 4!\u5b57";box.Select(6,0);
      bool handled=box.Command(Keys.Control|Keys.A);
      Console.WriteLine("Ctrl+A handled={0}; selection_start={1}; selection_length={2}; handle_created={3}",handled,box.SelectionStart,box.SelectionLength,box.IsHandleCreated);
      Require(!box.IsHandleCreated,"Probe must remain an in-memory control without an HWND");
      Require(handled==!legacy && box.SelectionStart==(legacy?6:0) && box.SelectionLength==(legacy?0:6),"Ctrl+A must select all six characters unless explicitly testing legacy behavior");
      foreach(Keys key in new[]{Keys.Enter,Keys.Back,Keys.A,Keys.Escape,Keys.Control|Keys.Shift|Keys.A}) {
        box.Select(6,0);
        Require(!box.Command(key),"Unexpected command interception: "+key);
        Require(box.Text=="Hi 4!\u5b57" && box.SelectionStart==6 && box.SelectionLength==0,"Unexpected command mutation: "+key);
      }
      box.ShortcutsEnabled=false;
      bool disabledHandled=box.Command(Keys.Control|Keys.A);
      Console.WriteLine("ShortcutsEnabled=false Ctrl+A handled={0}; selection_length={1}",disabledHandled,box.SelectionLength);
      Require(box.Text=="Hi 4!\u5b57" && box.SelectionStart==6 && box.SelectionLength==0,"Disabled shortcuts must not select or mutate text");
      Require(!box.IsHandleCreated,"Probe unexpectedly created an HWND");
      Console.WriteLine("Enter, Backspace, A, Escape, Ctrl+Shift+A command fallthrough and ShortcutsEnabled=false preserved.");
    }
  }
}
'@ -ReferencedAssemblies System.Windows.Forms
Write-Output "PowerShell=$($PSVersionTable.PSVersion); CLR=$([Environment]::Version); Mode=$Mode"
[EditorCommandProbe]::Run($Mode -eq 'Legacy')
$switchValue=$false
$known=[AppContext]::TryGetSwitch($switchName,[ref]$switchValue)
Write-Output "Initialized switch known=$known; value=$switchValue"
Write-Output 'Editor command regression passed; no HWND, visible UI, desktop input or clipboard access.'
