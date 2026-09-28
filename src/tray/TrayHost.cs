// Tray icon + log window for wisprcheap. Compiled at runtime by tray.ps1 (Windows PowerShell 5.1, C# 5).
//
// Protocol, one UTF-8 line per message:
//   stdin  (from Node): "state <idle|recording|processing|paused>\t<text>", "log <line>",
//                       "last <0|1>", "paused <0|1>", "show-log", "exit"
//   stdout (to Node):   "ready", "copy-last", "toggle-pause", "open-config", "restart", "quit"
// When stdin closes (Node died), the tray exits.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class WisprTray
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    const int MaxLines = 3000;

    static NotifyIcon notifyIcon;
    static ToolStripMenuItem statusItem, logItem, copyItem, pauseItem;
    static Form logForm;
    static TextBox logBox;
    static readonly List<string> lines = new List<string>();
    static readonly Dictionary<string, Icon> icons = new Dictionary<string, Icon>();
    static string iconDir;
    static string statusText = "Starting";
    static Control invoker;
    static StreamWriter output;
    static readonly object sendLock = new object();
    static bool exiting;

    public static void Run(string dir)
    {
        iconDir = dir;
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();

        UTF8Encoding utf8 = new UTF8Encoding(false);
        output = new StreamWriter(Console.OpenStandardOutput(), utf8);
        output.AutoFlush = true;
        StreamReader input = new StreamReader(Console.OpenStandardInput(), utf8);

        foreach (string name in new string[] { "idle", "recording", "processing", "paused" })
        {
            icons[name] = new Icon(Path.Combine(iconDir, name + ".ico"), SystemInformation.SmallIconSize);
        }

        invoker = new Control();
        invoker.CreateControl();
        IntPtr handle = invoker.Handle; // force handle creation so BeginInvoke works from the reader thread

        ContextMenuStrip menu = new ContextMenuStrip();
        statusItem = new ToolStripMenuItem("wisprcheap");
        statusItem.Enabled = false;
        logItem = new ToolStripMenuItem("Show log", null, delegate { ToggleLog(); });
        logItem.Font = new Font(logItem.Font, FontStyle.Bold);
        copyItem = new ToolStripMenuItem("Copy last dictation", null, delegate { Send("copy-last"); });
        copyItem.Enabled = false;
        pauseItem = new ToolStripMenuItem("Pause dictation", null, delegate { Send("toggle-pause"); });
        ToolStripMenuItem configItem = new ToolStripMenuItem("Open config.yaml", null, delegate { Send("open-config"); });
        ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart (reload config)", null, delegate { Send("restart"); });
        ToolStripMenuItem quitItem = new ToolStripMenuItem("Quit", null, delegate { Send("quit"); });
        menu.Items.AddRange(new ToolStripItem[] {
            statusItem, new ToolStripSeparator(),
            logItem, copyItem, pauseItem, new ToolStripSeparator(),
            configItem, restartItem, new ToolStripSeparator(),
            quitItem
        });
        menu.Opening += delegate { logItem.Text = LogVisible() ? "Hide log" : "Show log"; };

        notifyIcon = new NotifyIcon();
        notifyIcon.Icon = icons["idle"];
        notifyIcon.Text = "wisprcheap";
        notifyIcon.ContextMenuStrip = menu;
        notifyIcon.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) ToggleLog();
        };
        notifyIcon.Visible = true;

        Thread reader = new Thread(delegate() { ReadLoop(input); });
        reader.IsBackground = true;
        reader.Start();

        Send("ready");
        Application.Run();

        notifyIcon.Visible = false;
        notifyIcon.Dispose();
    }

    static void ReadLoop(StreamReader input)
    {
        try
        {
            string line;
            while ((line = input.ReadLine()) != null)
            {
                string captured = line;
                invoker.BeginInvoke((MethodInvoker)delegate { Handle(captured); });
            }
        }
        catch { }
        try { invoker.BeginInvoke((MethodInvoker)delegate { Exit(); }); } catch { }
    }

    static void Send(string message)
    {
        lock (sendLock)
        {
            try { output.WriteLine(message); } catch { }
        }
    }

    static void Handle(string line)
    {
        int space = line.IndexOf(' ');
        string command = space < 0 ? line : line.Substring(0, space);
        string arg = space < 0 ? "" : line.Substring(space + 1);
        switch (command)
        {
            case "state": SetState(arg); break;
            case "log": AppendLog(arg); break;
            case "last": copyItem.Enabled = arg == "1"; break;
            case "paused": pauseItem.Checked = arg == "1"; break;
            case "show-log": ShowLog(); break;
            case "exit": Exit(); break;
        }
    }

    static void SetState(string arg)
    {
        int tab = arg.IndexOf('\t');
        string name = tab < 0 ? arg : arg.Substring(0, tab);
        statusText = tab < 0 ? "" : arg.Substring(tab + 1);
        Icon icon;
        if (icons.TryGetValue(name, out icon)) notifyIcon.Icon = icon;
        string tip = statusText.Length == 0 ? "wisprcheap" : "wisprcheap: " + statusText;
        notifyIcon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
        statusItem.Text = tip;
        if (logForm != null) logForm.Text = "wisprcheap log - " + statusText;
    }

    static void AppendLog(string line)
    {
        lines.Add(line);
        if (lines.Count > MaxLines) lines.RemoveRange(0, lines.Count - MaxLines);
        if (logBox == null) return;
        if (logBox.TextLength > 2000000)
        {
            logBox.Text = string.Join("\r\n", lines.ToArray()) + "\r\n";
            ScrollToEnd();
        }
        else
        {
            logBox.AppendText(line + "\r\n");
        }
    }

    static bool LogVisible()
    {
        return logForm != null && logForm.Visible;
    }

    static void ToggleLog()
    {
        if (LogVisible()) logForm.Hide();
        else ShowLog();
    }

    static void ScrollToEnd()
    {
        logBox.SelectionStart = logBox.TextLength;
        logBox.SelectionLength = 0;
        logBox.ScrollToCaret();
    }

    static void ShowLog()
    {
        if (logForm == null)
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            logForm = new Form();
            logForm.Text = "wisprcheap log - " + statusText;
            logForm.Icon = new Icon(Path.Combine(iconDir, "idle.ico"));
            logForm.Size = new Size(area.Width * 55 / 100, area.Height * 55 / 100);
            logForm.StartPosition = FormStartPosition.CenterScreen;

            logBox = new TextBox();
            logBox.Multiline = true;
            logBox.ReadOnly = true;
            logBox.MaxLength = 0;
            logBox.WordWrap = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.Dock = DockStyle.Fill;
            logBox.BorderStyle = BorderStyle.None;
            logBox.Font = new Font("Consolas", 10f);
            logBox.BackColor = Color.FromArgb(24, 24, 27);
            logBox.ForeColor = Color.FromArgb(228, 228, 231);
            logBox.Text = lines.Count > 0 ? string.Join("\r\n", lines.ToArray()) + "\r\n" : "";
            logBox.KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) logForm.Hide();
            };
            logForm.Controls.Add(logBox);

            // Closing the window only hides it; the app keeps running.
            logForm.FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!exiting && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    logForm.Hide();
                }
            };
        }
        logForm.Show();
        if (logForm.WindowState == FormWindowState.Minimized) logForm.WindowState = FormWindowState.Normal;
        logForm.Activate();
        ScrollToEnd();
    }

    static void Exit()
    {
        if (exiting) return;
        exiting = true;
        notifyIcon.Visible = false;
        if (logForm != null) logForm.Close();
        Application.ExitThread();
    }
}
