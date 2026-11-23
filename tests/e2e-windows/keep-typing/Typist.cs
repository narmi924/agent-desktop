// Keep-typing check: a note window in front receives steady typing while a tool works on other windows.
// It records how long the note lost the foreground and to which window, cursor moves that no hand made, input
// that some other program injected, and whether every character typed reached the note.
// C# 5, so Windows PowerShell 5.1 Add-Type compiles it.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class KeepTyping
{
    const uint MARK = 0x4B545950;
    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const int WM_MOUSEMOVE = 0x0200;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    static HookProc keyProc, mouseProc;
    static IntPtr keyHook, mouseHook;
    static readonly object gate = new object();
    static readonly Stopwatch clock = new Stopwatch();
    static Form form;
    static TextBox note;
    static IntPtr formHandle;
    static volatile bool stopping;

    static long lastHandMouseMs = -1000;
    static int handKeys, handMouse, foreignKeys, foreignMouseMoves, foreignMouseButtons, foreignWheel;
    static int cursorMoves, cursorJumps;
    static double cursorPath;
    static int heldBack;
    static readonly StringBuilder sent = new StringBuilder();
    static readonly List<string> losses = new List<string>();
    static long lostTotalMs, longestLossMs;

    static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            lock (gate)
            {
                if ((k.flags & LLKHF_INJECTED) == 0) handKeys++;
                else if ((uint)k.dwExtraInfo.ToInt64() != MARK) foreignKeys++;
            }
        }
        return CallNextHookEx(keyHook, code, wParam, lParam);
    }

    static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            int message = wParam.ToInt32();
            lock (gate)
            {
                if ((m.flags & LLMHF_INJECTED) == 0) { handMouse++; lastHandMouseMs = clock.ElapsedMilliseconds; }
                else if ((uint)m.dwExtraInfo.ToInt64() != MARK)
                {
                    if (message == WM_MOUSEMOVE) foreignMouseMoves++;
                    else if (message == 0x020A || message == 0x020E) foreignWheel++;
                    else foreignMouseButtons++;
                }
            }
        }
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    static void SendChar(char c)
    {
        INPUT[] inputs = new INPUT[2];
        for (int i = 0; i < 2; i++)
        {
            inputs[i].type = INPUT_KEYBOARD;
            inputs[i].u.ki.wScan = c;
            inputs[i].u.ki.dwFlags = KEYEVENTF_UNICODE | (i == 1 ? KEYEVENTF_KEYUP : 0);
            inputs[i].u.ki.dwExtraInfo = new IntPtr((long)MARK);
        }
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void TapAlt()
    {
        INPUT[] inputs = new INPUT[2];
        for (int i = 0; i < 2; i++)
        {
            inputs[i].type = INPUT_KEYBOARD;
            inputs[i].u.ki.wVk = 0x12;
            inputs[i].u.ki.dwFlags = i == 1 ? KEYEVENTF_KEYUP : 0;
            inputs[i].u.ki.dwExtraInfo = new IntPtr((long)MARK);
        }
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static string Describe(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return "(no window)";
        StringBuilder title = new StringBuilder(256);
        GetWindowText(hwnd, title, title.Capacity);
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string process = "?";
        try { process = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
        return process + ": " + title.ToString();
    }

    static string Json(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static int Distance(string a, string b)
    {
        int[] prev = new int[b.Length + 1], cur = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (int j = 1; j <= b.Length; j++)
                cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            int[] t = prev; prev = cur; cur = t;
        }
        return prev[b.Length];
    }

    static void Watch()
    {
        bool lost = false;
        long lostAt = 0;
        string lostTo = "";
        POINT last;
        GetCursorPos(out last);
        while (!stopping)
        {
            long now = clock.ElapsedMilliseconds;
            IntPtr front = GetForegroundWindow();
            if (front != formHandle && !lost) { lost = true; lostAt = now; lostTo = Describe(front); }
            else if (front == formHandle && lost)
            {
                long ms = now - lostAt;
                lock (gate) { losses.Add("{\"at_ms\":" + lostAt + ",\"ms\":" + ms + ",\"to\":" + Json(lostTo) + "}"); lostTotalMs += ms; longestLossMs = Math.Max(longestLossMs, ms); }
                lost = false;
            }
            POINT p;
            if (GetCursorPos(out p) && (p.X != last.X || p.Y != last.Y))
            {
                lock (gate)
                {
                    if (now - lastHandMouseMs > 100)
                    {
                        cursorMoves++;
                        double d = Math.Sqrt((double)(p.X - last.X) * (p.X - last.X) + (double)(p.Y - last.Y) * (p.Y - last.Y));
                        cursorPath += d;
                        if (d > 200) cursorJumps++;
                    }
                }
                last = p;
            }
            Thread.Sleep(4);
        }
        if (lost)
        {
            long ms = clock.ElapsedMilliseconds - lostAt;
            lock (gate) { losses.Add("{\"at_ms\":" + lostAt + ",\"ms\":" + ms + ",\"to\":" + Json(lostTo) + ",\"open_at_end\":true}"); lostTotalMs += ms; longestLossMs = Math.Max(longestLossMs, ms); }
        }
    }

    static void Type(string text, int intervalMs)
    {
        int i = 0;
        long next = clock.ElapsedMilliseconds;
        while (!stopping)
        {
            next += intervalMs;
            long wait = next - clock.ElapsedMilliseconds;
            if (wait > 0) Thread.Sleep((int)wait);
            if (stopping) break;
            if (GetForegroundWindow() == formHandle)
            {
                char c = text[i % text.Length];
                lock (gate) sent.Append(c);
                SendChar(c);
                i++;
            }
            else lock (gate) heldBack++;
        }
    }

    /// Shows the note, takes the foreground, writes readyFile, types until stopFile appears or seconds pass,
    /// then writes the summary to outFile. Returns 0, or 2 when the note could not take the foreground.
    public static int Run(string outFile, string readyFile, string stopFile, int seconds, int intervalMs, string text, string title)
    {
        Application.EnableVisualStyles();
        form = new Form();
        form.Text = title;
        form.Width = 620; form.Height = 360;
        form.StartPosition = FormStartPosition.Manual;
        form.Left = 40; form.Top = 40;
        form.TopMost = false;
        note = new TextBox();
        note.Multiline = true; note.Dock = DockStyle.Fill; note.WordWrap = true;
        bool typing = intervalMs > 0;
        if (typing) note.ImeMode = ImeMode.Disable;
        note.Font = new System.Drawing.Font("Consolas", 12f);
        form.Controls.Add(note);
        int exitCode = 0;
        string startedAt = DateTime.Now.ToString("o");

        form.Shown += delegate
        {
            formHandle = form.Handle;
            ShowWindow(formHandle, 5);
            keyProc = OnKey; mouseProc = OnMouse;
            IntPtr module = GetModuleHandle(null);
            keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, module, 0);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
            clock.Start();
            Thread starter = new Thread(delegate ()
            {
                for (int attempt = 0; attempt < 60 && GetForegroundWindow() != formHandle; attempt++)
                {
                    TapAlt();
                    form.BeginInvoke((MethodInvoker)delegate { SetForegroundWindow(formHandle); form.Activate(); note.Focus(); });
                    Thread.Sleep(100);
                }
                if (GetForegroundWindow() != formHandle) { exitCode = 2; form.BeginInvoke((MethodInvoker)delegate { form.Close(); }); return; }
                lock (gate) { handKeys = 0; handMouse = 0; foreignKeys = 0; foreignMouseMoves = 0; foreignMouseButtons = 0; foreignWheel = 0; }
                long readyAt = clock.ElapsedMilliseconds;
                File.WriteAllText(readyFile, readyAt.ToString());
                Thread watcher = new Thread(Watch); watcher.IsBackground = true; watcher.Start();
                Thread typer = new Thread(delegate () { if (typing) Type(text, intervalMs); }); typer.IsBackground = true; typer.Start();
                long deadline = readyAt + seconds * 1000L;
                while (clock.ElapsedMilliseconds < deadline && !File.Exists(stopFile)) Thread.Sleep(50);
                stopping = true;
                typer.Join(); watcher.Join();
                Thread.Sleep(400);
                string got = "";
                form.Invoke((MethodInvoker)delegate { got = note.Text; });
                string typed; lock (gate) typed = sent.ToString();
                int distance = typing ? Distance(typed, got) : 0;
                StringBuilder o = new StringBuilder("{");
                lock (gate)
                {
                    o.Append("\"started\":").Append(Json(startedAt));
                    o.Append(",\"typing_ms\":").Append(clock.ElapsedMilliseconds - readyAt);
                    o.Append(",\"interval_ms\":").Append(intervalMs);
                    o.Append(",\"chars_sent\":").Append(typed.Length);
                    o.Append(",\"chars_in_note\":").Append(got.Length);
                    if (!typing) o.Append(",\"typed_by_hand\":true");
                    o.Append(",\"note_matches\":").Append(!typing || got == typed ? "true" : "false");
                    o.Append(",\"note_edit_distance\":").Append(distance);
                    o.Append(",\"chars_held_back\":").Append(heldBack);
                    o.Append(",\"focus_losses\":").Append(losses.Count);
                    o.Append(",\"focus_lost_ms\":").Append(lostTotalMs);
                    o.Append(",\"longest_loss_ms\":").Append(longestLossMs);
                    o.Append(",\"cursor_moves_not_by_hand\":").Append(cursorMoves);
                    o.Append(",\"cursor_jumps_over_200px\":").Append(cursorJumps);
                    o.Append(",\"cursor_path_px\":").Append((int)cursorPath);
                    o.Append(",\"foreign_keys\":").Append(foreignKeys);
                    o.Append(",\"foreign_mouse_moves\":").Append(foreignMouseMoves);
                    o.Append(",\"foreign_mouse_buttons\":").Append(foreignMouseButtons);
                    o.Append(",\"foreign_wheel\":").Append(foreignWheel);
                    o.Append(",\"hand_keys\":").Append(handKeys);
                    o.Append(",\"hand_mouse\":").Append(handMouse);
                    o.Append(",\"losses\":[").Append(string.Join(",", losses.ToArray())).Append("]");
                    if (typing && got != typed) o.Append(",\"note_tail\":").Append(Json(got.Length > 120 ? got.Substring(got.Length - 120) : got));
                }
                o.Append("}");
                File.WriteAllText(outFile, o.ToString(), new UTF8Encoding(false));
                form.BeginInvoke((MethodInvoker)delegate { form.Close(); });
            });
            starter.IsBackground = true;
            starter.Start();
        };
        form.FormClosed += delegate
        {
            if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        };
        Application.Run(form);
        return exitCode;
    }
}
