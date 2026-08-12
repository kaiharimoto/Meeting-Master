// Meeting Master — home-server dashboard logic.
// Talks only to the loopback-only /setup/* API:
//   GET  /setup/state          config + deps + install-task state (polled)
//   POST /setup/save           email/model settings -> connection code
//   POST /setup/install/{c}    guided installs
//   GET  /setup/jobs           trimmed job list (fallback/initial)
//   GET  /setup/logs           log ring tail
//   GET  /setup/events         SSE: hello/job/log (live updates)
(function () {
  "use strict";
  // Inside the Meeting Master app's Dashboard tab (iframe): the meeting UI is
  // one sidebar click away, so the "open notes" link is redundant here. The
  // UPDATE link is not — the app intercepts it, so framed is where it works.
  if (window.self !== window.top) document.documentElement.classList.add("framed");
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var pollTimer = null;
  var lastState = null;
  // "edited" flags so a background poll never overwrites a field the operator
  // has started filling in (the Gmail field losing its text was exactly this).
  var editedTemplate = false, editedRecipients = false, editedUser = false,
      editedFrom = false, editedOllama = false, editedWhisper = false;
  // AI engine tuning fields share one edited-flag map + numeric parsing.
  var AI_FIELDS = ["aiProvider", "claudeCliPath", "claudeModel", "claudeCliTimeoutSec",
                   "ollamaUrl", "numCtx", "summaryNumPredict",
                   "summaryTemperature", "extractNumPredict", "extractTemperature"];
  // Live-suggestion fields work the same way, off state.liveParams. The
  // checkbox is listed separately because it round-trips .checked, not .value.
  var LIVE_FIELDS = ["liveModel", "liveIntervalSec", "liveWindowChars",
                     "liveTimeoutSec", "liveKeepAliveMin", "liveExtractNumPredict"];
  var editedAi = {};
  var fitLoaded = false; // "Fit to your GPU" is measured on first Settings open

  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 1600);
  }

  // True when version string a is strictly newer than b (semver-ish x.y.z).
  function semverNewer(a, b) {
    var pv = function (s) {
      var m = /(\d+)\.(\d+)\.(\d+)/.exec(s || "");
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    var va = pv(a), vb = pv(b);
    if (!va || !vb) return false;
    for (var i = 0; i < 3; i++) {
      if (va[i] !== vb[i]) return va[i] > vb[i];
    }
    return false;
  }

  // ---- Theme ---------------------------------------------------------------
  function applyTheme(pref) {
    var dark = pref === "dark" ||
      (pref !== "light" && window.matchMedia &&
       window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }
  $("#theme-toggle").addEventListener("click", function () {
    var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("mmserver.theme.v1", next); } catch (e) {}
    applyTheme(next);
  });

  // ---- Tabs ----------------------------------------------------------------
  var TABS = ["overview", "jobs", "logs", "settings"];
  function showTab(name) {
    if (TABS.indexOf(name) === -1) name = "overview";
    TABS.forEach(function (t) {
      $("#tab-" + t).hidden = t !== name;
    });
    $$(".tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", on);
      // Roving tabindex + aria-selected: the tablist is ONE tab stop and
      // arrows move within it, which is what role="tablist" promises.
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    try { if (location.hash !== "#" + name) location.hash = "#" + name; } catch (e) {}
    if (name === "logs") scrollLogToEnd();
    // Measuring models means an /api/show per installed model, so do it when
    // the operator actually opens Settings — once, not on every poll.
    if (name === "settings" && !fitLoaded) { fitLoaded = true; loadFit(); }
  }
  $$(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    b.addEventListener("keydown", function (e) {
      var tabs = $$(".tab");
      var i = tabs.indexOf(b);
      var next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      showTab(next.getAttribute("data-tab"));
      next.focus();
    });
  });
  $("#banner-settings-link").addEventListener("click", function (e) {
    e.preventDefault();
    showTab("settings");
  });

  // ---- Setup/state rendering (config, deps, tasks) -------------------------
  function setBadge(depId, ok) {
    var b = $("[data-badge]", $("#" + depId));
    if (!b) return;
    b.classList.toggle("ok", !!ok);
    b.textContent = ok ? "✓" : "·";
  }

  function setStatus(key, ok, text) {
    var el = $('[data-st="' + key + '"]');
    if (!el) return;
    el.textContent = text || (ok ? "installed" : "not detected");
    el.style.color = ok ? "var(--success)" : "var(--ink-faint)";
  }

  function renderTask(name, task) {
    var bar = $('[data-bar="' + name + '"]');
    var msg = $('[data-msg="' + name + '"]');
    task = task || { state: "idle", progress: null, message: "" };
    if (bar) {
      var running = task.state === "running";
      bar.classList.toggle("show", running || task.state === "failed");
      var pct = typeof task.progress === "number" ? task.progress : (running ? 8 : 0);
      $("i", bar).style.width = Math.max(0, Math.min(100, pct)) + "%";
      $("i", bar).style.background = task.state === "failed" ? "var(--danger)" : "var(--accent)";
    }
    if (msg) {
      msg.textContent = task.message || "";
      msg.classList.toggle("err", task.state === "failed");
      linkify(msg);
    }
    var btn = $('[data-install="' + name + '"]');
    if (btn) btn.disabled = task.state === "running";
  }

  function linkify(el) {
    // DOM-built (never innerHTML): task messages embed tool output, and an
    // unescaped sink here would be a needless risk even on a loopback page.
    var txt = el.textContent;
    var m = txt.match(/https?:\/\/[^\s]+/);
    if (!m) return;
    var url = m[0];
    var at = txt.indexOf(url);
    el.textContent = "";
    el.appendChild(document.createTextNode(txt.slice(0, at)));
    var a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = url;
    el.appendChild(a);
    el.appendChild(document.createTextNode(txt.slice(at + url.length)));
  }

  function anyRunning(tasks) {
    return Object.keys(tasks || {}).some(function (k) { return tasks[k].state === "running"; });
  }

  function renderOverview(state) {
    var d = state.deps || {};
    var o = d.ollama || {}, ts = d.tailscale || {}, w = d.whisperModel || {};

    var server = $("#ov-server");
    server.textContent = state.configured ? "Online · configured" : "Online · needs setup";
    server.className = "stat-value " + (state.configured ? "ok" : "warn");
    $("#ov-server-sub").textContent = "version " + (serverVersion || "—");

    var ollama = $("#ov-ollama");
    var ollamaOk = o.installed && o.modelPresent;
    ollama.textContent = ollamaOk ? "Ready" : o.installed ? "Model missing" : "Not installed";
    ollama.className = "stat-value " + (ollamaOk ? "ok" : "warn");
    $("#ov-ollama-sub").textContent = o.model || "";

    var whisper = $("#ov-whisper");
    whisper.textContent = w.present ? "Ready" : "Model missing";
    whisper.className = "stat-value " + (w.present ? "ok" : "warn");
    $("#ov-whisper-sub").textContent = w.name || "";

    var tail = $("#ov-tailscale");
    var tsOk = ts.installed && ts.loggedIn && !!ts.serveUrl;
    tail.textContent = tsOk ? "Connected" : ts.installed ? "Needs sign-in" : "Not installed";
    tail.className = "stat-value " + (tsOk ? "ok" : "warn");
    $("#ov-tailscale-sub").textContent = ts.serveUrl || "";
  }

  function render(state) {
    lastState = state;

    // Email + models (don't stomp fields the user is editing).
    if (!editedUser && document.activeElement !== $("#smtpUser")) $("#smtpUser").value = state.email.user || "";
    if (!editedFrom && document.activeElement !== $("#smtpFrom")) $("#smtpFrom").value = state.email.from || "";
    if ($("#smtpPass").placeholder && state.email.hasPassword)
      $("#smtpPass").placeholder = "•••••••• (saved — leave blank to keep)";
    if (!editedRecipients) $("#recipients").value = (state.recipients || []).join("\n");
    if (!editedTemplate) $("#template").value = state.emailTemplate || "";
    if (!editedOllama && document.activeElement !== $("#ollamaModel")) $("#ollamaModel").value = state.ollamaModel || "";
    var ai = state.aiParams || {};
    AI_FIELDS.forEach(function (f) {
      var el = $("#" + f);
      if (el && !editedAi[f] && document.activeElement !== el)
        el.value = ai[f] != null ? ai[f] : "";
    });
    syncProviderFields(ai);
    var live = state.liveParams || {};
    LIVE_FIELDS.forEach(function (f) {
      var el = $("#" + f);
      if (el && !editedAi[f] && document.activeElement !== el)
        el.value = live[f] != null ? live[f] : "";
    });
    var liveOn = $("#liveSuggestions");
    if (liveOn && !editedAi.liveSuggestions)
      liveOn.checked = live.liveSuggestions !== false;
    if (!editedWhisper && document.activeElement !== $("#whisperModel")) $("#whisperModel").value = state.whisperModel || "";

    // Dependency detection.
    var d = state.deps || {};
    var o = d.ollama || {}, ts = d.tailscale || {}, w = d.whisperModel || {};
    $("[data-model-name]").textContent = o.model ? "(" + o.model + ")" : "";
    $("[data-whisper-name]").textContent = w.name ? "(" + w.name + ")" : "";
    setStatus("ollama", o.installed);
    setStatus("model", o.modelPresent, o.modelPresent ? "downloaded" : "not downloaded");
    setStatus("tailscale", ts.installed);
    setStatus("tsup", ts.loggedIn, ts.loggedIn ? "signed in" : "not signed in");
    setStatus("tsserve", !!ts.serveUrl, ts.serveUrl ? "on" : "off");
    setStatus("whisper", w.present, w.present ? "downloaded" : "not downloaded");
    setBadge("dep-ollama", o.installed && o.modelPresent);
    setBadge("dep-tailscale", ts.installed && ts.loggedIn && !!ts.serveUrl);
    setBadge("dep-whisper", w.present);

    // Tasks / progress bars.
    var tasks = state.tasks || {};
    ["ollama", "model", "whisper-model", "tailscale", "tailscale-up",
     "tailscale-serve", "update-check"]
      .forEach(function (n) { renderTask(n, tasks[n]); });

    // Updates card. Error first (a failed check must never read "up to date"),
    // then a real semver comparison — a string compare would call an OLDER
    // release an "update" after a rollback.
    var up = state.updates || {};
    $("#up-current").textContent = "v" + (up.current || "?");
    $("#up-latest-tag").textContent = up.tag ? "(" + up.tag + ")" : "";
    var status = $("#up-status");
    if (up.error) {
      status.textContent = "check failed";
      status.style.color = "var(--danger)";
      status.title = up.error;
    } else if (semverNewer(up.latest, up.current)) {
      status.textContent = "update available";
      status.style.color = "var(--warn-ink)";
      status.title = "";
    } else if (up.checkedAt) {
      status.textContent = "up to date";
      status.style.color = "var(--success)";
      status.title = "";
    } else {
      status.textContent = "not checked yet";
      status.style.color = "var(--ink-faint)";
      status.title = "";
    }
    // Two install paths, one per topology (see setup.html). Inside the app the
    // link is intercepted by Electron and installs the downloaded update now;
    // a server running on its own installs the cached installer itself.
    var hasUpdate = semverNewer(up.latest, up.current);
    var appRow = $("#up-app-update-row");
    if (appRow) appRow.hidden = !(up.sidecar && hasUpdate);
    var srvRow = $("#up-server-update-row");
    if (srvRow) srvRow.hidden = !(!up.sidecar && hasUpdate);
    var notesLink = $("#open-notes-link");
    if (notesLink) notesLink.hidden = !up.sidecar;
    var upNotes = [];
    if (up.sidecar)
      upNotes.push("This server runs inside the Meeting Master app — updates " +
                   "download in the background. Install one the moment it is " +
                   "ready with the button above, or just leave it: it also " +
                   "installs whenever the app next restarts.");
    if (up.laptopReady)
      upNotes.push("Update feed ready — operator laptops fetch updates from " +
                   "this server automatically.");
    $("#up-laptop-note").textContent = upNotes.join(" ");
    if (state.githubTokenSet)
      $("#githubToken").placeholder = "•••••••• (saved — leave blank to keep)";

    // Banners + connection code.
    $("#setup-banner").classList.toggle("show", !state.configured);
    if (state.configured && state.connectionCode) {
      $("#code").textContent = state.connectionCode;
      $("#server-url").textContent = "Server URL: " + (state.serverUrl || "");
      $("#code-card").classList.add("show");
    }

    renderOverview(state);
    schedulePoll(anyRunning(tasks));
  }

  function schedulePoll(fast) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, fast ? 1500 : 5000);
  }

  function refresh() {
    fetch("/setup/state").then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { schedulePoll(false); });
  }

  function install(component) {
    fetch("/setup/install/" + component, { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (res) { renderTask(component, res.task); schedulePoll(true); })
      .catch(function () { toast("Could not start install"); });
  }

  function save() {
    var btn = $("#save"); btn.disabled = true; $("#save-status").textContent = "Saving…";
    var body = {
      smtpUser: $("#smtpUser").value.trim(),
      smtpFrom: $("#smtpFrom").value.trim(),
      smtpAppPassword: $("#smtpPass").value,
      recipients: $("#recipients").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
      emailTemplate: $("#template").value,
      ollamaModel: $("#ollamaModel").value.trim() || null,
      ollamaUrl: $("#ollamaUrl").value.trim() || null,
      numCtx: parseInt($("#numCtx").value, 10) || null,
      summaryNumPredict: parseInt($("#summaryNumPredict").value, 10) || null,
      summaryTemperature: $("#summaryTemperature").value === "" ? null : parseFloat($("#summaryTemperature").value),
      extractNumPredict: parseInt($("#extractNumPredict").value, 10) || null,
      extractTemperature: $("#extractTemperature").value === "" ? null : parseFloat($("#extractTemperature").value),
      whisperModel: $("#whisperModel").value.trim() || null,
      githubToken: $("#githubToken").value,
      liveSuggestions: $("#liveSuggestions").checked,
      // Blank is meaningful (fall back to the summary model), so send "" —
      // never null, which would mean "leave whatever is saved".
      liveModel: $("#liveModel").value.trim(),
      liveIntervalSec: parseInt($("#liveIntervalSec").value, 10) || null,
      liveWindowChars: parseInt($("#liveWindowChars").value, 10) || null,
      liveTimeoutSec: parseInt($("#liveTimeoutSec").value, 10) || null,
      liveKeepAliveMin: $("#liveKeepAliveMin").value === "" ? null : parseInt($("#liveKeepAliveMin").value, 10),
      liveExtractNumPredict: parseInt($("#liveExtractNumPredict").value, 10) || null,
      aiProvider: $("#aiProvider").value,
      claudeCliPath: $("#claudeCliPath").value.trim(),
      claudeModel: $("#claudeModel").value.trim(),
      claudeCliTimeoutSec: parseInt($("#claudeCliTimeoutSec").value, 10) || null
    };
    fetch("/setup/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .then(function (state) {
        btn.disabled = false; $("#save-status").textContent = "Saved.";
        $("#smtpPass").value = "";
        $("#githubToken").value = "";
        editedTemplate = editedRecipients = editedUser = editedFrom = false;
        editedOllama = editedWhisper = false;
        editedAi = {};
        $("#saved-banner").classList.add("show");
        render(state);
        showTab("overview");
        $("#code-card").scrollIntoView({ behavior: "smooth" });
      })
      .catch(function () {
        btn.disabled = false; $("#save-status").textContent = "Save failed — try again.";
      });
  }

  // ---- Jobs (SSE-live with fetch fallback) ---------------------------------
  var jobs = [];

  function friendlyWhen(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return iso;
    var min = Math.round((Date.now() - then) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + "m ago";
    if (min < 1440) return Math.round(min / 60) + "h ago";
    return Math.round(min / 1440) + "d ago";
  }

  function renderJobs() {
    var host = $("#jobs-host");
    host.textContent = "";
    if (!jobs.length) {
      var empty = document.createElement("div");
      empty.className = "jobs-empty";
      empty.textContent = "No jobs yet — they appear here when the laptop uploads a meeting.";
      host.appendChild(empty);
      return;
    }
    jobs.slice(0, 50).forEach(function (job) {
      var row = document.createElement("div");
      row.className = "job-row";

      var title = document.createElement("span");
      title.className = "job-title";
      title.textContent = job.title || "(untitled meeting)";
      title.title = job.id || "";
      row.appendChild(title);

      var chip = document.createElement("span");
      chip.className = "state-chip";
      chip.setAttribute("data-state", job.state || "");
      chip.textContent = (job.state || "unknown").replace("_", " ");
      row.appendChild(chip);

      // Ready-but-AI-failed: make it visible here too, not just in the logs.
      if (job.summaryError || job.questionsError) {
        var warn = document.createElement("span");
        warn.className = "state-chip";
        warn.setAttribute("data-state", "failed");
        warn.title = job.summaryError || job.questionsError;
        warn.textContent = job.summaryError ? "summary failed" : "Q&A failed";
        row.appendChild(warn);
      }

      var when = document.createElement("span");
      when.className = "job-when";
      when.textContent = friendlyWhen(job.updatedAt);
      row.appendChild(when);

      // Once a transcript can exist, offer it + the external-AI prompt (the
      // escape hatch for meetings the local model can't summarize).
      var hasTranscript = ["ready", "pdf_received", "emailed", "summarizing", "failed"]
        .indexOf(job.state) !== -1;
      if (hasTranscript && job.id) {
        var tLink = document.createElement("a");
        tLink.className = "job-link";
        tLink.href = "/setup/jobs/" + encodeURIComponent(job.id) + "/transcript";
        tLink.textContent = "transcript";
        row.appendChild(tLink);

        var pLink = document.createElement("a");
        pLink.className = "job-link";
        pLink.href = "/setup/jobs/" + encodeURIComponent(job.id) + "/prompt";
        // Downloads now (the route sets Content-Disposition), so no _blank —
        // it would open and immediately abandon a blank tab.
        pLink.title = "Download the prompt for an external AI (paste its JSON reply back via Edit summary → Import)";
        pLink.textContent = "AI prompt";
        row.appendChild(pLink);
      }

      if (typeof job.progress === "number" && job.progress > 0 && job.state === "transcribing") {
        var barWrap = document.createElement("span");
        barWrap.className = "job-progress";
        var bar = document.createElement("i");
        bar.style.width = Math.max(0, Math.min(100, job.progress)) + "%";
        barWrap.appendChild(bar);
        row.appendChild(barWrap);
      }
      host.appendChild(row);
    });
  }

  function patchJob(trimmed) {
    if (!trimmed || !trimmed.id) return;
    var idx = -1;
    for (var i = 0; i < jobs.length; i++) if (jobs[i].id === trimmed.id) { idx = i; break; }
    if (idx >= 0) jobs[idx] = trimmed;
    else jobs.unshift(trimmed);
    renderJobs();
  }

  function loadJobs() {
    fetch("/setup/jobs").then(function (r) { return r.json(); })
      .then(function (payload) { jobs = payload.jobs || []; renderJobs(); })
      .catch(function () { renderJobs(); });
  }

  // ---- Logs ----------------------------------------------------------------
  var logLines = [];
  var LOG_CAP = 1000;

  function scrollLogToEnd() {
    var view = $("#log-view");
    if ($("#log-follow").checked) view.scrollTop = view.scrollHeight;
  }

  function renderLog() {
    var view = $("#log-view");
    view.textContent = "";
    (logLines.length ? logLines : ["(no log lines yet)"]).forEach(function (line) {
      var el = document.createElement("span");
      el.className = "log-line";
      el.textContent = line;
      view.appendChild(el);
    });
    scrollLogToEnd();
  }

  function loadLog() {
    fetch("/setup/logs?lines=300").then(function (r) { return r.json(); })
      .then(function (payload) { logLines = payload.lines || []; renderLog(); })
      .catch(function () { renderLog(); });
  }

  $("#log-refresh").addEventListener("click", loadLog);

  // ---- Live events (SSE) ---------------------------------------------------
  var serverVersion = null;

  function setConnPill(status, label) {
    var pill = $("#conn-pill");
    pill.setAttribute("data-status", status);
    $("#conn-pill-label").textContent = label;
  }

  function startEvents() {
    if (!window.EventSource) { setConnPill("warn", "Live updates unavailable"); return; }
    var es = new EventSource("/setup/events");
    es.addEventListener("open", function () { setConnPill("ok", "Live"); });
    es.addEventListener("error", function () { setConnPill("down", "Reconnecting…"); });
    es.addEventListener("hello", function (e) {
      try {
        var data = JSON.parse(e.data);
        serverVersion = data.version || serverVersion;
        $("#foot-version").textContent = serverVersion ? "Meeting Master Home Server v" + serverVersion : "";
        if (lastState) renderOverview(lastState);
        if (Array.isArray(data.jobs)) { jobs = data.jobs; renderJobs(); }
      } catch (err) { /* malformed hello — ignore */ }
    });
    es.addEventListener("job", function (e) {
      try { patchJob(JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener("log", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.line) {
          logLines.push(data.line);
          if (logLines.length > LOG_CAP) logLines = logLines.slice(-LOG_CAP);
          renderLog();
        }
      } catch (err) {}
    });
  }

  // ---- Wire events ---------------------------------------------------------
  $$("[data-install]").forEach(function (b) {
    b.addEventListener("click", function () { install(b.getAttribute("data-install")); });
  });
  $("#save").addEventListener("click", save);
  $("#template").addEventListener("input", function () { editedTemplate = true; });
  $("#recipients").addEventListener("input", function () { editedRecipients = true; });
  $("#smtpUser").addEventListener("input", function () { editedUser = true; });
  $("#smtpFrom").addEventListener("input", function () { editedFrom = true; });
  $("#ollamaModel").addEventListener("input", function () { editedOllama = true; });
  AI_FIELDS.concat(LIVE_FIELDS).forEach(function (f) {
    var el = $("#" + f);
    if (el) el.addEventListener("input", function () { editedAi[f] = true; });
  });
  var liveOnBox = $("#liveSuggestions");
  if (liveOnBox) liveOnBox.addEventListener("change", function () {
    editedAi.liveSuggestions = true;
  });
  var providerSel = $("#aiProvider");
  if (providerSel) providerSel.addEventListener("change", function () {
    editedAi.aiProvider = true;
    syncProviderFields(null); // reveal/hide immediately, before any save
  });

  // Claude's extra fields are noise while Ollama is selected, and the
  // found/not-found line is the difference between "not installed" and
  // "installed but not signed in" — a distinction the operator would
  // otherwise only discover when a real meeting fails.
  function syncProviderFields(ai) {
    var sel = $("#aiProvider"), fields = $("#claudeFields"), status = $("#claudeStatus");
    if (!sel || !fields) return;
    var isClaude = sel.value === "claude_cli";
    fields.hidden = !isClaude;
    if (!status || !ai) return;
    status.textContent = ai.claudeCliFound
      ? "Claude CLI found on this machine. If notes fail with a sign-in error, run `claude login` here."
      : "Claude CLI not found. Install it on this machine and run `claude login`, or set the path below.";
  }

  // ---- AI helpers: installed-model picker, suggested context, live test ----
  var ollamaModels = [];
  function loadOllamaModels() {
    fetch("/setup/ollama-models").then(function (r) { return r.json(); })
      .then(function (p) {
        ollamaModels = p.models || [];
        var dl = $("#ollama-model-list");
        if (!dl) return;
        dl.textContent = "";
        ollamaModels.forEach(function (m) {
          var o = document.createElement("option");
          o.value = m.name;
          o.label = m.paramSize ? (m.paramSize + ", " + m.sizeGB + " GB") : "";
          dl.appendChild(o);
        });
      }).catch(function () {});
  }
  loadOllamaModels();

  function aiResult(text, color) {
    var el = $("#ai-test-result");
    el.textContent = text;
    el.style.color = color || "var(--ink-soft)";
  }
  var testBtn = $("#ai-test");
  if (testBtn) testBtn.addEventListener("click", function () {
    aiResult("Testing — first load of a big model can take a minute…");
    testBtn.disabled = true;
    fetch("/setup/ai-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numCtx: parseInt($("#numCtx").value, 10) || null }),
    }).then(function (r) { return r.json(); })
      .then(function (p) {
        testBtn.disabled = false;
        if (p.ok) {
          aiResult("\u2713 " + p.model + " answered in " + (p.latencyMs / 1000).toFixed(1) +
                   "s with context " + p.numCtx + " — these settings work. Save to keep them.",
                   "var(--success)");
        } else {
          aiResult("\u2717 Failed with context " + p.numCtx + ": " + (p.error || "unknown error") +
                   " — try a lower context window or a smaller model, then test again.",
                   "var(--danger)");
        }
      })
      .catch(function () {
        testBtn.disabled = false;
        aiResult("Test request failed — is the server still running?", "var(--danger)");
      });
  });
  // ---- Live suggestions: prove the mid-meeting path end to end -------------
  // Runs the REAL live request over a fixed scripted conversation that contains
  // exactly one answered question and one genuine forward-looking lesson, so an
  // empty result is a finding rather than an ambiguity.
  function liveResult(text, color) {
    var el = $("#live-test-result");
    el.textContent = text;
    el.style.color = color || "var(--ink-soft)";
  }
  var liveTestBtn = $("#live-test");
  if (liveTestBtn) liveTestBtn.addEventListener("click", function () {
    liveResult("Asking the model for live suggestions — a cold model load can take a minute…");
    liveTestBtn.disabled = true;
    fetch("/setup/live-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        liveModel: $("#liveModel").value.trim(),
        liveTimeoutSec: parseInt($("#liveTimeoutSec").value, 10) || null,
        liveExtractNumPredict: parseInt($("#liveExtractNumPredict").value, 10) || null,
      }),
    }).then(function (r) { return r.json(); })
      .then(function (p) {
        liveTestBtn.disabled = false;
        var secs = (p.latencyMs / 1000).toFixed(1);
        if (!p.ok) {
          liveResult("✗ " + p.model + " failed after " + secs + "s: " +
                     (p.error || "unknown error") +
                     " — try a smaller live model, or raise the give-up time.",
                     "var(--danger)");
          return;
        }
        var nq = (p.questions || []).length, ni = (p.insights || []).length;
        var found = nq + " question" + (nq === 1 ? "" : "s") + " and " +
                    ni + " insight" + (ni === 1 ? "" : "s");
        if (nq === 0 && ni === 0) {
          // The model answered, but found nothing in a sample that contains
          // both — a real result, and a real problem worth naming.
          liveResult("⚠ " + p.model + " answered in " + secs + "s but found " +
                     "nothing in the sample conversation, which does contain a " +
                     "question and a lesson. This model is a poor fit for live " +
                     "suggestions — try a different one.", "var(--danger)");
          return;
        }
        var msg = "✓ " + p.model + " found " + found + " in " + secs + "s.";
        if (p.slowerThanInterval) {
          msg += " That is SLOWER than the " + p.intervalSec + "s interval, so " +
                 "asks would pile up — raise the interval or use a smaller live " +
                 "model.";
          liveResult(msg, "var(--warn-ink)");
          return;
        }
        if (!p.enabled) {
          liveResult(msg + " Live suggestions are currently switched OFF — tick " +
                     "the box above and Save to use them.", "var(--warn-ink)");
          return;
        }
        liveResult(msg + " Save to keep these settings.", "var(--success)");
      })
      .catch(function () {
        liveTestBtn.disabled = false;
        liveResult("Test request failed — is the server still running?", "var(--danger)");
      });
  });


  // ---- Fit to your GPU -----------------------------------------------------
  // The old "Suggest settings" guessed a context window from the parameter
  // count, which is the wrong variable (see setup/modelfit.py). This asks the
  // server to do the real arithmetic per installed model and lets the operator
  // apply the answer with one click.
  var VERDICT_STYLE = {
    comfortable: { label: "fits comfortably", color: "var(--success)" },
    tight: { label: "fits, tight", color: "var(--warn-ink)" },
    "too big": { label: "will not fit", color: "var(--danger)" },
    unknown: { label: "unknown", color: "var(--ink-faint)" },
  };

  function fitStatus(text, color) {
    var el = $("#fit-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = color || "var(--ink-soft)";
  }

  function renderFitRows(data) {
    var host = $("#fit-table");
    if (!host) return;
    host.textContent = "";
    var models = data.models || [];
    if (models.length === 0) {
      fitStatus(data.error || "Ollama reported no installed models.", "var(--danger)");
      return;
    }
    models.forEach(function (m) {
      var style = VERDICT_STYLE[m.verdict] || VERDICT_STYLE.unknown;
      var row = document.createElement("div");
      row.className = "fit-row";
      if (m.name === data.currentModel) row.classList.add("is-current");

      var head = document.createElement("div");
      head.className = "fit-head";
      var name = document.createElement("span");
      name.className = "fit-name";
      name.textContent = m.name + (m.name === data.currentModel ? "  (in use)" : "");
      var verdict = document.createElement("span");
      verdict.className = "fit-verdict";
      verdict.textContent = style.label;
      verdict.style.color = style.color;
      head.appendChild(name);
      head.appendChild(verdict);
      row.appendChild(head);

      var facts = document.createElement("div");
      facts.className = "fit-facts";
      var bits = [];
      if (m.paramSize) bits.push(m.paramSize);
      if (m.quantization) bits.push(m.quantization);
      bits.push(m.weightsGB + " GB weights");
      if (m.kvMBPer1k != null) bits.push(m.kvMBPer1k + " MB per 1k ctx");
      if (m.maxCtx) bits.push("fits " + m.maxCtx.toLocaleString() + " ctx");
      if (m.trainedCtx) bits.push("trained to " + m.trainedCtx.toLocaleString());
      facts.textContent = bits.join(" · ");
      row.appendChild(facts);

      if (m.note) {
        var note = document.createElement("div");
        note.className = "fit-note";
        note.textContent = m.note;
        row.appendChild(note);
      }

      if (m.recommendedCtx) {
        var actions = document.createElement("div");
        actions.className = "fit-actions";
        var use = document.createElement("button");
        use.type = "button";
        use.className = "ghost small";
        use.textContent = "Use this model at " + m.recommendedCtx.toLocaleString();
        use.title = "Fills in the summary model and context window above — review, then Save.";
        use.addEventListener("click", function () {
          $("#ollamaModel").value = m.name;
          $("#numCtx").value = m.recommendedCtx;
          editedOllama = true;
          editedAi.numCtx = true;
          toast("Filled in — press Save to keep it");
          $("#ollamaModel").scrollIntoView({ behavior: "smooth", block: "center" });
        });
        var live = document.createElement("button");
        live.type = "button";
        live.className = "ghost small";
        live.textContent = "Use for live suggestions";
        live.title = "Sets this as the mid-meeting live model (a smaller one answers inside a meeting).";
        live.addEventListener("click", function () {
          $("#liveModel").value = m.name;
          editedAi.liveModel = true;
          toast("Set as the live model — press Save to keep it");
        });
        actions.appendChild(use);
        actions.appendChild(live);
        row.appendChild(actions);
      }
      host.appendChild(row);
    });
  }

  function renderFitLoaded(loaded) {
    var el = $("#fit-loaded");
    if (!el) return;
    if (!loaded || loaded.length === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    // The estimates above predict; this is what Ollama actually did. A model
    // running partly on the CPU is the real cause of "the AI is so slow".
    var spilled = loaded.filter(function (m) { return !m.fullyOnGpu; });
    var parts = loaded.map(function (m) {
      return m.name + ": " + m.vramGB + " of " + m.sizeGB + " GB on the GPU" +
        (m.onGpuPercent != null ? " (" + m.onGpuPercent + "%)" : "") +
        (m.contextLength ? ", context " + m.contextLength.toLocaleString() : "");
    });
    el.textContent = "Loaded right now — " + parts.join("; ") +
      (spilled.length
        ? ". Part of that is on the CPU, which is many times slower: lower the " +
          "context window, or use a model from the list below."
        : ".");
    el.classList.toggle("err", spilled.length > 0);
  }

  function loadFit() {
    var vram = parseFloat($("#fit-vram").value) || 24;
    var kv = $("#fit-kv").value;
    fitStatus("Reading your installed models…");
    fetch("/setup/model-fit?vramGB=" + encodeURIComponent(vram) +
          "&kvCache=" + encodeURIComponent(kv))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) fitStatus(data.error, "var(--danger)");
        else fitStatus(data.models.length + " installed model(s) measured against " +
                       data.vramGB + " GB.", "var(--ink-soft)");
        renderFitLoaded(data.loaded);
        renderFitRows(data);
      })
      .catch(function () {
        fitStatus("Could not read the model list — is the server still running?",
                  "var(--danger)");
      });
  }

  var fitBtn = $("#fit-refresh");
  if (fitBtn) fitBtn.addEventListener("click", loadFit);
  var fitKv = $("#fit-kv");
  if (fitKv) fitKv.addEventListener("change", function () {
    var note = $("#fit-kv-note");
    if (note) note.hidden = fitKv.value === "f16";
    loadFit();
  });

  $("#whisperModel").addEventListener("input", function () { editedWhisper = true; });
  $("#copy").addEventListener("click", function () {
    var text = $("#code").textContent;
    navigator.clipboard.writeText(text).then(function () { toast("Copied"); },
      function () {
        var r = document.createRange(); r.selectNode($("#code"));
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
        try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
        window.getSelection().removeAllRanges();
      });
  });

  // ---- Boot ----------------------------------------------------------------
  var fromHash = (location.hash || "").replace("#", "");
  showTab(fromHash || "overview");
  refresh();
  loadJobs();
  loadLog();
  startEvents();

  // First run lands the operator on Settings so the wizard flow still guides.
  fetch("/setup/state").then(function (r) { return r.json(); }).then(function (state) {
    if (!state.configured && !fromHash) showTab("settings");
  }).catch(function () {});
})();
