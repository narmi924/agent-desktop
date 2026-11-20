# Window event stream for the resident host's watches. Runs under Windows PowerShell 5.1 and prints one JSON line per event:
#   {"e":"win","op":"show|hide|gone|title","hwnd":N,"title":"...","cls":"...","pid":N}   a top-level window changed
#   {"e":"dirty","pid":N}                                                                  something inside a window of that process changed
#   {"e":"hash","hwnd":N,"hash":"..."}                                                     answer to a "hash HWND" line on stdin
#   {"e":"list","windows":[...]}                                                           answer to a "list" line on stdin
# Out-of-context WinEvent hooks cost nothing while nothing changes. Nothing is read from window contents except titles.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class WatchHelper {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    const uint EVENT_OBJECT_DESTROY = 0x8001, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003, EVENT_OBJECT_NAMECHANGE = 0x800C;
    static WinEventProc keep;
    static readonly object gate = new object();
    static readonly Dictionary<uint, long> dirtyAt = new Dictionary<uint, long>();

    static string Esc(string s) {
        var b = new StringBuilder();
        foreach (char c in s ?? "") {
            if (c == '"' || c == '\\') { b.Append('\\').Append(c); }
            else if (c < 0x20) { b.Append("\\u").Append(((int)c).ToString("x4")); }
            else b.Append(c);
        }
        return b.ToString();
    }

    static void Emit(string line) { lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

    static string Describe(IntPtr hwnd) {
        var title = new StringBuilder(512); GetWindowText(hwnd, title, 512);
        var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        return "\"hwnd\":" + hwnd.ToInt64() + ",\"title\":\"" + Esc(title.ToString()) + "\",\"cls\":\"" + Esc(cls.ToString()) + "\",\"pid\":" + pid + ",\"visible\":" + (IsWindowVisible(hwnd) ? "true" : "false");
    }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        if (hwnd == IntPtr.Zero) return;
        bool topLevel = idObject == 0 && idChild == 0 && GetAncestor(hwnd, 2) == hwnd;
        if (topLevel) {
            string op = ev == EVENT_OBJECT_SHOW ? "show" : ev == EVENT_OBJECT_HIDE ? "hide" : ev == EVENT_OBJECT_DESTROY ? "gone" : ev == EVENT_OBJECT_NAMECHANGE ? "title" : null;
            if (op != null) Emit("{\"e\":\"win\",\"op\":\"" + op + "\"," + Describe(hwnd) + "}");
            return;
        }
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return;
        long now = Environment.TickCount;
        lock (gate) {
            long last;
            if (dirtyAt.TryGetValue(pid, out last) && now - last < 500) return;
            dirtyAt[pid] = now;
        }
        Emit("{\"e\":\"dirty\",\"pid\":" + pid + "}");
    }

    public static string List() {
        var parts = new List<string>();
        EnumWindows((h, l) => { if (IsWindowVisible(h)) parts.Add("{" + Describe(h) + "}"); return true; }, IntPtr.Zero);
        return "{\"e\":\"list\",\"windows\":[" + string.Join(",", parts) + "]}";
    }

    /// A fingerprint of every pixel the window shows, so a few changed characters change it.
    public static string Hash(long handle) {
        IntPtr hwnd = new IntPtr(handle);
        RECT r; if (!GetWindowRect(hwnd, out r)) return "";
        int w = Math.Max(1, r.Right - r.Left), h = Math.Max(1, r.Bottom - r.Top);
        using (var full = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(full)) { IntPtr dc = g.GetHdc(); PrintWindow(hwnd, dc, 2); g.ReleaseHdc(dc); }
            BitmapData data = full.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                byte[] bytes = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                ulong hash = 14695981039346656037UL;
                for (int i = 0; i < bytes.Length; i++) { hash ^= bytes[i]; hash *= 1099511628211UL; }
                return hash.ToString("x16");
            } finally { full.UnlockBits(data); }
        }
    }

    /// PrintWindow waits on the window's own thread; a window that is busy or closing would stall every later request.
    /// Past the limit the answer is empty and the reader goes on; the stalled capture finishes or dies on its own thread.
    public static string HashWithin(long handle, int ms) {
        string result = "";
        var worker = new Thread(() => { try { result = Hash(handle); } catch { result = ""; } });
        worker.IsBackground = true;
        worker.Start();
        return worker.Join(ms) ? result : "";
    }

    public static void Run() {
        keep = new WinEventProc(OnEvent);
        SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, IntPtr.Zero, keep, 0, 0, 2);
        SetWinEventHook(EVENT_OBJECT_NAMECHANGE, 0x800E, IntPtr.Zero, keep, 0, 0, 2);
        SetWinEventHook(0x8004, 0x8004, IntPtr.Zero, keep, 0, 0, 2);
        var reader = new Thread(() => {
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                line = line.Trim();
                try {
                    if (line == "list") Emit(List());
                    else if (line.StartsWith("hash ")) { long h = long.Parse(line.Substring(5)); Emit("{\"e\":\"hash\",\"hwnd\":" + h + ",\"hash\":\"" + HashWithin(h, 1500) + "\"}"); }
                } catch (Exception ex) { Emit("{\"e\":\"error\",\"message\":\"" + Esc(ex.Message) + "\"}"); }
            }
            Application.Exit();
        });
        reader.IsBackground = true;
        reader.Start();
        Emit("{\"e\":\"ready\"}");
        Application.Run();
    }
}
'@
[WatchHelper]::Run()
