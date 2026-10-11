// Test-only WebView2 host standing in for the PC launcher.
// Loads a page that includes overlay-bridge.js and checks, with the same WebView2 APIs the
// launcher uses (WebMessageReceived, PostWebMessageAsJson/AsString, WindowCloseRequested),
// that OverlayBridge passes messages through unchanged and that closing reaches the host.
//
// Usage: WebView2Host.exe <page url> <result json path>
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: WebView2Host <url> <result.json>");
            return 2;
        }
        ApplicationConfiguration.Initialize();
        var form = new HostForm(args[0], args[1]);
        Application.Run(form);
        return form.AllPassed ? 0 : 1;
    }
}

internal sealed class HostForm : Form
{
    private readonly string _url;
    private readonly string _resultPath;
    private readonly WebView2 _view = new() { Dock = DockStyle.Fill };
    private readonly List<string> _received = new();          // WebMessageAsJson, in arrival order
    private readonly List<object> _steps = new();
    private TaskCompletionSource _closeRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public bool AllPassed { get; private set; }

    public HostForm(string url, string resultPath)
    {
        _url = url;
        _resultPath = resultPath;
        Text = "overlay-bridge WebView2 test host";
        // Keep the test out of the user's way
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-3000, -3000);
        Size = new Size(800, 600);
        ShowInTaskbar = false;
        Controls.Add(_view);
        Load += async (_, _) => await RunAsync();
    }

    private void Step(string name, bool pass, string detail)
    {
        _steps.Add(new { name, pass, detail });
    }

    private async Task<string> Eval(string script) => await _view.ExecuteScriptAsync(script);

    // Waits until a message satisfying `match` has arrived from the page
    private async Task<JsonNode?> WaitForMessage(Func<JsonNode?, bool> match, int timeoutMs = 5000)
    {
        var end = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < end)
        {
            foreach (var raw in _received.ToArray())
            {
                var node = JsonNode.Parse(raw);
                if (match(node)) return node;
            }
            await Task.Delay(50);
        }
        return null;
    }

    private async Task RunAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetTempPath(), "overlay-bridge-wv2-test"));
            await _view.EnsureCoreWebView2Async(env);
            var core = _view.CoreWebView2;
            Step("webview2 runtime", true, env.BrowserVersionString);

            core.WebMessageReceived += (_, e) => _received.Add(e.WebMessageAsJson);
            core.WindowCloseRequested += (_, _) => _closeRequested.TrySetResult();

            var navigated = new TaskCompletionSource<bool>();
            core.NavigationCompleted += (_, e) => navigated.TrySetResult(e.IsSuccess);
            core.Navigate(_url);
            Step("page loaded", await navigated.Task, _url);

            // 1. environment detection
            var envName = await Eval("OverlayBridge.getEnvironment()");
            Step("getEnvironment() == webview2", envName == "\"webview2\"", envName);
            var popupId = await Eval("OverlayBridge.getPopupId()");
            Step("getPopupId() == null (Steam only)", popupId == "null", popupId);
            var available = await Eval("OverlayBridge.isAvailable()");
            Step("isAvailable() == true", available == "true", available);

            // 2. web -> native through OverlayBridge: the host receives exactly what the page sent
            await Eval("OverlayBridge.postMessage({cmd:'hello', n:1, text:'한글', nested:{list:[1,2,3]}})");
            var hello = await WaitForMessage(m => m?["cmd"]?.GetValue<string>() == "hello");
            var expected = JsonNode.Parse("{\"cmd\":\"hello\",\"n\":1,\"text\":\"한글\",\"nested\":{\"list\":[1,2,3]}}");
            Step("web -> native via OverlayBridge.postMessage (unchanged)",
                hello != null && JsonNode.DeepEquals(hello, expected), hello?.ToJsonString() ?? "not received");

            // 3. existing direct calls keep working side by side
            await Eval("chrome.webview.postMessage({cmd:'legacy'})");
            var legacy = await WaitForMessage(m => m?["cmd"]?.GetValue<string>() == "legacy");
            Step("legacy chrome.webview.postMessage still works", legacy != null, legacy?.ToJsonString() ?? "not received");

            // 4. native -> web (JSON): the page's OverlayBridge listener gets it and replies with pong
            core.PostWebMessageAsJson("{\"cmd\":\"ping\",\"n\":2,\"text\":\"네이티브\"}");
            var pong = await WaitForMessage(m => m?["cmd"]?.GetValue<string>() == "pong");
            Step("native -> web via PostWebMessageAsJson, page replies",
                pong?["echo"]?["n"]?.GetValue<int>() == 2 && pong?["echo"]?["text"]?.GetValue<string>() == "네이티브",
                pong?.ToJsonString() ?? "no pong");

            // 5. native -> web (string): delivered as the original WebView2 event (e.data is the string)
            core.PostWebMessageAsString("plain text");
            await Task.Delay(300);
            var log = await Eval("JSON.stringify(window.__bridgeLog)");
            var logArray = JsonNode.Parse(JsonNode.Parse(log)!.GetValue<string>())!.AsArray();
            Step("native -> web via PostWebMessageAsString (e.data unchanged)",
                logArray.Any(x => x?.GetValueKind() == JsonValueKind.String && x.GetValue<string>() == "plain text"), log);

            // 6. JSON-only rule: non-serializable data is refused before reaching the host
            var before = _received.Count;
            await Eval("(function(){var o={};o.self=o;OverlayBridge.postMessage(o).then(function(r){window.__cyc=r;});})()");
            await Task.Delay(200);
            var cyc = await Eval("window.__cyc");
            Step("circular data is refused (resolves false, nothing sent)", cyc == "false" && _received.Count == before, $"result={cyc}");

            // 7. closing: OverlayBridge.closePopup() -> window.close() -> host's WindowCloseRequested
            _closeRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await Eval("setTimeout(function(){ OverlayBridge.closePopup('done'); }, 0)");
            var closed1 = await Task.WhenAny(_closeRequested.Task, Task.Delay(3000)) == _closeRequested.Task;
            Step("OverlayBridge.closePopup() raises WindowCloseRequested", closed1, closed1 ? "raised" : "not raised");

            _closeRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await Eval("setTimeout(function(){ window.close(); }, 0)");
            var closed2 = await Task.WhenAny(_closeRequested.Task, Task.Delay(3000)) == _closeRequested.Task;
            Step("window.close() raises WindowCloseRequested", closed2, closed2 ? "raised" : "not raised");
        }
        catch (Exception ex)
        {
            Step("exception", false, ex.ToString());
        }

        AllPassed = _steps.Count > 0 && _steps.All(s => (bool)s.GetType().GetProperty("pass")!.GetValue(s)!);
        File.WriteAllText(_resultPath, JsonSerializer.Serialize(new { allPassed = AllPassed, steps = _steps },
            new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        Close();
    }
}
