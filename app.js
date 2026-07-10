(function() {
  "use strict";

  var API_BASE_URL = "https://script.google.com/macros/s/AKfycbyrBlTbdRLTF1N1mQxfdLZDKAJ3LdqGouoKwnpjzSsApz9MLiDSyy37rh_z38HEOTUT/exec";
  var DEFAULT_REF_PREFIX = "ADEE/ M / 400kV / Karjat / ";

  // GET is used for reads, POST (as text/plain) for writes — both are
  // CORS "simple requests", so no preflight OPTIONS round-trip is needed,
  // which Apps Script can't answer anyway. See Code.gs for the other side.
  function apiGet(action, params) {
    var url = API_BASE_URL + "?action=" + encodeURIComponent(action);
    Object.keys(params || {}).forEach(function(k) {
      if (params[k] === undefined || params[k] === null) return;
      url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    });
    return fetch(url).then(function(r) { return r.json(); }).catch(function(err) {
      return { ok: false, error: "Network error: " + err.message };
    });
  }
  function apiPost(action, payload) {
    return fetch(API_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: action, payload: payload || {} })
    }).then(function(r) { return r.json(); }).catch(function(err) {
      return { ok: false, error: "Network error: " + err.message };
    });
  }

  var state = {
    screen: "auth",
    authTab: "login",
    user: null,
    entries: [],
    otherExpenses: [],
    adminEmployees: [],
    scope: "fy",
    detailId: null,
    createStep: null,
    error: "",
    open: {},
    sideCollapsed: false,
    modal: null,
    pavatiOpen: {},
    loading: false,
    isAdmin: false,
    showPendingBills: false,
    showOtherPendingBills: false
  };
  var MONTHS = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ];
  var FONT_OPTIONS = [ {
    label: "Default",
    val: "Plus Jakarta Sans, Arial, sans-serif"
  }, {
    label: "Arial",
    val: "Arial, Helvetica, sans-serif"
  }, {
    label: "Times New Roman",
    val: "'Times New Roman', Times, serif"
  }, {
    label: "Georgia",
    val: "Georgia, serif"
  }, {
    label: "Verdana",
    val: "Verdana, Geneva, sans-serif"
  } ];
  var FONT_SIZES = [ 10, 11, 12, 13, 14, 16, 18, 20, 24 ];
  var TEXT_COLORS = [ "#101826", "#7a1f1f", "#8a4b00", "#1e6b3a", "#144e8c", "#4a1f7a", "#5c5c5c", "#000000" ];
  var HILITE_COLORS = [ "transparent", "#fff6b0", "#c9f2d8", "#cfe3ff", "#ffd9c9", "#e6d6ff", "#f0f0f0" ];
  function todayISO() {
    return (new Date).toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var p = iso.split("-");
    if (p.length !== 3) return iso;
    return parseInt(p[2], 10) + "-" + MONTHS[parseInt(p[1], 10) - 1] + "-" + p[0];
  }
  function fyOf(iso) {
    if (!iso) return "";
    var p = iso.split("-").map(function(x) {
      return parseInt(x, 10);
    });
    var y = p[0], m = p[1];
    return m >= 4 ? y + "-" + String(y + 1).slice(-2) : y - 1 + "-" + String(y).slice(-2);
  }
  function currentFY() {
    return fyOf(todayISO());
  }
  function uid() {
    return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function inr(n) {
    var v = parseFloat(n);
    if (!isFinite(v)) return "0";
    return v.toLocaleString("en-IN", {
      maximumFractionDigits: 2
    });
  }
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }
  function byId(id, fn) {
    var el = document.getElementById(id);
    if (el) fn(el);
  }
  function toast(msg, kind) {
    var s = document.getElementById("toast-stack");
    if (!s) {
      s = document.createElement("div");
      s.id = "toast-stack";
      document.body.appendChild(s);
    }
    var t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    s.appendChild(t);
    setTimeout(function() {
      t.style.opacity = "0";
      setTimeout(function() {
        t.remove();
      }, 300);
    }, 2500);
  }
  function showModal(title, message) {
    state.modal = {
      title: title,
      message: message
    };
    render();
  }
  function renderModal() {
    if (!state.modal) return "";
    return '<div class="modal-overlay" id="modalOverlay"><div class="modal-box">' + '<div class="modal-title">' + esc(state.modal.title) + "</div>" + '<div class="modal-msg">' + esc(state.modal.message) + "</div>" + '<button class="btn btn-primary btn-block" id="modalOk">OK</button>' + "</div></div>";
  }
  function newEntry(type, amount, subject) {
    var u = state.user;
    return {
      id: uid(),
      type: type,
      amount: amount,
      subject: subject,
      createdAt: (new Date).toISOString(),
      status: "Draft",
      letter: {
        refPrefix: (u && u.letterNo) || DEFAULT_REF_PREFIX,
        refNumber: "",
        refDate: todayISO(),
        sendingAddress: u && u.office || "",
        bodyHtml: "",
        attachments: []
      },
      appStatus: {
        submitted: false,
        submittedRemark: "",
        recommended: "",
        recAmount: "",
        recRemark: "",
        sentToAccounts: false,
        sentRemark: "",
        credited: "",
        creditRemark: ""
      },
      txns: [],
      recoupments: [],
      closure: null,
      form2: {
        sapNo: u && u.sapNo || "",
        cpfNo: u && u.cpfNo || "",
        pmoNo: u && u.pmoNo || "",
        dateFrom: "",
        dateTo: todayISO(),
        refundAccount: "",
        refundUTR: "",
        refundDate: "",
        amountPaidBack: ""
      }
    };
  }
  function getEntry(id) {
    return state.entries.filter(function(e) { return e.id === id; })[0];
  }
  // Optimistic: update the local cache immediately (instant UI), then
  // sync to the backend in the background. If the sync fails, the user
  // is told via toast — data stays correct locally either way since the
  // next full loadEntries() will reconcile against the server's copy.
  // When admin edits someone else's record, _owner tells us whose Drive folder to write to.
  function ownerOf(rec) { return (rec && rec._owner) || state.user.username; }
  function saveEntry(e) {
    var idx = state.entries.findIndex(function(x) { return x.id === e.id; });
    if (idx === -1) state.entries.unshift(e); else state.entries[idx] = e;
    var payload = Object.assign({}, e); delete payload._owner;
    apiPost("saveEntry", { username: ownerOf(e), entry: payload }).then(function(res) {
      if (!res.ok) toast("Could not sync to server: " + (res.error || "unknown error"), "err");
    });
  }
  function loadEntries() {
    if (!state.user) { state.entries = []; return Promise.resolve(); }
    return apiGet("listEntries", { username: state.user.username }).then(function(res) {
      var list = res.ok ? res.entries : [];
      list.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      state.entries = list;
      if (!res.ok) toast("Could not load entries: " + (res.error || "unknown error"), "err");
    });
  }
  function totals(e) {
    var recv = 0, exp = 0, noBill = false;
    (e.txns || []).forEach(function(t) {
      if (t.kind === "received") recv += parseFloat(t.amount) || 0; else {
        exp += parseFloat(t.amount) || 0;
        if (t.billAvailable === "no") noBill = true;
      }
    });
    return {
      recv: recv,
      exp: exp,
      balance: recv - exp,
      noBill: noBill
    };
  }
  function lastRecoupmentTxnIndex(e) {
    var rc = (e.recoupments || []).filter(function(r) {
      return !r.final;
    });
    for (var i = rc.length - 1; i >= 0; i--) {
      var id = rc[i].id;
      for (var j = 0; j < (e.txns || []).length; j++) {
        if (e.txns[j].recoupmentId === id) return j;
      }
    }
    return -1;
  }
  function cycleNumber(e) {
    return (e.recoupments || []).filter(function(r) {
      return !r.final;
    }).length + 1;
  }
  var WARN_PCT = {
    TI: 80,
    PI: 90
  };
  function utilization(e) {
    var t = totals(e);
    if (e.type === "TI") {
      var amt = parseFloat(e.amount) || 0;
      return {
        cycleExp: t.exp,
        limit: amt,
        pct: amt ? t.exp / amt * 100 : 0,
        overspent: t.exp > amt,
        warn: amt ? t.exp / amt * 100 >= WARN_PCT.TI : false
      };
    }
    var idx = lastRecoupmentTxnIndex(e);
    var cycleExp = (e.txns || []).filter(function(x, i) {
      return x.kind === "expense" && i > idx;
    }).reduce(function(s, x) {
      return s + (parseFloat(x.amount) || 0);
    }, 0);
    var limit = parseFloat(e.amount) || 0;
    return {
      cycleExp: cycleExp,
      limit: limit,
      pct: limit ? cycleExp / limit * 100 : 0,
      overspent: cycleExp > limit,
      warn: limit ? cycleExp / limit * 100 >= WARN_PCT.PI : false
    };
  }
  function pendingBillTxns(e) {
    return (e.txns || []).filter(function(t) { return t.kind === "expense" && t.billAvailable === "no" && t.billStage === "later"; });
  }
  function expenseTxns(e) {
    return (e.txns || []).filter(function(t) {
      return t.kind === "expense";
    });
  }
  function voucherSeq(e, txnId) {
    var list = expenseTxns(e);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === txnId) return i + 1;
    }
    return 0;
  }
  function displayVoucherNo(tx) {
    return tx.billNo || "";
  }
  function emptyProfile(u, p, method) {
    return {
      username: u,
      password: p || "",
      name: "",
      designation: "",
      office: "",
      letterNo: "",
      sapNo: "",
      cpfNo: "",
      pmoNo: "",
      bossName: "",
      bossDesignation: "",
      bossOffice: "",
      bossOrg: "MSETCL, Nashik",
      bossSalutation: "Sir",
      authMethod: method || "local",
      status: "pending",
      refundAccounts: []
    };
  }
  function profileComplete(p) {
    return p && p.name && p.designation && p.bossName && p.bossDesignation && p.bossOffice;
  }
  function doRegister(u, pw) {
    state.error = "";
    if (!u.trim() || !pw.trim()) {
      state.error = "Enter a username and password.";
      render();
      return;
    }
    state.loading = true; render();
    apiPost("register", { username: u.trim(), password: pw, authMethod: "local" }).then(function(res) {
      state.loading = false;
      if (!res.ok) { state.error = res.error || "Could not register."; render(); return; }
      state.screen = "auth";
      state.authTab = "login";
      toast("Account created. An admin must approve it before you can log in.", "warn");
      render();
    });
  }
  function doGoogleContinue(email) {
    state.error = "";
    email = (email || "").trim().toLowerCase();
    if (!email || email.indexOf("@") < 0) {
      state.error = "Enter a valid Gmail address.";
      render();
      return;
    }
    state.loading = true; render();
    apiGet("getEmployee", { username: email }).then(function(getRes) {
      if (getRes.ok) {
        var existing = getRes.profile;
        if (existing.status !== "approved") {
          state.loading = false;
          state.error = "This Google account is registered but awaiting admin approval.";
          render();
          return;
        }
        state.user = existing;
        Promise.all([loadEntries(), loadOtherExpenses()]).then(function() {
          state.loading = false;
          state.screen = profileComplete(existing) ? "home" : "profile";
          render();
        });
        return;
      }
      apiPost("register", { username: email, authMethod: "google" }).then(function(res) {
        state.loading = false;
        state.screen = "auth";
        state.authTab = "login";
        if (res.ok) toast("Google account linked. An admin must approve it before you can log in.", "warn");
        else { state.error = res.error || "Could not link Google account."; }
        render();
      });
    });
  }
  function doLogin(u, pw) {
    state.error = "";
    if (!u.trim() || !pw.trim()) { state.error = "Enter your username and password."; render(); return; }
    state.loading = true; render();
    // Try admin first — same form, no separate admin page.
    apiPost("adminLogin", { username: u.trim(), password: pw }).then(function(adminRes) {
      if (adminRes.ok) {
        state.isAdmin = true;
        state.user = { username: u.trim(), name: "Administrator", designation: "Admin", isAdmin: true, refundAccounts: [] };
        loadAdminEmployees().then(function() {
          return loadAllData();
        }).then(function() {
          state.loading = false;
          state.screen = "home";
          render();
        });
        return;
      }
      apiPost("login", { username: u.trim(), password: pw }).then(function(res) {
        if (!res.ok) {
          state.loading = false;
          state.error = res.error || "Could not log in.";
          render();
          return;
        }
        state.isAdmin = false;
        state.user = res.profile;
        Promise.all([loadEntries(), loadOtherExpenses()]).then(function() {
          state.loading = false;
          state.screen = profileComplete(res.profile) ? "home" : "profile";
          render();
        });
      });
    });
  }
  // Admin view: pull every employee's entries + expenses into one combined list,
  // tagging each record with its owner so admin edits/deletes route to the right folder.
  function loadAllData() {
    var emps = state.adminEmployees.filter(function(e) { return e.status === "approved"; });
    var entryCalls = emps.map(function(emp) {
      return apiGet("listEntries", { username: emp.username }).then(function(r) {
        return (r.ok ? r.entries : []).map(function(x) { x._owner = emp.username; return x; });
      });
    });
    var expCalls = emps.map(function(emp) {
      return apiGet("listOtherExpenses", { username: emp.username }).then(function(r) {
        return (r.ok ? r.expenses : []).map(function(x) { x._owner = emp.username; return x; });
      });
    });
    return Promise.all([Promise.all(entryCalls), Promise.all(expCalls)]).then(function(res) {
      state.entries = [].concat.apply([], res[0]).sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      state.otherExpenses = [].concat.apply([], res[1]);
    });
  }
  function doLogout() {
    state.user = null;
    state.isAdmin = false;
    state.adminEmployees = [];
    state.entries = [];
    state.otherExpenses = [];
    state.detailId = null;
    state.screen = "auth";
    state.authTab = "login";
    state.error = "";
    render();
  }
  function doAdminLogin(u, pw) {
    state.error = "";
    state.loading = true; render();
    apiPost("adminLogin", { username: u, password: pw }).then(function(res) {
      state.loading = false;
      if (!res.ok) { state.error = res.error || "Incorrect admin credentials."; render(); return; }
      state.screen = "admin";
      loadAdminEmployees().then(render);
    });
  }
  function loadAdminEmployees() {
    return apiGet("listEmployees", {}).then(function(res) {
      state.adminEmployees = res.ok ? res.employees : [];
      if (!res.ok) toast("Could not load employee list: " + (res.error || "unknown error"), "err");
    });
  }
  function renderAdminInner() {
    var all = state.adminEmployees;
    var pending = all.filter(function(p) { return p.status === "pending"; });
    var approved = all.filter(function(p) { return p.status === "approved"; });
    function row(p, actions) {
      var methodBadge = '<span class="badge badge-neutral">' + esc(p.username) + "</span>";
      return '<div class="est-card" style="cursor:default">' + '<div class="est-main"><div class="est-title">' + esc(p.name || "(profile incomplete)") + '</div><div class="hint est-meta">' + methodBadge + "</div></div>" + '<div class="est-actions">' + actions + "</div></div>";
    }
    var pendingRows = pending.length ? pending.map(function(p) {
      return row(p, '<button class="btn btn-primary btn-xs" data-approve="' + p.username + '">Approve</button><button class="btn btn-danger btn-xs" data-reject="' + p.username + '">Reject</button>');
    }).join("") : '<div class="hint" style="padding:10px 2px">No accounts awaiting approval.</div>';
    var approvedRows = approved.length ? approved.map(function(p) {
      return row(p, '<span class="badge badge-ok">Approved</span> <button class="btn btn-ghost btn-xs" data-revoke="' + p.username + '">Revoke</button> <button class="btn btn-ghost btn-xs" data-setcreds="' + p.username + '">Set password</button>');
    }).join("") : '<div class="hint" style="padding:10px 2px">No approved accounts yet.</div>';
    return '<div class="card"><div class="card-head"><h3>Pending approval (' + pending.length + ")</h3></div>" + pendingRows + "</div>" +
      '<div class="card"><div class="card-head"><h3>Approved employees (' + approved.length + ")</h3></div>" + approvedRows + "</div>";
  }
  function wireAdminPanel() {
    document.querySelectorAll("[data-setcreds]").forEach(function(el) {
      el.onclick = function() {
        var target = el.getAttribute("data-setcreds");
        var np = window.prompt("New password for " + target + " (leave blank to cancel):", "");
        if (!np) return;
        state.loading = true; render();
        apiPost("changeCredentials", { username: target, newPassword: np }).then(function(res) {
          state.loading = false;
          toast(res.ok ? "Password updated for " + target : (res.error || "Could not update."), res.ok ? "ok" : "err");
          render();
        });
      };
    });
    document.querySelectorAll("[data-approve]").forEach(function(el) {
      el.onclick = function() {
        var u = el.getAttribute("data-approve");
        state.loading = true; render();
        apiPost("approveEmployee", { username: u }).then(function(res) {
          state.loading = false;
          if (!res.ok) { toast("Could not approve: " + (res.error || "unknown error"), "err"); render(); return; }
          toast("Account approved.", "ok");
          loadAdminEmployees().then(render);
        });
      };
    });
    document.querySelectorAll("[data-reject]").forEach(function(el) {
      el.onclick = function() {
        var u = el.getAttribute("data-reject");
        state.loading = true; render();
        apiPost("rejectEmployee", { username: u }).then(function(res) {
          state.loading = false;
          if (!res.ok) { toast("Could not reject: " + (res.error || "unknown error"), "err"); render(); return; }
          toast("Account rejected and removed.", "ok");
          loadAdminEmployees().then(render);
        });
      };
    });
    document.querySelectorAll("[data-revoke]").forEach(function(el) {
      el.onclick = function() {
        var u = el.getAttribute("data-revoke");
        state.loading = true; render();
        apiPost("revokeEmployee", { username: u }).then(function(res) {
          state.loading = false;
          if (!res.ok) { toast("Could not revoke: " + (res.error || "unknown error"), "err"); render(); return; }
          toast("Access revoked — moved back to pending.", "warn");
          loadAdminEmployees().then(render);
        });
      };
    });
  }

  /* ════════ ATMOSPHERE: day/night + live weather scenery ════════
     Decorative only. Weather comes from Open-Meteo (no API key, free).
     If the lookup fails or is blocked, we fall back to "clear" — the
     scenery still renders, it just doesn't rain. */
  var ATMOS = { theme: "day", weather: "clear", auto: true };

  function buildSky() {
    if (document.getElementById("sky")) return;
    var sky = document.createElement("div");
    sky.id = "sky";
    sky.innerHTML =
      '<div class="galaxy"></div>' +
      '<div class="stars" id="starField"></div>' +
      '<div class="planets"><div class="planet planet-a"></div><div class="planet planet-b"></div><div class="planet planet-c"></div><div class="shooting"></div></div>' +
      '<div class="sun"></div><div class="moon"></div>' +
      '<div class="cloud cloud-1"></div><div class="cloud cloud-2"></div><div class="cloud cloud-3"></div>' +
      '<div class="haze"></div>' +
      '<div class="ridge ridge-far"></div><div class="ridge ridge-mid"></div><div class="ridge ridge-near"></div>' +
      '<div class="village">' + villageSvg() + '</div>' +
      '<div id="precip"></div>' +
      '<div class="flash"></div>';
    document.body.insertBefore(sky, document.body.firstChild);
    seedStars();
  }
  function villageSvg() {
    return '<svg viewBox="0 0 230 64" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 64 V44 L24 32 L40 44 V64 Z" fill="#31414F"/>' +
      '<rect class="win" x="18" y="48" width="6" height="7"/><rect class="win" x="28" y="48" width="6" height="7"/>' +
      '<path d="M52 64 V40 L72 26 L92 40 V64 Z" fill="#3A4B5A"/>' +
      '<rect class="win" x="64" y="46" width="7" height="8"/><rect class="win" x="76" y="46" width="7" height="8"/>' +
      '<path d="M104 64 V46 L118 36 L132 46 V64 Z" fill="#31414F"/>' +
      '<rect class="win" x="114" y="52" width="6" height="6"/>' +
      '<path d="M150 64 V34 h26 V64 Z" fill="#3A4B5A"/>' +
      '<circle cx="163" cy="26" r="9" fill="#4A5B6A"/><rect x="161" y="8" width="4" height="12" fill="#4A5B6A"/>' +
      '<rect class="win" x="158" y="44" width="10" height="9"/>' +
      '<path d="M192 64 V44 L206 34 L220 44 V64 Z" fill="#31414F"/>' +
      '<rect class="win" x="202" y="50" width="7" height="7"/>' +
      "</svg>";
  }
  function seedStars() {
    var field = document.getElementById("starField");
    if (!field || field.childNodes.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 90; i++) {
      var st = document.createElement("div");
      st.className = "star";
      var sz = Math.random() * 1.8 + 0.6;
      st.style.width = sz + "px";
      st.style.height = sz + "px";
      st.style.left = Math.random() * 100 + "%";
      st.style.top = Math.random() * 62 + "%";
      st.style.animationDelay = (Math.random() * 3).toFixed(2) + "s";
      frag.appendChild(st);
    }
    field.appendChild(frag);
  }
  function renderPrecip(kind) {
    var host = document.getElementById("precip");
    if (!host) return;
    host.innerHTML = "";
    if (kind === "rain") {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < 90; i++) {
        var d = document.createElement("div");
        d.className = "drop";
        d.style.left = Math.random() * 100 + "%";
        d.style.animationDuration = (0.5 + Math.random() * 0.45).toFixed(2) + "s";
        d.style.animationDelay = (Math.random() * 1.4).toFixed(2) + "s";
        d.style.height = (40 + Math.random() * 45) + "px";
        d.style.opacity = (0.35 + Math.random() * 0.5).toFixed(2);
        frag.appendChild(d);
      }
      for (var j = 0; j < 14; j++) {
        var sp = document.createElement("div");
        sp.className = "splash";
        sp.style.left = Math.random() * 100 + "%";
        sp.style.animationDelay = (Math.random() * 1.6).toFixed(2) + "s";
        frag.appendChild(sp);
      }
      host.appendChild(frag);
    } else if (kind === "snow") {
      var f2 = document.createDocumentFragment();
      for (var k = 0; k < 70; k++) {
        var fl = document.createElement("div");
        fl.className = "flake";
        var s2 = 2 + Math.random() * 4;
        fl.style.width = s2 + "px";
        fl.style.height = s2 + "px";
        fl.style.left = Math.random() * 100 + "%";
        fl.style.setProperty("--drift", (Math.random() * 90 - 45) + "px");
        fl.style.animationDuration = (7 + Math.random() * 9).toFixed(1) + "s";
        fl.style.animationDelay = (Math.random() * 8).toFixed(1) + "s";
        fl.style.opacity = (0.5 + Math.random() * 0.5).toFixed(2);
        f2.appendChild(fl);
      }
      host.appendChild(f2);
    }
  }
  function applyAtmos() {
    document.body.setAttribute("data-theme", ATMOS.theme);
    document.body.setAttribute("data-weather", ATMOS.weather);
    renderPrecip(ATMOS.weather);
    var btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = ATMOS.theme === "day" ? "\u263e" : "\u2600";
    var sel = document.getElementById("weatherSelect");
    if (sel && sel.value !== ATMOS.weather) sel.value = ATMOS.weather;
  }
  function autoTheme() {
    var h = new Date().getHours();
    return (h >= 6 && h < 18) ? "day" : "night";
  }
  // Open-Meteo WMO weather codes -> our four scenery states.
  function wmoToWeather(code) {
    if (code === 0 || code === 1) return "clear";
    if (code === 2 || code === 3 || code === 45 || code === 48) return "cloudy";
    if (code >= 71 && code <= 77) return "snow";
    if (code === 85 || code === 86) return "snow";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) return "rain";
    return "clear";
  }
  // Fixed to Siddhatek (Siddhivinayak temple, on the Bhima river near Daund, Pune/Ahmednagar
  // border, Maharashtra). No geolocation prompt — the scenery always mirrors weather there.
  var SITE_LAT = 18.588, SITE_LON = 74.616;
  function detectWeather() {
    // Guarded: the scenery is decorative, so a failed/absent fetch must never
    // break app boot — it just leaves the fallback (clear) weather in place.
    try {
      if (typeof fetch !== "function") return;
      fetch("https://api.open-meteo.com/v1/forecast?latitude=" + SITE_LAT + "&longitude=" + SITE_LON +
            "&current=weather_code,is_day&timezone=Asia%2FKolkata")
        .then(function(r) { return r.json(); })
        .then(function(j) {
          if (!j || !j.current) return;
          ATMOS.weather = wmoToWeather(j.current.weather_code);
          if (ATMOS.auto) ATMOS.theme = j.current.is_day ? "day" : "night";
          applyAtmos();
        })
        .catch(function() { /* offline or blocked — keep the fallback scenery */ });
    } catch (e) { /* ignore */ }
  }
  // Re-check every 15 min so a passing shower shows up — but never override a manual pick.
  setInterval(function() { if (ATMOS.auto) detectWeather(); }, 15 * 60 * 1000);
  function initAtmos() {
    try {
      buildSky();
      ATMOS.theme = autoTheme();
      applyAtmos();
      detectWeather();
    } catch (e) { /* scenery is decorative; never let it block the app */ }
  }
  function wireAtmosControls() {
    byId("themeToggle", function(el) {
      el.onclick = function() {
        ATMOS.auto = false;
        ATMOS.theme = ATMOS.theme === "day" ? "night" : "day";
        applyAtmos();
      };
    });
    byId("weatherSelect", function(el) {
      el.onchange = function() {
        ATMOS.auto = false; // manual pick — stop auto-refreshing from the live feed
        ATMOS.weather = el.value;
        applyAtmos();
      };
    });
  }
  function boltSvg() {
    return '<svg class="bolt" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
  }
  function renderAuth() {
    var mode = state.authTab;
    var isReg = mode === "register";
    return '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-logo">' + boltSvg() + "<h1>Imprest Management Portal</h1><p>Temporary &amp; Permanent Imprest — request, track &amp; close</p></div>" +
      '<div class="tabs"><div class="tab ' + (!isReg ? "active" : "") + '" data-tab="login">Log in</div><div class="tab ' + (isReg ? "active" : "") + '" data-tab="register">Register</div></div>' +
      (state.error ? '<div class="locked-note" style="background:var(--bad-100);color:var(--bad-500);margin-bottom:14px">\u26a0 ' + esc(state.error) + "</div>" : "") +
      '<div class="field"><label>Username</label><input id="au_user" placeholder="e.g. ashish.patil"></div>' +
      '<div class="field"><label>Password</label><input type="password" id="au_pass" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"></div>' +
      '<button class="btn btn-primary btn-block" id="authSubmit">' + (isReg ? "Create account" : "Log in") + "</button>" +
      (isReg ? '<div class="hint" style="margin-top:8px">New accounts need admin approval before first login. You will be able to log in once approved.</div>' : "") +
      "</div></div>";
  }
  function shell(inner, title, sub, actions) {
    var u = state.user;
    var initials = (u.name || u.username || "U").split(/\s+/).map(function(w) {
      return w[0];
    }).slice(0, 2).join("").toUpperCase();
    return '<div class="topbar"><div class="topbar-row1">' + '<button class="nav-toggle" id="sideToggle" title="Toggle menu">☰</button>' + '<div class="brand">' + boltSvg() + '<div><div>Imprest Portal</div><div class="sub">MSETCL · Petty Expense Imprest</div></div></div>' + '<div class="topbar-spacer"></div>' + atmosControlsHtml() + '<div class="role-chip">' + (state.isAdmin ? "Admin" : "Officer") + '</div>' + '<button class="user-pill" id="logoutPill"><span class="avatar">' + esc(initials) + '</span><span class="user-pill-name">' + esc(u.name || u.username) + "</span></button>" + "</div></div>" + '<div class="shell"><nav class="sidenav' + (state.sideCollapsed ? " collapsed" : "") + '">' + navItem("home", "▤", "Dashboard") + navItem("profile", "◔", "My Profile") + navItem("otherexp", "⛁", "Other Expenses") + (state.isAdmin ? navItem("admin", "\u2691", "Employees") : "") + '<div class="nav-divider"></div>' + '<button class="nav-item" id="navCreate"><span class="ic">＋</span> <span class="lbl">Create new entry</span></button>' + '</nav><main class="main" id="main-content">' + '<div class="page-head"><div><h1 class="page-title">' + esc(title) + "</h1>" + (sub ? '<div class="page-sub">' + sub + "</div>" : "") + '</div><div class="page-actions">' + (actions || "") + "</div></div>" + inner + "</main></div>";
  }
  function atmosControlsHtml() {
    return '<div class="atmos-controls">' +
      '<select class="weather-select" id="weatherSelect" title="Live weather at Siddhatek, near Daund">' +
        '<option value="clear">\u2600 Clear</option>' +
        '<option value="cloudy">\u2601 Cloudy</option>' +
        '<option value="rain">\u2602 Rain</option>' +
        '<option value="snow">\u2744 Snow</option>' +
      '</select>' +
      '<button class="icon-btn" id="themeToggle" title="Toggle day / night">\u263e</button>' +
    '</div>';
  }
  function navItem(key, ic, label) {
    return '<button class="nav-item ' + (state.screen === key ? "active" : "") + '" data-nav="' + key + '"><span class="ic">' + ic + '</span> <span class="lbl">' + label + "</span></button>";
  }
  function renderHome() {
    var scope = state.scope;
    var list = scope === "fy" ? state.entries.filter(function(e) {
      return fyOf(e.letter.refDate) === currentFY();
    }) : state.entries;
    var ti = list.filter(function(e) {
      return e.type === "TI";
    });
    var pi = list.filter(function(e) {
      return e.type === "PI";
    });
    var tiTotal = ti.reduce(function(s, e) {
      return s + (parseFloat(e.amount) || 0);
    }, 0);
    var piTotal = pi.reduce(function(s, e) {
      return s + (parseFloat(e.amount) || 0);
    }, 0);
    var openTI = ti.filter(function(e) {
      return e.status !== "Closed";
    }).length;
    var piPending = pi.filter(function(e) {
      return e.status !== "Closed";
    }).reduce(function(s, e) {
      return s + (parseFloat(e.amount) || 0);
    }, 0);
    var stats = '<div class="grid grid-4" style="margin-bottom:20px">' + statCard("₹", "PI taken", "Rs. " + inr(piTotal)) + statCard("₹", "TI taken", "Rs. " + inr(tiTotal)) + statCard("◐", "PI pending amount", "Rs. " + inr(piPending)) + statCard("◷", "Open TIs", String(openTI)) + "</div>";
    var allPI = state.entries.filter(function(e) {
      return e.type === "PI";
    });
    var allTI = state.entries.filter(function(e) {
      return e.type === "TI";
    });
    var lists = '<div class="card"><div class="cat-head">Permanent Imprest (PI)</div>' + (allPI.length ? allPI.map(function(e, i) {
      return entryCard(e, i + 1);
    }).join("") : '<div class="hint" style="padding:6px 2px">No PI entries yet.</div>') + "</div>" + '<div class="card"><div class="cat-head">Temporary Imprest (TI)</div>' + (allTI.length ? allTI.map(function(e, i) {
      return entryCard(e, i + 1);
    }).join("") : '<div class="hint" style="padding:6px 2px">No TI entries yet.</div>') + "</div>";
    var toggle = '<div class="seg"><button class="' + (scope === "fy" ? "on" : "") + '" data-scope="fy">This FY (' + currentFY() + ')</button><button class="' + (scope === "all" ? "on" : "") + '" data-scope="all">All time</button></div>';
    var actions = toggle + '<button class="btn btn-gold" id="createBtn2">＋ Create new entry</button>';
    return shell(stats + lists, "Dashboard", esc(state.user.office || ""), actions);
  }
  function statCard(ic, label, v) {
    return '<div class="card stat-card"><div class="stat-ic">' + ic + '</div><div class="stat-val">' + esc(v) + '</div><div class="stat-label">' + esc(label) + "</div></div>";
  }
  function statusBadge(s) {
    var m = {
      Draft: "badge-neutral",
      Sent: "badge-neutral",
      Open: "badge-info",
      "Sent to Accounts": "badge-gold",
      Reimbursed: "badge-gold",
      Closed: "badge-ok"
    };
    return '<span class="badge ' + (m[s] || "badge-neutral") + '">' + esc(s) + "</span>";
  }
  function entryCard(e, sno) {
    var t = totals(e);
    return '<div class="est-card" data-open="' + e.id + '">' + '<div class="est-sno">' + sno + '</div><div class="est-icon">' + e.type + "</div>" + '<div class="est-main"><div class="est-title">' + esc(e.subject || "(No subject)") + "</div>" + '<div class="hint est-meta">' + esc(e.letter.refPrefix || "") + " " + esc(e.letter.refNumber || "—") + " · FY " + fyOf(e.letter.refDate) + " · " + fmtDate(e.letter.refDate) + (t.noBill ? ' <span class="flag-nobill">Pavati Available</span>' : "") + "</div></div>" + '<div class="est-right"><div class="mono est-amt">Rs. ' + inr(e.amount) + "</div>" + statusBadge(e.status) + "</div>" + '<div class="est-actions" onclick="event.stopPropagation()">' + '<button class="btn btn-ghost btn-xs" data-copy="' + e.id + '">Copy</button>' + '<button class="btn btn-danger btn-xs" data-del="' + e.id + '">Del</button></div>' + "</div>";
  }
  function renderCreate() {
    var s = state.createStep || {
      type: "TI",
      amount: "",
      subject: ""
    };
    var body = '<div class="card" style="max-width:560px">' + (state.error ? '<div class="locked-note" style="background:var(--bad-100);color:var(--bad-500);margin-bottom:14px">⚠ ' + esc(state.error) + "</div>" : "") + '<div class="field"><label>Imprest type</label><div class="radio-pill-group">' + '<div class="radio-pill ' + (s.type === "TI" ? "sel" : "") + '" data-ctype="TI">TI — Temporary</div>' + '<div class="radio-pill ' + (s.type === "PI" ? "sel" : "") + '" data-ctype="PI">PI — Permanent</div>' + "</div></div>" + '<div class="field"><label>Amount (Rs.)</label><input id="cr_amount" value="' + esc(s.amount) + '" placeholder="e.g. 15000"></div>' + '<div class="field"><label>Purpose / Subject</label><input id="cr_subject" value="' + esc(s.subject) + '" placeholder="e.g. TI Application of Rs 15,000 for weed control treatment"></div>' + '<div class="btn-row"><button class="btn btn-primary" id="cr_save" style="flex:1">Save &amp; open</button><button class="btn btn-ghost" id="cr_cancel">Cancel</button></div>' + "</div>";
    return shell(body, "Create new entry", "Pick type, amount and purpose to begin.");
  }
  function isOpen(k) {
    return !!state.open[k];
  }
  function collapse(key, title, inner, badge) {
    var op = isOpen(key);
    return '<div class="collapse ' + (op ? "open" : "") + '"><div class="collapse-head" data-coll="' + key + '"><span>' + esc(title) + (badge ? " " + badge : "") + '</span><span class="chev">▶</span></div><div class="collapse-body">' + inner + "</div></div>";
  }
  function renderDetail() {
    var e = getEntry(state.detailId);
    if (!e) return renderHome();
    var t = totals(e);
    var credited = e.appStatus.credited === "yes";
    var header = '<div class="card"><div class="card-head"><div class="detail-head-main"><div class="est-icon">' + e.type + "</div>" + '<div><div class="detail-subject">' + esc(e.subject || "(No subject)") + "</div>" + '<div class="hint">Rs. ' + inr(e.amount) + " · FY " + fyOf(e.letter.refDate) + " · " + statusBadge(e.status) + "</div></div></div>" + '<button class="btn btn-ghost btn-sm" id="backHome">← Dashboard</button></div>' + '<div class="field-row"><div class="field"><label>Amount (Rs.)</label><input id="d_amount" value="' + esc(e.amount) + '"></div>' + '<div class="field"><label>Subject</label><input id="d_subject" value="' + esc(e.subject) + '"></div></div>' + '<button class="btn btn-primary btn-sm" id="d_saveHead">Save changes</button></div>';
    var body = header + collapse("prep", "Prepare " + e.type + " Application", prepareInner(e)) + collapse("status", e.type + " Application Status", statusInner(e), statusChipForApp(e)) + collapse("accounts", e.type + " Account Section", credited ? accountsInner(e, t) : '<div class="locked-note">🔒 Unlocks once “Amount Credited” is marked Yes in Application Status above.</div>');
    return shell(body, e.type + " · " + (e.letter.refNumber ? "No. " + e.letter.refNumber : "(no ref yet)"), esc(e.subject || ""));
  }
  function statusChipForApp(e) {
    var a = e.appStatus;
    if (a.credited === "yes") return '<span class="badge badge-ok">Credited</span>';
    if (a.sentToAccounts) return '<span class="badge badge-gold">At Accounts</span>';
    if (a.submitted) return '<span class="badge badge-info">Submitted</span>';
    return "";
  }
  function prepareInner(e) {
    var L = e.letter;
    var flds = '<div class="field-row">' + f("l_prefix", "Letter ref. prefix", L.refPrefix, "Ref. ...No.") + f("l_num", "Ref. number", L.refNumber, "e.g. 214") + "</div>" + '<div class="field"><label>Date</label><input type="date" id="l_date" value="' + esc(L.refDate) + '"></div>' + '<div class="field"><label>Sending address</label><textarea id="l_addr" placeholder="Office / site address">' + esc(L.sendingAddress) + "</textarea>" + '<div class="hint">Prefilled from your profile office — edit here for this letter only.</div></div>' + '<div class="hint" style="margin-bottom:12px">Name, designation, office &amp; officer details are pulled from your profile; edit there for permanent changes.</div>' + rich("l_body", "Letter body") + '<label style="margin:6px 0 8px">Attachments (' + L.attachments.length + '/5)</label><div id="attList">' + L.attachments.map(function(a, i) {
      return attRow(a, i);
    }).join("") + "</div>" + (L.attachments.length < 5 ? '<button class="btn btn-ghost btn-sm" id="addAtt">＋ Add attachment</button>' : "") + '<div class="btn-row" style="margin-top:14px"><button class="btn btn-ghost btn-sm" id="prep_back">← Back</button><button class="btn btn-primary btn-sm" id="l_save">Save application</button></div>';
    var preview = collapse("prev", "Letter Preview", '<div id="letterPreview" class="letter-scale-outer">' + letterSheet(state.user, e) + "</div>");
    var dl = collapse("dl", "Download Letter", '<div class="btn-row"><button class="btn btn-gold btn-sm" id="dlWord">⬇ Word (.docx)</button><button class="btn btn-ghost btn-sm" id="dlPdf">⬇ PDF</button><button class="btn btn-ghost btn-sm" id="dlPrint">🖶 Print</button></div>' + '<div class="hint" style="margin-top:8px">Generates a real file matching the letter format. Tip: a .docx opens perfectly in Google Docs too — upload it and choose “Open with Google Docs.”</div>');
    return flds + preview + dl;
  }
  function f(id, label, v, ph) {
    return '<div class="field"><label>' + esc(label) + '</label><input id="' + id + '" value="' + esc(v || "") + '" placeholder="' + esc(ph || "") + '"></div>';
  }
  function attRow(a, i) {
    return '<div class="field-row" style="margin-bottom:8px"><input class="att-input" data-attidx="' + i + '" value="' + esc(a) + '" placeholder="Attachment ' + (i + 1) + ' name" style="flex:1"><button class="btn btn-danger btn-sm att-del" data-attdel="' + i + '" style="flex:none">✕</button></div>';
  }
  function rich(id, label) {
    var fontOpts = FONT_OPTIONS.map(function(fo) {
      return '<option value="' + fo.val + '">' + fo.label + "</option>";
    }).join("");
    var sizeOpts = FONT_SIZES.map(function(s) {
      return '<option value="' + s + '"' + (s === 13 ? " selected" : "") + ">" + s + "pt</option>";
    }).join("");
    var textSwatches = TEXT_COLORS.map(function(c) {
      return '<button type="button" class="rt-color" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
    }).join("");
    var hiSwatches = HILITE_COLORS.map(function(c) {
      return '<button type="button" class="rt-hicolor" data-hicolor="' + c + '" style="background:' + (c === "transparent" ? "#fff" : c) + (c === "transparent" ? ";background-image:linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%),linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%);background-size:6px 6px;background-position:0 0,3px 3px" : "") + '" title="' + (c === "transparent" ? "No highlight" : c) + '"></button>';
    }).join("");
    return '<div class="field">' + "<label>" + esc(label) + "</label>" + '<div class="rt-toolbar" data-for="' + id + '">' + '<select class="rt-font" data-font-for="' + id + '">' + fontOpts + "</select>" + '<select class="rt-size" data-size-for="' + id + '">' + sizeOpts + "</select>" + rtb("bold", "<b>B</b>") + rtb("italic", "<i>I</i>") + rtb("underline", "<u>U</u>") + '<span class="rt-div"></span>' + rtb("justifyLeft", "⟸") + rtb("justifyCenter", "≡") + rtb("justifyRight", "⟹") + rtb("justifyFull", "☰") + '<span class="rt-div"></span>' + '<button type="button" class="rt-btn rt-reset" data-cmd="reset" title="Reset formatting">⟲</button>' + "</div>" + '<div class="rt-toolbar rt-toolbar2" data-for="' + id + '">' + '<span class="rt-swatch-label">Text</span>' + textSwatches + '<span class="rt-div"></span>' + '<span class="rt-swatch-label">Highlight</span>' + hiSwatches + "</div>" + '<div class="rt-editor" id="' + id + '" contenteditable="true"></div>' + "</div>";
  }
  function rtb(cmd, inner) {
    return '<button type="button" class="rt-btn" data-cmd="' + cmd + '">' + inner + "</button>";
  }
  function applyFontSize(ed, pt) {
    document.execCommand("fontSize", false, "7");
    ed.querySelectorAll('font[size="7"]').forEach(function(f) {
      var span = document.createElement("span");
      span.style.fontSize = pt + "pt";
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
    });
  }
  function parseRichHtml(html) {
    var container = document.createElement("div");
    container.innerHTML = html || "";
    var align = "justify";
    var alignEl = container.querySelector("[style*='text-align']");
    if (alignEl) {
      var m = /text-align:\s*(\w+)/i.exec(alignEl.getAttribute("style") || "");
      if (m) align = m[1];
    } else if (/text-align:\s*(\w+)/i.test(container.getAttribute("style") || "")) {
      align = /text-align:\s*(\w+)/i.exec(container.getAttribute("style"))[1];
    }
    var runs = [];
    function walk(node, style) {
      if (node.nodeType === 3) {
        if (node.textContent) runs.push({
          text: node.textContent,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
          color: style.color,
          font: style.font,
          size: style.size
        });
        return;
      }
      if (node.nodeType !== 1) return;
      var s = {
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        color: style.color,
        font: style.font,
        size: style.size
      };
      var tag = node.tagName.toLowerCase();
      if (tag === "b" || tag === "strong") s.bold = true;
      if (tag === "i" || tag === "em") s.italic = true;
      if (tag === "u") s.underline = true;
      if (tag === "font") {
        if (node.getAttribute("color")) s.color = node.getAttribute("color");
        if (node.getAttribute("face")) s.font = node.getAttribute("face");
      }
      var inlineStyle = node.getAttribute("style") || "";
      var cm = /color:\s*(#[0-9a-fA-F]{3,6}|rgb\([^)]+\))/i.exec(inlineStyle);
      if (cm) s.color = cm[1];
      var fm = /font-family:\s*([^;]+)/i.exec(inlineStyle);
      if (fm) s.font = fm[1].trim();
      var szm = /font-size:\s*([\d.]+)pt/i.exec(inlineStyle);
      if (szm) s.size = parseFloat(szm[1]);
      var fw = /font-weight:\s*(bold|700|800|900)/i.exec(inlineStyle);
      if (fw) s.bold = true;
      var fs = /font-style:\s*italic/i.exec(inlineStyle);
      if (fs) s.italic = true;
      var td = /text-decoration[^:]*:\s*[^;]*underline/i.exec(inlineStyle);
      if (td) s.underline = true;
      if (tag === "br") {
        runs.push({
          text: "\n",
          bold: false,
          italic: false,
          underline: false
        });
        return;
      }
      node.childNodes.forEach(function(ch) {
        walk(ch, s);
      });
    }
    container.childNodes.forEach(function(ch) {
      walk(ch, {});
    });
    return {
      align: align,
      runs: runs
    };
  }
  function runsToPlainText(parsed) {
    return parsed.runs.map(function(r) {
      return r.text;
    }).join("").trim();
  }
  function statusInner(e) {
    var a = e.appStatus;
    var rows = "";
    rows += chkRow("st_submitted", "Application Submitted", a.submitted, "st_submittedRemark", a.submittedRemark);
    rows += '<div class="chk-row"><div class="chk-main"><div class="chk-title">Recommendation Status</div>' + '<div class="radio-pill-group" style="margin:8px 0"><div class="radio-pill ' + (a.recommended === "yes" ? "sel" : "") + '" data-rec="yes">Recommended</div><div class="radio-pill ' + (a.recommended === "no" ? "sel" : "") + '" data-rec="no">Not Recommended</div></div>' + (a.recommended === "yes" ? '<input id="st_recAmount" placeholder="Recommended Amount (Rs.)" value="' + esc(a.recAmount) + '" style="margin-bottom:6px">' : "") + '<input id="st_recRemark" placeholder="Remarks" value="' + esc(a.recRemark) + '"></div></div>';
    rows += chkRow("st_sent", "Sent to Accounts", a.sentToAccounts, "st_sentRemark", a.sentRemark);
    rows += '<div class="chk-row"><div class="chk-main"><div class="chk-title">Amount Credited</div>' + '<div class="radio-pill-group" style="margin:8px 0"><div class="radio-pill ' + (a.credited === "yes" ? "sel" : "") + '" data-cred="yes">Credited</div><div class="radio-pill ' + (a.credited === "no" ? "sel" : "") + '" data-cred="no">Not Credited</div></div>' + '<input id="st_creditRemark" placeholder="Remarks" value="' + esc(a.creditRemark) + '"></div></div>';
    return rows + '<button class="btn btn-primary btn-sm" id="st_save" style="margin-top:12px">Save status</button>';
  }
  function chkRow(id, title, checked, remarkId, remarkVal) {
    return '<div class="chk-row"><input type="checkbox" class="chk-box" id="' + id + '" ' + (checked ? "checked" : "") + ">" + '<div class="chk-main"><div class="chk-title">' + esc(title) + "</div>" + '<input id="' + remarkId + '" placeholder="Remarks" value="' + esc(remarkVal || "") + '" style="margin-top:6px"></div></div>';
  }
  function accountsInner(e, t) {
    var u = utilization(e);
    var closed = e.status === "Closed";
    var banner = "";
    if (!closed) {
      if (u.overspent) {
        banner = '<div class="util-banner util-bad">⚠ Amount exhausted — you are overspending on this ' + e.type + " (" + Math.round(u.pct) + "% of Rs. " + inr(u.limit) + "). Please process " + (e.type === "TI" ? "Imprest Closure" : "Recoupment") + ".</div>";
      } else if (u.warn) {
        banner = '<div class="util-banner util-warn">⚠ ' + Math.round(u.pct) + "% of the " + (e.type === "TI" ? "imprest" : "cycle limit") + " utilized. Consider processing " + (e.type === "TI" ? "Imprest Closure" : "Recoupment") + ".</div>";
      }
    }
    var rows = renderLedger(e);
    var summary = '<div class="grid grid-4" style="margin-bottom:14px">' + statCard("＋", "Received", "Rs. " + inr(t.recv)) + statCard("－", "Expense", "Rs. " + inr(t.exp)) + statCard("=", "Balance", "Rs. " + inr(t.balance)) + clickableStatCard("pendingBillsCard", "⚑", "Pending Bills", String(pendingBillTxns(e).length)) + "</div>" +
      (state.showPendingBills ? pendingBillsPanel(e) : "");
    var processInitiated = e.type === "TI" ? !!e.closure : (e.recoupments || []).length > 0;
    var form2 = collapse("form2", "Generate Form-2 (Imprest Cash Account)", form2Inner(e, t));
    var vouchers = collapse("vouchers", "Vouchers", vouchersInner(e));
    var actionButtons = closed ? '<div class="badge badge-ok" style="margin-bottom:12px">This ' + e.type + " is closed.</div>" : e.type === "TI" ? '<button class="btn btn-danger btn-sm" id="processClose" style="margin-bottom:12px">Process Imprest Closure</button>' : '<div class="btn-row" style="margin-bottom:12px"><button class="btn btn-gold btn-sm" id="processRecoup">Process Recoupment</button><button class="btn btn-danger btn-sm" id="processPIClose">Process PI Closure (final)</button></div>';
    var canRevert = !!e.closure || (e.recoupments || []).length > 0;
    var revertBtn = canRevert ? '<button class="btn btn-ghost btn-sm" id="revertClosure" style="margin-bottom:12px">\u21ba Revert last closure / recoupment</button>' : "";
    var history = collapse("history", "Recoupment and Closure History (Reimbursement / Pending Settlement)", historyInner(e));
    return banner + summary + (closed ? "" : '<button class="btn btn-ghost btn-sm" id="makeEntry" style="margin-bottom:12px">＋ Make entry in ' + e.type + " account</button>") + '<div class="cat-head" style="margin-top:4px">Account Statement</div>' + (rows || '<div class="hint">No transactions yet.</div>') + '<div id="txnFormHost"></div>' + actionButtons + '<div id="actionFormHost"></div>' + revertBtn + form2 + vouchers + history;
  }
  function clickableStatCard(id, ic, label, v) {
    return '<div class="card stat-card stat-clickable" id="' + id + '"><div class="stat-ic">' + ic + '</div><div class="stat-val">' + esc(v) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
  }
  function pendingBillsPanel(e) {
    var list = pendingBillTxns(e);
    if (!list.length) return '<div class="card" style="margin-bottom:14px"><div class="hint">No expenses are awaiting bills in this ' + e.type + '.</div></div>';
    return '<div class="card" style="margin-bottom:14px"><div class="card-head"><h3>Expenses awaiting bills (' + list.length + ')</h3></div>' +
      list.map(function(tx) {
        return '<div class="txn exp"><div class="txn-main"><div class="txn-title">' + esc(tx.paidTo || tx.nameOfWork || "Expense") + '</div><div class="hint">' + fmtDate(tx.date) + '</div></div><div class="mono txn-amt">Rs. ' + inr(tx.amount) + '</div><span class="flag-nobill">Bill pending</span></div>';
      }).join("") + '</div>';
  }
  function renderLedger(e) {
    var all = (e.txns || []).slice().sort(function(a, b) {
      return new Date(a.date) - new Date(b.date);
    });
    var html = "";
    var cycleSeen = 1;
    html += '<div class="cycle-divider">Cycle ' + cycleSeen + "</div>";
    all.forEach(function(tx) {
      html += txnRow(e, tx);
      if (tx.recoupmentId) {
        cycleSeen++;
        html += '<div class="cycle-divider">Cycle ' + cycleSeen + " begins</div>";
      }
    });
    return html;
  }
  function historyInner(e) {
    var items = [];
    (e.recoupments || []).forEach(function(r) {
      items.push({
        kind: "recoup",
        data: r
      });
    });
    if (e.closure) items.push({
      kind: "closure",
      data: e.closure
    });
    if (!items.length) return '<div class="hint">No recoupment or closure actions yet.</div>';
    return items.map(historyItemHtml).join("");
  }
  function historyItemHtml(it) {
    if (it.kind === "closure") {
      var c = it.data;
      var label = c.kind === "return" ? "Closure — Amount Returned" : "Closure — Reimbursement";
      var badge = c.stage === "done" ? '<span class="badge badge-ok">Done</span>' : '<span class="badge badge-gold">Pending</span>';
      var body = '<div class="closure-card" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>' + label + "</b>" + badge + "</div>" + '<div class="hint">Rs. ' + inr(c.amount) + (c.stage === "done" ? " · " + fmtDate(c.date) + (c.mode === "online" ? " · UTR " + esc(c.utr || "—") : " · Cash") : "") + "</div>";
      if (c.stage !== "done" && c.kind === "reimburse") {
        body += '<button class="btn btn-primary btn-sm" id="hist_markReimbursed" style="margin-top:8px">Mark Reimbursed</button><div id="reimburseFormHost"></div>';
      }
      if (c.stage === "done") {
        body += '<button class="btn btn-ghost btn-xs" id="hist_editClosure" style="margin-top:8px">Edit closure</button><div id="editClosureFormHost"></div>';
      }
      return body + "</div>";
    }
    var r = it.data;
    if (r.final) {
      return '<div class="closure-card" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>Final settlement · ' + fmtDate(r.date) + '</b><span class="badge badge-neutral">See Closure entry</span></div>' + '<div class="hint">Overspent Rs. ' + inr(r.overspentAmount) + " — settled via the Closure reimbursement/return above.</div></div>";
    }
    var badge = r.settled === "yes" ? '<span class="badge badge-ok">Settled</span>' : r.settled === "no" ? '<span class="badge badge-bad">Not Yet Settled</span>' : '<span class="badge badge-gold">Pending Settlement</span>';
    var body = '<div class="closure-card" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>Recoupment · ' + fmtDate(r.date) + "</b>" + badge + "</div>" + '<div class="hint">Overspent settled Rs. ' + inr(r.overspentAmount) + " + Fresh Rs. " + inr(r.freshAmount) + " = Total Credit Expected Rs. " + inr(r.totalCredit) + (r.mode === "online" ? " · UTR " + esc(r.utr || "—") : " · Cash") + "</div>";
    if (r.settled === "pending") {
      body += '<div class="hint" style="margin:6px 0">Has the higher authority settled/approved this recoupment?</div>' + '<div class="btn-row"><button class="btn btn-primary btn-sm" data-settleyes="' + r.id + '">Yes — Settled</button><button class="btn btn-ghost btn-sm" data-settleno="' + r.id + '">Not Yet</button></div>';
    } else if (r.settledRemark) {
      body += '<div class="hint">Remark: ' + esc(r.settledRemark) + "</div>";
    }
    return body + "</div>";
  }
  function wireHistory(e) {
    document.querySelectorAll("[data-settleyes]").forEach(function(el) {
      el.onclick = function() {
        confirmRecoupmentSettlement(e, el.getAttribute("data-settleyes"), "yes");
      };
    });
    document.querySelectorAll("[data-settleno]").forEach(function(el) {
      el.onclick = function() {
        var remark = window.prompt("Optional remark (why not yet settled)?", "") || "";
        confirmRecoupmentSettlement(e, el.getAttribute("data-settleno"), "no", remark);
      };
    });
    byId("hist_markReimbursed", function(el) {
      el.onclick = function() {
        openReimburseForm(e);
      };
    });
    byId("hist_editClosure", function(el) {
      el.onclick = function() {
        openEditClosureForm(e);
      };
    });
  }
  function openEditClosureForm(e) {
    var host = document.getElementById("editClosureFormHost");
    if (!host) return;
    var c = e.closure;
    host.innerHTML = '<div class="field-row" style="margin-top:8px">' + f2("ec_amount", "Amount (Rs.)", c.amount) + '<div class="field"><label>Date</label><input type="date" id="ec_date" value="' + esc(c.date) + '"></div></div>' + '<div class="field"><label>Mode</label><div class="radio-pill-group"><div class="radio-pill ' + (c.mode !== "online" ? "sel" : "") + '" data-ecmode="cash">Cash</div><div class="radio-pill ' + (c.mode === "online" ? "sel" : "") + '" data-ecmode="online">Online</div></div></div>' + '<div id="ec_utrWrap" style="display:' + (c.mode === "online" ? "block" : "none") + '">' + f2("ec_utr", "UTR / Transaction No.", c.utr) + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="ec_cancel">← Back</button><button class="btn btn-primary btn-sm" id="ec_save">Save changes</button></div>';
    var mode = c.mode || "cash";
    document.querySelectorAll("[data-ecmode]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-ecmode");
        mode = el.getAttribute("data-ecmode");
        document.getElementById("ec_utrWrap").style.display = mode === "online" ? "block" : "none";
      };
    });
    byId("ec_cancel", function(el) {
      el.onclick = function() {
        host.innerHTML = "";
      };
    });
    byId("ec_save", function(el) {
      el.onclick = function() {
        c.amount = val("ec_amount").replace(/[^0-9.]/g, "");
        c.date = val("ec_date");
        c.mode = mode;
        c.utr = val("ec_utr");
        saveEntry(e);
        toast("Closure details updated.", "ok");
        host.innerHTML = "";
        render();
      };
    });
  }
  function txnRow(e, tx) {
    var thumb = tx.image ? '<img class="thumb" src="' + tx.image + '">' : "";
    if (tx.kind === "received") {
      var isRecoup = !!tx.recoupmentId;
      var title = isRecoup ? "Recoupment Credit" : "Amount Received";
      var meta = isRecoup ? "Settled overspend Rs. " + inr(tx.overspentAmount || 0) + " + Fresh Rs. " + inr(tx.freshAmount || 0) + " · " + (tx.mode === "online" ? "Online · UTR " + esc(tx.utr || "—") : "Cash") : "Amount received as " + e.type + " · " + (tx.mode === "online" ? "Online · UTR " + esc(tx.utr || "—") : "Cash");
      return '<div class="txn recv">' + thumb + '<div class="txn-main"><div class="txn-title">' + title + (isRecoup ? ' <span class="recoup-badge">Recoupment</span>' : "") + '</div><div class="hint">' + fmtDate(tx.date) + " · " + meta + "</div></div>" + '<div class="mono txn-amt">Rs. ' + inr(tx.amount) + '</div><span class="badge badge-ok">Received</span>' + (isRecoup ? "" : '<div class="txn-actions"><button class="btn btn-ghost btn-xs" data-txnedit="' + tx.id + '">Edit</button><button class="btn btn-danger btn-xs" data-txndel="' + tx.id + '">✕</button></div>') + "</div>";
    }
    var vno = displayVoucherNo(tx);
    var billYes = tx.billAvailable === "yes";
    var billLater = tx.billAvailable === "no" && tx.billStage === "later";
    var billFill = tx.billAvailable === "no" && tx.billStage === "fill";
    var meta = (tx.paid === "online" ? "Online · UTR " + esc(tx.utr || "—") : "Cash") + (billYes ? " · Bill " + esc(tx.billNo || "—") : "") + (tx.paidTo ? " · Paid to " + esc(tx.paidTo) : "");
    var right = billYes ? '<span class="badge badge-info">Expense</span>' : billLater ? '<span class="flag-nobill">Bill pending</span>' : '<span class="flag-nobill">Pavati Available</span>';
    return '<div class="txn exp">' + thumb + '<div class="txn-main"><div class="txn-title">' + esc(tx.nameOfWork || tx.paidTo || "Expense") + (vno ? ' <span class="hint">(Bill ' + esc(vno) + ")</span>" : "") + '</div><div class="hint">' + fmtDate(tx.date) + " · " + meta + "</div></div>" + '<div class="mono txn-amt">Rs. ' + inr(tx.amount) + "</div>" + right + '<div class="txn-actions"><button class="btn btn-ghost btn-xs" data-txnedit="' + tx.id + '">Edit</button><button class="btn btn-danger btn-xs" data-txndel="' + tx.id + '">✕</button></div>' + (billFill ? pavatiBlock(e, tx) : "") + "</div>";
  }
  function pavatiBlock(e, tx) {
    var pv = tx.pavati || {
      generated: false,
      personsCount: 1,
      persons: [ "" ],
      workPerformed: "",
      image: "",
      saved: false
    };
    var isOpenPav = !pv.saved || !!state.pavatiOpen[tx.id];
    if (!isOpenPav) {
      return '<div class="pavati-box pavati-collapsed" data-pavopen="' + tx.id + '">' + '<span class="badge badge-ok">Pavati ✓</span> <span class="hint">Click to view / edit</span></div>';
    }
    var persons = pv.persons && pv.persons.length ? pv.persons : [ "" ];
    var nameFields = persons.map(function(nm, i) {
      return '<div class="field"><label>Name of Person ' + (i + 1) + '</label><input class="pav-person" data-tx="' + tx.id + '" data-pidx="' + i + '" value="' + esc(nm) + '" placeholder="Full name"></div>';
    }).join("");
    return '<div class="pavati-box">' + '<div class="chk-row"><input type="checkbox" class="chk-box pav-gen" data-tx="' + tx.id + '" ' + (pv.generated ? "checked" : "") + '><div class="chk-main"><div class="chk-title">Pavati Generated</div></div></div>' + '<div class="field"><label>No. of persons who filled Pavati</label><input type="number" min="1" max="10" class="pav-count" data-tx="' + tx.id + '" value="' + (pv.personsCount || 1) + '"></div>' + '<div class="pav-names" data-tx="' + tx.id + '">' + nameFields + "</div>" + '<div class="field"><label>Work Performed</label><input class="pav-work" data-tx="' + tx.id + '" value="' + esc(pv.workPerformed || "") + '" placeholder="Describe the work performed"></div>' + '<div class="hint" style="margin-bottom:8px">Amount is intentionally left blank on the Pavati — it stays handwritten by the payee.</div>' + '<div class="field"><label>Upload Pavati Image</label><input type="file" class="pav-img" data-tx="' + tx.id + '" accept="image/*">' + (pv.image ? '<img class="thumb" style="margin-top:8px;width:60px;height:60px" src="' + pv.image + '">' : "") + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-xs" data-pavword="' + tx.id + '">Pavati (Word)</button><button class="btn btn-ghost btn-xs" data-pavpdf="' + tx.id + '">Pavati (PDF)</button><button class="btn btn-ghost btn-xs" data-pavprint="' + tx.id + '">🖶 Print Pavati</button></div>' + '<div class="btn-row" style="margin-top:8px"><button class="btn btn-ghost btn-xs" data-pavback="' + tx.id + '">← Back</button><button class="btn btn-primary btn-xs" data-pavsave="' + tx.id + '">Save Pavati</button></div>' + "</div>";
  }
  function txnForm(kind, pf) {
    pf = pf || {};
    if (kind === null) {
      return '<div class="card txn-form-card"><div class="card-head"><h3>New entry</h3></div>' + '<div class="radio-pill-group"><div class="radio-pill" data-txnkind="received">Amount Received</div><div class="radio-pill" data-txnkind="expense">Expense</div><div class="radio-pill" data-txnkind="fromlist">Select from Other Expense List</div></div></div>';
    }
    if (kind === "received") {
      return '<div class="card txn-form-card"><div class="card-head"><h3>' + (pf.id ? "Edit" : "Amount Received as") + " " + (pf.id ? "received entry" : getEntry(state.detailId).type) + "</h3></div>" + f2("tr_amount", "Amount received (Rs.)", pf.amount) + '<div class="field"><label>Date</label><input type="date" id="tr_date" value="' + esc(pf.date || todayISO()) + '"></div>' + '<div class="field"><label>Mode</label><div class="radio-pill-group"><div class="radio-pill ' + (pf.mode !== "online" ? "sel" : "") + '" data-trmode="cash">Cash</div><div class="radio-pill ' + (pf.mode === "online" ? "sel" : "") + '" data-trmode="online">Online</div></div></div>' + '<div id="tr_utrWrap" style="display:' + (pf.mode === "online" ? "block" : "none") + '">' + f2("tr_utr", "UTR / Transaction No.", pf.utr) + "</div>" + imgField("tr_img", pf.image) + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="tr_cancel">← Back</button><button class="btn btn-primary btn-sm" id="tr_save">' + (pf.id ? "Save changes" : "Save received") + "</button></div></div>";
    }
    var billYes = pf.billAvailable === "yes";
    return '<div class="card txn-form-card"><div class="card-head"><h3>' + (pf.id ? "Edit expense" : "Expense") + "</h3></div>" + '<div class="field"><label>Is a bill available?</label><div class="radio-pill-group"><div class="radio-pill ' + (!billYes ? "sel" : "") + '" data-tebill="no">No</div><div class="radio-pill ' + (billYes ? "sel" : "") + '" data-tebill="yes">Yes</div></div></div>' + '<div id="te_noBillChoice" class="field" style="display:' + (billYes ? "none" : "block") + '">' + "<label>What should happen with the bill?</label>" + '<div class="radio-pill-group"><div class="radio-pill ' + (pf.billStage !== "fill" ? "sel" : "") + '" data-tebillstage="later">Bill will be received later</div><div class="radio-pill ' + (pf.billStage === "fill" ? "sel" : "") + '" data-tebillstage="fill">Fill Pavati</div></div>' + "</div>" + '<div id="te_noBillNote" class="locked-note" style="margin-bottom:10px;display:' + (billYes ? "none" : "flex") + '">Booked as expense &amp; flagged accordingly. If you choose “Fill Pavati,” the Pavati fields will appear on this entry in the Account Statement below once saved.</div>' + f2("te_amount", "Expense amount (Rs.)", pf.amount) + '<div class="field"><label>Date</label><input type="date" id="te_date" value="' + esc(pf.date || todayISO()) + '"></div>' + '<div class="field"><label>Paid by</label><div class="radio-pill-group"><div class="radio-pill ' + (pf.paid !== "online" ? "sel" : "") + '" data-temode="cash">Cash</div><div class="radio-pill ' + (pf.paid === "online" ? "sel" : "") + '" data-temode="online">Online</div></div></div>' + '<div id="te_utrWrap" style="display:' + (pf.paid === "online" ? "block" : "none") + '">' + f2("te_utr", "UTR / Transaction No.", pf.utr) + "</div>" + f2("te_paidTo", "Amount given to / via (Name of Person)", pf.paidTo) + imgField("te_img", pf.image) + '<div id="te_billWrap" style="display:' + (billYes ? "block" : "none") + '">' + f2("te_nameWork", "Name of Work", pf.nameOfWork) + f2("te_agency", "Name of Agency", pf.agency) + f2("te_billNo", "Bill No.", pf.billNo) + f2("te_submittedBy", "Bill submitted by", pf.submittedBy) + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="te_cancel">← Back</button><button class="btn btn-primary btn-sm" id="te_save">' + (pf.id ? "Save changes" : "Save expense") + "</button></div></div>";
  }
  function f2(id, label, v) {
    return '<div class="field"><label>' + esc(label) + '</label><input id="' + id + '" value="' + esc(v || "") + '"></div>';
  }
  function imgField(id, existing) {
    return '<div class="field"><label>Image upload</label><input type="file" id="' + id + '" accept="image/*"><div id="' + id + '_prev">' + (existing ? '<img class="thumb" style="margin-top:8px;width:60px;height:60px" src="' + existing + '">' : "") + "</div></div>";
  }
  function form2Inner(e, t) {
    var d = form2Data(e), u = state.user;
    var rows = d.rows.map(function(r) {
      return "<tr><td>" + r.sno + "</td><td>" + r.monthDate + "</td><td>" + r.voucherNo + '</td><td style="text-align:left">' + esc(r.particulars) + '</td><td class="num">' + r.paymentRs + '</td><td class="num">' + r.totalRs + "</td><td></td></tr>";
    }).join("");
    var table = '<table class="form2-table"><thead><tr><th>Sr No</th><th>Month &amp; Date</th><th>Voucher No</th><th>Transactions</th><th>Amount of<br>Cash Payment (Rs)</th><th>Total (Rs)</th><th>Head of<br>Account (SAP)</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="hint" style="text-align:center;padding:14px">No transactions logged yet.</td></tr>') + '</tbody><tfoot><tr><td colspan="3"></td><td style="text-align:right;font-weight:700">Total Rs. =</td><td class="num" style="font-weight:700">' + d.totalPayment + '</td><td class="num" style="font-weight:700">' + d.totalReceipt + "</td><td></td></tr></tfoot></table>";
    var accountsList = '<datalist id="refundAcctList">' + (u.refundAccounts || []).map(function(a) {
      return '<option value="' + esc(a) + '">';
    }).join("") + "</datalist>";
    var settleField = t.balance >= 0 ? '<div class="field-row">' + f2v("f2_paidback", "Amount to be Paid Back (Rs.)", d.paidBack) + '<div class="field"><label>Refund Account No.</label><input id="f2_acct" list="refundAcctList" value="' + esc(d.refundAccount) + '"><div class="hint">Previously used accounts are suggested as you type.</div></div>' + "</div>" + '<div class="field-row">' + f2v("f2_utr", "Refund UTR / Transaction No.", d.refundUTR) + '<div class="field"><label>Refund Date</label><input type="date" id="f2_rdate" value="' + esc(d.refundDate) + '"></div></div>' + accountsList : '<div class="field-row">' + f2v("f2_paidback", "Extra Amount Paid from Pocket (Rs.)", d.paidBack) + "</div>" + '<div class="locked-note" style="margin-bottom:12px">Kindly reimburse the same.</div>' + f2v("f2_utr", "Reimbursement UTR / Transaction No.", d.refundUTR);
    var fields = '<div class="field-row">' + f2v("f2_sap", "SAP No.", d.sap) + f2v("f2_cpf", "CPF No.", d.cpf) + f2v("f2_pmo", "PMO No. (optional)", d.pmo) + "</div>" + '<div class="field-row"><div class="field"><label>Period from</label><input type="date" id="f2_from" value="' + esc(d.dateFrom) + '"></div><div class="field"><label>Period to</label><input type="date" id="f2_to" value="' + esc(d.dateTo) + '"></div></div>' + settleField + '<div class="btn-row" style="margin-bottom:14px"><button class="btn btn-ghost btn-sm" id="f2_back">← Back</button><button class="btn btn-primary btn-sm" id="f2_save">Save Form-2 details</button></div>';
    return fields + '<div class="stat-label" style="margin:4px 0 6px">Live Preview</div><div class="form2-scroll">' + table + "</div>" + '<div class="btn-row" style="margin-top:14px">' + '<button class="btn btn-gold btn-sm" id="f2_excel">⬇ Excel (.xlsx)</button>' + '<button class="btn btn-ghost btn-sm" id="f2_pdf">⬇ PDF</button>' + '<button class="btn btn-ghost btn-sm" id="f2_word">⬇ Word (.docx)</button>' + '<button class="btn btn-ghost btn-sm" id="f2_preview">👁 Preview Form-2</button>' + '<button class="btn btn-ghost btn-sm" id="f2_print">🖶 Print</button>' + "</div>" + '<div id="f2PreviewHost"></div>';
  }
  function f2v(id, label, v) {
    return '<div class="field"><label>' + esc(label) + '</label><input id="' + id + '" value="' + esc(v == null ? "" : v) + '"></div>';
  }
  function renderProfile() {
    var p = state.user;
    var isAdm = state.isAdmin;
    var accountCard = '<div class="card" style="max-width:720px"><div class="card-head"><h3>Account &amp; security</h3></div>' +
      '<div class="hint" style="margin-bottom:12px">' + (isAdm ? "As admin you can change any employee\u2019s username or password from the Employees page." : "Change your own username or password here.") + '</div>' +
      '<div class="field-row">' + f("ac_newuser", "New username (leave blank to keep)", "") + f("ac_newpass", "New password (leave blank to keep)", "") + '</div>' +
      '<button class="btn btn-ghost btn-sm" id="saveCredentials">Update credentials</button></div>';
    if (isAdm) {
      return shell(accountCard, "My Profile", "Administrator account.");
    }
    var body = '<div class="card" style="max-width:720px">' +
      (!profileComplete(p) ? '<div class="locked-note" style="margin-bottom:14px">Complete your details before creating an entry.</div>' : "") +
      '<div class="card-head"><h3>Your details</h3></div>' +
      '<div class="field-row">' + f("pf_name", "Full name", p.name) + f("pf_desig", "Designation", p.designation) + "</div>" +
      f("pf_letter", "Letter Ref. Prefix", p.letterNo || DEFAULT_REF_PREFIX) +
      '<div class="field-row">' + f("pf_sap", "SAP No.", p.sapNo) + f("pf_cpf", "CPF No.", p.cpfNo) + "</div>" +
      '<div class="card-head" style="margin-top:8px"><h3>Reporting officer</h3></div>' +
      f("pf_bname", "Boss's name", p.bossName) +
      '<div class="field-row">' + f("pf_bdesig", "Boss's designation", p.bossDesignation) + f("pf_boffice", "Boss's office", p.bossOffice) + "</div>" +
      f("pf_borg", "Boss's organisation", p.bossOrg) +
      '<div class="field"><label>Salutation</label><select id="pf_salut"><option value="Sir"' + (p.bossSalutation !== "Madam" ? " selected" : "") + '>Respected Sir,</option><option value="Madam"' + (p.bossSalutation === "Madam" ? " selected" : "") + ">Respected Madam,</option></select></div>" +
      '<button class="btn btn-primary btn-block" id="saveProfile">Save profile</button>' + "</div>" +
      accountCard +
      '<div style="max-width:720px">' + collapse("pfletter", "Letter Preview", '<div id="pfLetterHost" class="letter-scale-outer">' + letterSheet(p, previewEntry(p)) + "</div>") + "</div>";
    return shell(body, "My Profile", "Saved once, reused on every letter.");
  }
  function previewEntry(p) {
    return {
      type: "TI",
      letter: {
        refPrefix: p.letterNo,
        refNumber: "",
        refDate: todayISO(),
        sendingAddress: "",
        bodyHtml: "",
        attachments: []
      },
      subject: "",
      amount: ""
    };
  }
  function otherExpensesList() {
    var list = state.otherExpenses.slice();
    list.sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    return list;
  }
  function loadOtherExpenses() {
    if (!state.user) { state.otherExpenses = []; return Promise.resolve(); }
    return apiGet("listOtherExpenses", { username: state.user.username }).then(function(res) {
      state.otherExpenses = res.ok ? res.expenses : [];
      if (!res.ok) toast("Could not load other expenses: " + (res.error || "unknown error"), "err");
    });
  }
  function saveOtherExpense(exp) {
    var idx = state.otherExpenses.findIndex(function(x) { return x.id === exp.id; });
    if (idx === -1) state.otherExpenses.unshift(exp); else state.otherExpenses[idx] = exp;
    var payload = Object.assign({}, exp); delete payload._owner;
    apiPost("saveOtherExpense", { username: ownerOf(exp), expense: payload }).then(function(res) {
      if (!res.ok) toast("Could not sync to server: " + (res.error || "unknown error"), "err");
    });
  }
  function deleteOtherExpense(id) {
    var rec = state.otherExpenses.filter(function(x) { return x.id === id; })[0];
    var owner = ownerOf(rec);
    state.otherExpenses = state.otherExpenses.filter(function(x) { return x.id !== id; });
    apiPost("deleteOtherExpense", { username: owner, id: id }).then(function(res) {
      if (!res.ok) toast("Could not sync delete to server: " + (res.error || "unknown error"), "err");
    });
  }
  function renderOtherExpenses() {
    var list = otherExpensesList();
    var pending = list.filter(function(x) { return x.billAvailable === "no" && x.billStage === "later"; });
    var total = list.reduce(function(sum, x) { return sum + (parseFloat(x.amount) || 0); }, 0);
    var cards = '<div class="grid grid-4" style="margin-bottom:18px">' +
      statCard("\u20b9", "Total expense (without advance)", "Rs. " + inr(total)) +
      clickableStatCard("otherPendingCard", "\u2691", "Pending Bills", String(pending.length)) +
      statCard("\u2211", "Entries", String(list.length)) +
      "</div>";
    var pendingPanel = state.showOtherPendingBills ? (pending.length
      ? '<div class="card" style="margin-bottom:14px"><div class="card-head"><h3>Expenses awaiting bills (' + pending.length + ')</h3></div>' +
        pending.map(function(exp) { return otherExpenseRow(exp); }).join("") + "</div>"
      : '<div class="card" style="margin-bottom:14px"><div class="hint">No standalone expenses are awaiting bills.</div></div>') : "";
    var rows = list.length ? list.map(function(exp) {
      return otherExpenseRow(exp);
    }).join("") : '<div class="empty-state"><div class="ic">\u26c1</div>No standalone expenses yet. Use these for spending that happened before any TI/PI was received \u2014 you can pull them into a TI or PI\u2019s Account Statement later via "Select from Other Expense List."</div>';
    var body = cards + pendingPanel + '<div class="card">' + '<button class="btn btn-gold btn-sm" id="addOtherExp" style="margin-bottom:14px">\uff0b Add expense</button>' + '<div id="otherExpFormHost"></div>' + rows + "</div>";
    return shell(body, "Other Expenses", "Expenses spent without any TI/PI advance in hand yet \u2014 link them to a TI/PI later.");
  }
  function otherExpenseRow(exp) {
    var thumb = exp.image ? '<img class="thumb" src="' + exp.image + '">' : "";
    var billYes = exp.billAvailable === "yes";
    var right = billYes ? '<span class="badge badge-info">Bill available</span>' : exp.billStage === "fill" ? '<span class="flag-nobill">Pavati Available</span>' : '<span class="flag-nobill">Bill pending</span>';
    var meta = (exp.paid === "online" ? "Online · UTR " + esc(exp.utr || "—") : "Cash") + (billYes ? " · Bill " + esc(exp.billNo || "—") : "") + (exp.paidTo ? " · Paid to " + esc(exp.paidTo) : "");
    return '<div class="txn exp"><div class="txn-main">' + thumb + '<div class="txn-title">' + esc(exp.nameOfWork || exp.paidTo || "Expense") + '</div><div class="hint">' + fmtDate(exp.date) + " · " + meta + "</div></div>" + '<div class="mono txn-amt">Rs. ' + inr(exp.amount) + "</div>" + right + '<div class="txn-actions"><button class="btn btn-danger btn-xs" data-otherdel="' + exp.id + '">✕</button></div></div>';
  }
  function wireOtherExpenses() {
    byId("otherPendingCard", function(el) {
      el.onclick = function() { state.showOtherPendingBills = !state.showOtherPendingBills; render(); };
    });
    byId("addOtherExp", function(el) {
      el.onclick = function() {
        renderOtherExpForm();
      };
    });
    document.querySelectorAll("[data-otherdel]").forEach(function(el) {
      el.onclick = function() {
        if (!confirm("Delete this standalone expense?")) return;
        deleteOtherExpense(el.getAttribute("data-otherdel"));
        render();
      };
    });
  }
  var otherExpDraft = {};
  function renderOtherExpForm() {
    var host = document.getElementById("otherExpFormHost");
    if (!host) return;
    otherExpDraft = {
      bill: "no",
      billStage: "later",
      paid: "cash"
    };
    host.innerHTML = '<div class="card txn-form-card"><div class="card-head"><h3>New standalone expense</h3></div>' + '<div class="field"><label>Is a bill available?</label><div class="radio-pill-group"><div class="radio-pill sel" data-oebill="no">No</div><div class="radio-pill" data-oebill="yes">Yes</div></div></div>' + '<div id="oe_noBillChoice" class="field"><label>What should happen with the bill?</label>' + '<div class="radio-pill-group"><div class="radio-pill sel" data-oebillstage="later">Bill will be received later</div><div class="radio-pill" data-oebillstage="fill">Fill Pavati</div></div></div>' + f2("oe_paidTo", "Amount given to / via (Name of Person)", "") + f2("oe_amount", "Expense amount (Rs.)", "") + '<div class="field"><label>Date</label><input type="date" id="oe_date" value="' + todayISO() + '"></div>' + '<div class="field"><label>Paid by</label><div class="radio-pill-group"><div class="radio-pill sel" data-oemode="cash">Cash</div><div class="radio-pill" data-oemode="online">Online</div></div></div>' + '<div id="oe_utrWrap" style="display:none">' + f2("oe_utr", "UTR / Transaction No.", "") + "</div>" + imgField("oe_img") + '<div id="oe_billWrap" style="display:none">' + f2("oe_nameWork", "Name of Work", "") + f2("oe_agency", "Name of Agency", "") + f2("oe_billNo", "Bill No.", "") + f2("oe_submittedBy", "Bill submitted by", "") + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="oe_cancel">← Back</button><button class="btn btn-primary btn-sm" id="oe_save">Save expense</button></div></div>';
    document.querySelectorAll("[data-oebill]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-oebill");
        otherExpDraft.bill = el.getAttribute("data-oebill");
        var yes = otherExpDraft.bill === "yes";
        document.getElementById("oe_billWrap").style.display = yes ? "block" : "none";
        document.getElementById("oe_noBillChoice").style.display = yes ? "none" : "block";
      };
    });
    document.querySelectorAll("[data-oebillstage]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-oebillstage");
        otherExpDraft.billStage = el.getAttribute("data-oebillstage");
      };
    });
    document.querySelectorAll("[data-oemode]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-oemode");
        otherExpDraft.paid = el.getAttribute("data-oemode");
        document.getElementById("oe_utrWrap").style.display = otherExpDraft.paid === "online" ? "block" : "none";
      };
    });
    wireImg("oe_img");
    byId("oe_cancel", function(el) {
      el.onclick = function() {
        host.innerHTML = "";
      };
    });
    byId("oe_save", function(el) {
      el.onclick = function() {
        var amt = val("oe_amount").replace(/[^0-9.]/g, "");
        if (!amt) {
          toast("Enter amount.", "err");
          return;
        }
        var bill = otherExpDraft.bill || "no";
        var exp = {
          id: uid(),
          amount: amt,
          date: val("oe_date"),
          paidTo: val("oe_paidTo"),
          paid: otherExpDraft.paid || "cash",
          utr: val("oe_utr"),
          image: imgData["oe_img"] || "",
          billAvailable: bill,
          billStage: bill === "no" ? otherExpDraft.billStage || "later" : "",
          nameOfWork: bill === "yes" ? val("oe_nameWork") : "",
          agency: bill === "yes" ? val("oe_agency") : "",
          billNo: bill === "yes" ? val("oe_billNo") : "",
          submittedBy: bill === "yes" ? val("oe_submittedBy") : "",
          pavati: {
            generated: false,
            personsCount: 1,
            persons: [ "" ],
            workPerformed: "",
            image: ""
          }
        };
        saveOtherExpense(exp);
        toast("Standalone expense saved.", "ok");
        render();
      };
    });
  }
  function letterSheet(p, e) {
    var L = e.letter || e;
    var bd = p.bossDesignation || "[ Boss's designation ]", bo = p.bossOffice || "[ Boss's office ]", bg = p.bossOrg || "MSETCL";
    var atts = (L.attachments || []).filter(Boolean);
    var salut = p.bossSalutation === "Madam" ? "Madam" : "Sir";
    var body = L.bodyHtml ? '<div class="lt-para">' + L.bodyHtml + "</div>" : '<div class="lt-para lt-ghost">[ Letter body ]</div>';
    return '<div class="letter-page"><div class="lt-org">MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LTD.</div><div class="lt-iso">An ISO 9001:2000 CERTIFIED ORGANISATION</div>' + (L.sendingAddress ? '<div class="lt-send">' + esc(L.sendingAddress) + "</div>" : "") + '<div class="lt-ref"><span>' + esc(L.refPrefix || "Ref. [ Prefix ] No.") + " " + esc(L.refNumber || "__") + "</span><span>Date: " + fmtDate(L.refDate) + "</span></div>" + '<div class="lt-to">To,<br>The ' + esc(bd) + ",<br>" + esc(bo) + "<br>" + esc(bg) + "</div>" + '<div class="lt-sub"><b>Sub:</b>&nbsp;&nbsp;' + esc(e.subject || (e.type || "TI") + " Application of Rs [amount] for [purpose].") + "</div>" + '<div class="lt-salut">Respected ' + salut + ',</div><div class="lt-body">' + body + "</div>" + (atts.length ? '<div class="lt-encl"><b>Encl:</b><ol>' + atts.map(function(a) {
      return "<li>" + esc(a) + "</li>";
    }).join("") + "</ol></div>" : "") + '<div class="lt-emp"><div style="font-weight:700">' + esc(p.name || "[ Your name ]") + "</div><div>" + esc(p.designation || "[ Your designation ]") + "</div></div>" + '<div class="lt-rec"><div style="font-weight:700">Recommended By,</div><div style="height:18px"></div><div style="font-weight:700">' + esc(p.bossName || "[ Boss's name ]") + "</div><div>" + esc(bd) + "</div><div>" + esc(bo) + "</div><div>" + esc(bg) + "</div></div></div>";
  }
  function fitLetterPages() {
    document.querySelectorAll(".letter-scale-outer").forEach(function(wrap) {
      var page = wrap.querySelector(".letter-page");
      if (!page) return;
      page.style.transform = "none";
      var avail = wrap.clientWidth;
      var scale = Math.min(1, avail / 794);
      page.style.transform = "scale(" + scale + ")";
      page.style.transformOrigin = "top left";
      wrap.style.height = page.scrollHeight * scale + "px";
    });
  }
  window.addEventListener("resize", function() {
    fitLetterPages();
  });
  function render() {
    var app = document.getElementById("app");
    var html;
    if (state.screen === "auth") html = renderAuth(); else if (state.screen === "admin") html = shell(renderAdminInner(), "Employees", "Approve, revoke or remove accounts."); else if (state.screen === "create") html = renderCreate(); else if (state.screen === "detail") html = renderDetail(); else if (state.screen === "profile") html = renderProfile(); else if (state.screen === "otherexp") html = renderOtherExpenses(); else html = renderHome();
    app.innerHTML = html + renderModal() + (state.loading ? '<div class="loading-overlay"><div class="loading-spinner"></div></div>' : "");
    wire();
    byId("modalOk", function(el) {
      el.onclick = function() {
        state.modal = null;
        render();
      };
    });
    setTimeout(fitLetterPages, 0);
  }
  function wire() {
    wireAtmosControls();
    if (state.screen === "auth") {
      wireAuth();
      return;
    }
    byId("logoutPill", function(el) {
      el.onclick = doLogout;
    });
    byId("sideToggle", function(el) {
      el.onclick = function() {
        state.sideCollapsed = !state.sideCollapsed;
        render();
      };
    });
    document.querySelectorAll("[data-nav]").forEach(function(el) {
      el.onclick = function() {
        var target = el.getAttribute("data-nav");
        state.screen = target;
        if (target === "admin") { loadAdminEmployees().then(render); return; }
        render();
      };
    });
    byId("navCreate", function(el) {
      el.onclick = startCreate;
    });
    if (state.screen === "create") {
      wireCreate();
      return;
    }
    if (state.screen === "detail") {
      wireDetail();
      return;
    }
    if (state.screen === "profile") {
      wireProfile();
      return;
    }
    if (state.screen === "otherexp") {
      wireOtherExpenses();
      return;
    }
    if (state.screen === "admin") {
      wireAdminPanel();
      return;
    }
    wireHome();
  }
  function wireAuth() {
    document.querySelectorAll(".tab[data-tab]").forEach(function(el) {
      el.onclick = function() {
        state.authTab = el.getAttribute("data-tab");
        state.error = "";
        render();
      };
    });
    byId("authSubmit", function(el) {
      el.onclick = function() {
        var u = val("au_user"), pw = val("au_pass");
        if (state.authTab === "register") doRegister(u, pw); else doLogin(u, pw);
      };
    });
    byId("au_pass", function(el) {
      el.onkeydown = function(ev) {
        if (ev.key === "Enter") document.getElementById("authSubmit").click();
      };
    });
  }
  function wireHome() {
    document.querySelectorAll("[data-scope]").forEach(function(el) {
      el.onclick = function() {
        state.scope = el.getAttribute("data-scope");
        render();
      };
    });
    byId("createBtn2", function(el) {
      el.onclick = startCreate;
    });
    document.querySelectorAll("[data-open]").forEach(function(el) {
      el.onclick = function() {
        state.detailId = el.getAttribute("data-open");
        state.screen = "detail";
        state.open = {
          prep: false
        };
        render();
      };
    });
    document.querySelectorAll("[data-copy]").forEach(function(el) {
      el.onclick = function(ev) {
        ev.stopPropagation();
        copyEntry(el.getAttribute("data-copy"));
      };
    });
    document.querySelectorAll("[data-del]").forEach(function(el) {
      el.onclick = function(ev) {
        ev.stopPropagation();
        delEntry(el.getAttribute("data-del"));
      };
    });
  }
  function startCreate() {
    if (!profileComplete(state.user)) {
      state.screen = "profile";
      toast("Complete your profile first.", "warn");
      render();
      return;
    }
    state.createStep = {
      type: "TI",
      amount: "",
      subject: ""
    };
    state.error = "";
    state.screen = "create";
    render();
  }
  function wireCreate() {
    document.querySelectorAll("[data-ctype]").forEach(function(el) {
      el.onclick = function() {
        state.createStep.type = el.getAttribute("data-ctype");
        state.createStep.amount = val("cr_amount");
        state.createStep.subject = val("cr_subject");
        render();
      };
    });
    byId("cr_save", function(el) {
      el.onclick = function() {
        var amount = val("cr_amount").replace(/[^0-9.]/g, ""), subject = val("cr_subject").trim();
        if (!amount) {
          state.error = "Enter an amount.";
          render();
          return;
        }
        if (!subject) {
          state.error = "Enter a purpose / subject.";
          render();
          return;
        }
        var e = newEntry(state.createStep.type, amount, subject);
        e.status = "Draft";
        saveEntry(e);
        state.detailId = e.id;
        state.screen = "detail";
        state.open = {
          prep: false
        };
        state.error = "";
        toast(state.createStep.type + " created.", "ok");
        render();
      };
    });
    byId("cr_cancel", function(el) {
      el.onclick = function() {
        state.screen = "home";
        state.error = "";
        render();
      };
    });
  }
  function copyEntry(id) {
    var e = getEntry(id);
    if (!e) return;
    var c = newEntry(e.type, e.amount, e.subject);
    c.letter.refPrefix = e.letter.refPrefix;
    c.letter.sendingAddress = e.letter.sendingAddress;
    c.letter.bodyHtml = e.letter.bodyHtml;
    c.letter.attachments = e.letter.attachments.slice();
    saveEntry(c);
    toast("Copied letter format — fresh record.", "ok");
    render();
  }
  function delEntry(id) {
    if (!confirm("Delete this entry?")) return;
    var rec = state.entries.filter(function(e) { return e.id === id; })[0];
    var owner = ownerOf(rec);
    state.entries = state.entries.filter(function(e) { return e.id !== id; });
    apiPost("deleteEntry", { username: owner, id: id }).then(function(res) {
      if (!res.ok) toast("Could not sync delete to server: " + (res.error || "unknown error"), "err");
    });
    toast("Deleted.", "ok");
    render();
  }
  function wireProfile() {
    document.querySelectorAll("[data-coll]").forEach(function(el) {
      el.onclick = function() {
        var k = el.getAttribute("data-coll");
        readProfileFields();
        state.open[k] = !state.open[k];
        render();
      };
    });
    byId("saveCredentials", function(el) {
      el.onclick = function() {
        var nu = val("ac_newuser").trim(), np = val("ac_newpass").trim();
        if (!nu && !np) { toast("Enter a new username or password.", "err"); return; }
        state.loading = true; render();
        apiPost("changeCredentials", { username: state.user.username, newUsername: nu, newPassword: np }).then(function(res) {
          state.loading = false;
          if (!res.ok) { toast(res.error || "Could not update credentials.", "err"); render(); return; }
          if (nu) state.user.username = nu;
          toast("Credentials updated." + (nu ? " Use your new username next time." : ""), "ok");
          render();
        });
      };
    });
    byId("saveProfile", function(el) {
      el.onclick = function() {
        readProfileFields();
        state.loading = true; render();
        apiPost("saveEmployee", { profile: state.user }).then(function(res) {
          state.loading = false;
          if (!res.ok) { toast("Could not save profile: " + (res.error || "unknown error"), "err"); render(); return; }
          state.user = res.profile;
          toast("Profile saved.", "ok");
          render();
        });
      };
    });
    [ "pf_name", "pf_desig", "pf_office", "pf_letter", "pf_bname", "pf_bdesig", "pf_boffice", "pf_borg" ].forEach(function(id) {
      byId(id, function(el) {
        el.oninput = updateProfilePreview;
      });
    });
    byId("pf_salut", function(el) {
      el.onchange = updateProfilePreview;
    });
  }
  function readProfileFields() {
    var p = state.user;
    if (!document.getElementById("pf_name")) return;
    p.name = val("pf_name");
    p.designation = val("pf_desig");
    p.letterNo = val("pf_letter");
    p.sapNo = val("pf_sap");
    p.cpfNo = val("pf_cpf");
    p.bossName = val("pf_bname");
    p.bossDesignation = val("pf_bdesig");
    p.bossOffice = val("pf_boffice");
    p.bossOrg = val("pf_borg");
    p.bossSalutation = val("pf_salut");
  }
  function updateProfilePreview() {
    readProfileFields();
    var host = document.getElementById("pfLetterHost");
    if (host) {
      host.innerHTML = letterSheet(state.user, previewEntry(state.user));
      fitLetterPages();
    }
  }
  function wireDetail() {
    var e = getEntry(state.detailId);
    byId("backHome", function(el) {
      el.onclick = function() {
        state.screen = "home";
        render();
      };
    });
    byId("d_saveHead", function(el) {
      el.onclick = function() {
        e.amount = val("d_amount").replace(/[^0-9.]/g, "");
        e.subject = val("d_subject");
        saveEntry(e);
        toast("Saved.", "ok");
        render();
      };
    });
    document.querySelectorAll("[data-coll]").forEach(function(el) {
      el.onclick = function() {
        var k = el.getAttribute("data-coll");
        readLetterFields(e);
        syncEditors(e);
        state.open[k] = !state.open[k];
        render();
      };
    });
    hydrateEditors(e.letter.bodyHtml);
    wireRichToolbars(e);
    [ "l_prefix", "l_num", "l_date", "l_addr" ].forEach(function(id) {
      byId(id, function(el) {
        el.oninput = function() {
          readLetterFields(e);
          refreshPreview(e);
        };
      });
    });
    byId("addAtt", function(el) {
      el.onclick = function() {
        readLetterFields(e);
        syncEditors(e);
        if (e.letter.attachments.length < 5) {
          e.letter.attachments.push("");
          saveEntry(e);
          render();
        }
      };
    });
    document.querySelectorAll(".att-input").forEach(function(el) {
      el.oninput = function() {
        e.letter.attachments[parseInt(el.getAttribute("data-attidx"), 10)] = el.value;
        refreshPreview(e);
      };
    });
    document.querySelectorAll(".att-del").forEach(function(el) {
      el.onclick = function() {
        readLetterFields(e);
        syncEditors(e);
        e.letter.attachments.splice(parseInt(el.getAttribute("data-attdel"), 10), 1);
        saveEntry(e);
        render();
      };
    });
    byId("l_save", function(el) {
      el.onclick = function() {
        readLetterFields(e);
        syncEditors(e);
        if (e.status === "Draft") e.status = "Sent";
        saveEntry(e);
        toast("Application saved.", "ok");
        render();
      };
    });
    byId("prep_back", function(el) {
      el.onclick = function() {
        state.open.prep = false;
        render();
      };
    });
    byId("dlWord", function(el) {
      el.onclick = function() {
        downloadLetterWord(e);
      };
    });
    byId("dlPdf", function(el) {
      el.onclick = function() {
        downloadLetterPdf(e);
      };
    });
    byId("dlPrint", function(el) {
      el.onclick = function() {
        printLetter(e);
      };
    });
    wireStatus(e);
    wireAccounts(e);
    wireHistory(e);
    wireForm2(e);
    wireVouchers(e);
  }
  function hydrateEditors(bodyHtml) {
    var ed = document.getElementById("l_body");
    if (ed && ed.innerHTML !== (bodyHtml || "")) ed.innerHTML = bodyHtml || "";
  }
  function syncEditors(e) {
    var ed = document.getElementById("l_body");
    if (ed) e.letter.bodyHtml = ed.innerHTML;
  }
  function readLetterFields(e) {
    var L = e.letter;
    if (document.getElementById("l_prefix")) L.refPrefix = val("l_prefix");
    if (document.getElementById("l_num")) L.refNumber = val("l_num");
    if (document.getElementById("l_date")) L.refDate = val("l_date");
    if (document.getElementById("l_addr")) L.sendingAddress = val("l_addr");
  }
  function refreshPreview(e) {
    var host = document.getElementById("letterPreview");
    if (host) {
      host.innerHTML = letterSheet(state.user, e);
      fitLetterPages();
    }
  }
  function wireRichToolbars(e) {
    document.querySelectorAll(".rt-editor").forEach(function(ed) {
      ed.oninput = function() {
        syncEditors(e);
        refreshPreview(e);
      };
    });
    document.querySelectorAll(".rt-toolbar[data-for]").forEach(function(tb) {
      var tid = tb.getAttribute("data-for");
      tb.querySelectorAll(".rt-btn[data-cmd]").forEach(function(b) {
        b.onmousedown = function(ev) {
          ev.preventDefault();
          var ed = document.getElementById(tid);
          ed.focus();
          var cmd = b.getAttribute("data-cmd");
          if (cmd === "reset") {
            document.execCommand("removeFormat", false, null);
            document.execCommand("foreColor", false, "#101826");
          } else document.execCommand(cmd, false, null);
          syncEditors(e);
          refreshPreview(e);
        };
      });
      var fontSel = tb.querySelector(".rt-font");
      if (fontSel) {
        fontSel.onchange = function() {
          var ed = document.getElementById(tid);
          ed.focus();
          document.execCommand("fontName", false, fontSel.value);
          syncEditors(e);
          refreshPreview(e);
        };
      }
      var sizeSel = tb.querySelector(".rt-size");
      if (sizeSel) {
        sizeSel.onchange = function() {
          var ed = document.getElementById(tid);
          ed.focus();
          applyFontSize(ed, sizeSel.value);
          syncEditors(e);
          refreshPreview(e);
        };
      }
    });
    document.querySelectorAll(".rt-toolbar2[data-for]").forEach(function(tb) {
      var tid = tb.getAttribute("data-for");
      tb.querySelectorAll(".rt-color").forEach(function(c) {
        c.onmousedown = function(ev) {
          ev.preventDefault();
          var ed = document.getElementById(tid);
          ed.focus();
          document.execCommand("foreColor", false, c.getAttribute("data-color"));
          syncEditors(e);
          refreshPreview(e);
        };
      });
      tb.querySelectorAll(".rt-hicolor").forEach(function(c) {
        c.onmousedown = function(ev) {
          ev.preventDefault();
          var ed = document.getElementById(tid);
          ed.focus();
          var col = c.getAttribute("data-hicolor");
          try {
            document.execCommand("hiliteColor", false, col);
          } catch (_e) {
            document.execCommand("backColor", false, col);
          }
          syncEditors(e);
          refreshPreview(e);
        };
      });
    });
  }
  function wireStatus(e) {
    var a = e.appStatus;
    document.querySelectorAll("[data-rec]").forEach(function(el) {
      el.onclick = function() {
        a.recommended = el.getAttribute("data-rec");
        saveEntry(e);
        render();
      };
    });
    document.querySelectorAll("[data-cred]").forEach(function(el) {
      el.onclick = function() {
        a.credited = el.getAttribute("data-cred");
        if (a.credited === "yes") {
          state.open.accounts = true;
          e.status = "Open";
        }
        saveEntry(e);
        render();
      };
    });
    byId("st_save", function(el) {
      el.onclick = function() {
        a.submitted = document.getElementById("st_submitted").checked;
        a.submittedRemark = val("st_submittedRemark");
        if (document.getElementById("st_recAmount")) a.recAmount = val("st_recAmount");
        a.recRemark = val("st_recRemark");
        a.sentToAccounts = document.getElementById("st_sent").checked;
        a.sentRemark = val("st_sentRemark");
        a.creditRemark = val("st_creditRemark");
        if (a.submitted && e.status === "Draft") e.status = "Sent";
        if (a.sentToAccounts) e.status = "Sent to Accounts";
        if (a.credited === "yes") e.status = "Open";
        saveEntry(e);
        toast("Status saved.", "ok");
        render();
      };
    });
  }
  var txnMode = null, txnDraft = {};
  function wireAccounts(e) {
    byId("makeEntry", function(el) {
      el.onclick = function() {
        txnMode = null;
        editTxnId = null;
        renderTxnForm(e);
      };
    });
    document.querySelectorAll("[data-txndel]").forEach(function(el) {
      el.onclick = function() {
        var id = el.getAttribute("data-txndel");
        e.txns = e.txns.filter(function(x) {
          return x.id !== id;
        });
        if (e.txns.length === 0) e.status = "Open";
        saveEntry(e);
        render();
      };
    });
    document.querySelectorAll("[data-txnedit]").forEach(function(el) {
      el.onclick = function() {
        openEditTxn(e, el.getAttribute("data-txnedit"));
      };
    });
    document.querySelectorAll("[data-pavword]").forEach(function(el) {
      el.onclick = function() {
        downloadPavatiWord(e, findTxn(e, el.getAttribute("data-pavword")));
      };
    });
    document.querySelectorAll("[data-pavpdf]").forEach(function(el) {
      el.onclick = function() {
        downloadPavatiPdf(e, findTxn(e, el.getAttribute("data-pavpdf")));
      };
    });
    document.querySelectorAll("[data-pavprint]").forEach(function(el) {
      el.onclick = function() {
        printPavati(e, findTxn(e, el.getAttribute("data-pavprint")));
      };
    });
    document.querySelectorAll(".pav-gen").forEach(function(el) {
      el.onchange = function() {
        var tx = findTxn(e, el.getAttribute("data-tx"));
        ensurePavati(tx);
        tx.pavati.generated = el.checked;
        saveEntry(e);
      };
    });
    document.querySelectorAll(".pav-count").forEach(function(el) {
      el.onchange = function() {
        var tx = findTxn(e, el.getAttribute("data-tx"));
        ensurePavati(tx);
        var n = Math.max(1, Math.min(10, parseInt(el.value, 10) || 1));
        tx.pavati.personsCount = n;
        var arr = tx.pavati.persons || [];
        while (arr.length < n) arr.push("");
        tx.pavati.persons = arr.slice(0, n);
        saveEntry(e);
        render();
      };
    });
    document.querySelectorAll(".pav-person").forEach(function(el) {
      el.oninput = function() {
        var tx = findTxn(e, el.getAttribute("data-tx"));
        ensurePavati(tx);
        tx.pavati.persons[parseInt(el.getAttribute("data-pidx"), 10)] = el.value;
        saveEntry(e);
      };
    });
    document.querySelectorAll(".pav-work").forEach(function(el) {
      el.oninput = function() {
        var tx = findTxn(e, el.getAttribute("data-tx"));
        ensurePavati(tx);
        tx.pavati.workPerformed = el.value;
        saveEntry(e);
      };
    });
    document.querySelectorAll(".pav-img").forEach(function(el) {
      el.onchange = function() {
        var tx = findTxn(e, el.getAttribute("data-tx"));
        var file = el.files[0];
        if (!file) return;
        var r = new FileReader;
        r.onload = function() {
          ensurePavati(tx);
          tx.pavati.image = r.result;
          saveEntry(e);
          render();
        };
        r.readAsDataURL(file);
      };
    });
    document.querySelectorAll("[data-pavsave]").forEach(function(el) {
      el.onclick = function() {
        var id = el.getAttribute("data-pavsave");
        var tx = findTxn(e, id);
        ensurePavati(tx);
        tx.pavati.saved = true;
        state.pavatiOpen[id] = false;
        saveEntry(e);
        toast("Pavati saved — ready for the next expense.", "ok");
        render();
      };
    });
    document.querySelectorAll("[data-pavback]").forEach(function(el) {
      el.onclick = function() {
        var id = el.getAttribute("data-pavback");
        var tx = findTxn(e, id);
        if (tx.pavati && tx.pavati.saved) {
          state.pavatiOpen[id] = false;
          render();
        } else {
          toast("Save or the entry stays open.", "warn");
        }
      };
    });
    document.querySelectorAll("[data-pavopen]").forEach(function(el) {
      el.onclick = function() {
        var id = el.getAttribute("data-pavopen");
        state.pavatiOpen[id] = true;
        render();
      };
    });
    byId("processClose", function(el) {
      el.onclick = function() {
        openClosureForm(e, "close");
      };
    });
    byId("processRecoup", function(el) {
      el.onclick = function() {
        openClosureForm(e, "recoup");
      };
    });
    byId("processPIClose", function(el) {
      el.onclick = function() {
        openClosureForm(e, "piclose");
      };
    });
    byId("pendingBillsCard", function(el) {
      el.onclick = function() { state.showPendingBills = !state.showPendingBills; render(); };
    });
    byId("revertClosure", function(el) {
      el.onclick = function() {
        if (!confirm("Revert the last closure / recoupment? This reopens the " + e.type + " so new entries can be added.")) return;
        if (e.closure) {
          e.closure = null;
          // Drop the final marker recoupment that a PI closure creates.
          e.recoupments = (e.recoupments || []).filter(function(r) { return !r.final; });
        } else if ((e.recoupments || []).length) {
          var last = e.recoupments[e.recoupments.length - 1];
          e.recoupments = e.recoupments.slice(0, -1);
          // Remove the credit transaction that recoupment created, if it was settled.
          e.txns = (e.txns || []).filter(function(t) { return t.recoupmentId !== last.id; });
        }
        e.status = "Open";
        saveEntry(e);
        toast("Reverted \u2014 this " + e.type + " is open again.", "ok");
        render();
      };
    });
  }
  var actionMode = null;
  function openClosureForm(e, mode) {
    actionMode = mode;
    var host = document.getElementById("actionFormHost");
    if (!host) return;
    var t = totals(e), u = utilization(e);
    if (mode === "close") {
      if (t.balance >= 0) {
        host.innerHTML = closureFormHtml("Process Imprest Closure", "Underspent by Rs. " + inr(t.balance) + ". Enter details of the amount being returned to the company.", "return", t.balance);
        wireClosureForm(e, "return", t.balance, function() {
          e.status = "Closed";
        });
      } else {
        host.innerHTML = closureFormHtml("Process Imprest Closure", "Overspent by Rs. " + inr(-t.balance) + " (paid from pocket). This will be sent to Accounts for reimbursement.", "reimburse-init", -t.balance);
        byId("actClose_send", function(el) {
          el.onclick = function() {
            e.closure = {
              kind: "reimburse",
              amount: -t.balance,
              stage: "pending"
            };
            e.status = "Sent to Accounts";
            saveEntry(e);
            toast("Sent to Accounts for reimbursement.", "ok");
            render();
          };
        });
      }
    } else if (mode === "recoup") {
      if (!u.overspent) {
        var pending = u.limit - u.cycleExp;
        host.innerHTML = '<div class="closure-card"><div class="card-head"><h3>Process Recoupment</h3></div>' + '<div class="locked-note">⚠ Balance Amount Rs. ' + inr(pending) + " pending — this cycle isn't exhausted yet. Recoupment only applies once the limit is used up. Only <b>Process PI Closure</b> can be processed at this time.</div>" + '<button class="btn btn-ghost btn-sm" id="act_cancel" style="margin-top:10px">← Back</button></div>';
        byId("act_cancel", function(el) {
          el.onclick = function() {
            document.getElementById("actionFormHost").innerHTML = "";
          };
        });
      } else {
        var overspent = Math.max(0, u.cycleExp - u.limit);
        var fresh = parseFloat(e.amount) || 0;
        host.innerHTML = recoupFormHtml(overspent, fresh);
        wireRecoupForm(e);
      }
    } else if (mode === "piclose") {
      if (t.balance >= 0) {
        host.innerHTML = closureFormHtml("Process PI Closure (final)", "Underspent by Rs. " + inr(t.balance) + ". Enter details of the amount being returned to the company. No fresh amount will follow — this PI is closed for the year.", "return", t.balance);
        wireClosureForm(e, "return", t.balance, function() {
          e.status = "Closed";
          e.recoupments.push({
            id: uid(),
            date: todayISO(),
            overspentAmount: 0,
            freshAmount: 0,
            totalCredit: 0,
            final: true,
            settled: "linked"
          });
        });
      } else {
        host.innerHTML = closureFormHtml("Process PI Closure (final)", "Overspent by Rs. " + inr(-t.balance) + " (paid from pocket). No fresh amount will follow. This will be sent to Accounts for reimbursement, closing the PI for the year.", "reimburse-init", -t.balance);
        byId("actClose_send", function(el) {
          el.onclick = function() {
            e.closure = {
              kind: "reimburse",
              amount: -t.balance,
              stage: "pending"
            };
            e.status = "Sent to Accounts";
            e.recoupments.push({
              id: uid(),
              date: todayISO(),
              overspentAmount: -t.balance,
              freshAmount: 0,
              totalCredit: 0,
              final: true,
              settled: "linked"
            });
            saveEntry(e);
            toast("Sent to Accounts for reimbursement — PI closure pending.", "ok");
            render();
          };
        });
      }
    }
  }
  function closureFormHtml(title, msg, kind, amount) {
    if (kind === "reimburse-init") {
      return '<div class="closure-card"><div class="card-head"><h3>' + esc(title) + "</h3></div>" + '<div class="hint" style="margin-bottom:10px">' + esc(msg) + "</div>" + '<button class="btn btn-danger btn-sm" id="actClose_send">Send to Accounts</button></div>';
    }
    return '<div class="closure-card"><div class="card-head"><h3>' + esc(title) + "</h3></div>" + '<div class="hint" style="margin-bottom:10px">' + esc(msg) + "</div>" + f2("act_amount", "Amount (Rs.)", amount) + '<div class="field"><label>Date</label><input type="date" id="act_date" value="' + todayISO() + '"></div>' + '<div class="field"><label>Mode</label><div class="radio-pill-group"><div class="radio-pill sel" data-actmode="cash">Cash</div><div class="radio-pill" data-actmode="online">Online</div></div></div>' + '<div id="act_utrWrap" style="display:none">' + f2("act_utr", "UTR / Transaction No.", "") + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="act_cancel">← Back</button><button class="btn btn-primary btn-sm" id="act_save">Confirm return</button></div></div>';
  }
  function wireClosureForm(e, kind, amount, onDone) {
    var mode = "cash";
    document.querySelectorAll("[data-actmode]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-actmode");
        mode = el.getAttribute("data-actmode");
        document.getElementById("act_utrWrap").style.display = mode === "online" ? "block" : "none";
      };
    });
    byId("act_save", function(el) {
      el.onclick = function() {
        e.closure = {
          kind: kind,
          amount: val("act_amount").replace(/[^0-9.]/g, ""),
          stage: "done",
          date: val("act_date"),
          mode: mode,
          utr: val("act_utr")
        };
        onDone();
        saveEntry(e);
        toast("Closure recorded.", "ok");
        document.getElementById("actionFormHost").innerHTML = "";
        render();
      };
    });
    byId("act_cancel", function(el) {
      el.onclick = function() {
        document.getElementById("actionFormHost").innerHTML = "";
      };
    });
  }
  function openReimburseForm(e) {
    var host = document.getElementById("reimburseFormHost");
    if (!host) return;
    var amt = e.closure.amount;
    host.innerHTML = '<div class="field-row" style="margin-top:10px">' + f2("rb_amount", "Amount reimbursed (Rs.)", amt) + '<div class="field"><label>Date</label><input type="date" id="rb_date" value="' + todayISO() + '"></div></div>' + '<div class="field"><label>Mode</label><div class="radio-pill-group"><div class="radio-pill sel" data-rbmode="cash">Cash</div><div class="radio-pill" data-rbmode="online">Online</div></div></div>' + '<div id="rb_utrWrap" style="display:none">' + f2("rb_utr", "UTR / Transaction No.", "") + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="rb_cancel">← Back</button><button class="btn btn-primary btn-sm" id="rb_save">Save reimbursement</button></div>';
    var mode = "cash";
    document.querySelectorAll("[data-rbmode]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-rbmode");
        mode = el.getAttribute("data-rbmode");
        document.getElementById("rb_utrWrap").style.display = mode === "online" ? "block" : "none";
      };
    });
    byId("rb_cancel", function(el) {
      el.onclick = function() {
        host.innerHTML = "";
      };
    });
    byId("rb_save", function(el) {
      el.onclick = function() {
        e.closure.stage = "done";
        e.closure.date = val("rb_date");
        e.closure.mode = mode;
        e.closure.utr = val("rb_utr");
        e.closure.amount = val("rb_amount").replace(/[^0-9.]/g, "");
        e.status = "Closed";
        saveEntry(e);
        toast("Reimbursement recorded — closed.", "ok");
        render();
      };
    });
  }
  function recoupFormHtml(overspent, fresh) {
    return '<div class="closure-card"><div class="card-head"><h3>Process Recoupment</h3></div>' + '<div class="hint" style="margin-bottom:10px">Settling overspend of Rs. ' + inr(overspent) + " plus a fresh Rs. " + inr(fresh) + " for the next cycle.</div>" + '<div class="field-row">' + f2("rc_overspent", "Overspent settled (Rs.)", overspent) + f2("rc_fresh", "Fresh amount (Rs.)", fresh) + "</div>" + '<div class="field"><label>Total Credit Expected (Rs.)</label><input id="rc_total" value="' + inr(overspent + fresh) + '" readonly><div class="hint">This is what you expect to receive once Form-2, vouchers, Pavati and bills are submitted and the reimbursement is actually processed.</div></div>' + '<div class="field"><label>Date</label><input type="date" id="rc_date" value="' + todayISO() + '"></div>' + '<div class="field"><label>Mode</label><div class="radio-pill-group"><div class="radio-pill sel" data-rcmode="cash">Cash</div><div class="radio-pill" data-rcmode="online">Online</div></div></div>' + '<div id="rc_utrWrap" style="display:none">' + f2("rc_utr", "UTR / Transaction No.", "") + "</div>" + '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="rc_cancel">← Back</button><button class="btn btn-gold btn-sm" id="rc_save">Confirm recoupment</button></div></div>';
  }
  function wireRecoupForm(e) {
    var mode = "cash";
    document.querySelectorAll("[data-rcmode]").forEach(function(el) {
      el.onclick = function() {
        setPill(el, "data-rcmode");
        mode = el.getAttribute("data-rcmode");
        document.getElementById("rc_utrWrap").style.display = mode === "online" ? "block" : "none";
      };
    });
    function recompute() {
      var ov = parseFloat(val("rc_overspent")) || 0, fr = parseFloat(val("rc_fresh")) || 0;
      document.getElementById("rc_total").value = inr(ov + fr);
    }
    byId("rc_overspent", function(el) {
      el.oninput = recompute;
    });
    byId("rc_fresh", function(el) {
      el.oninput = recompute;
    });
    byId("rc_save", function(el) {
      el.onclick = function() {
        var ov = parseFloat(val("rc_overspent")) || 0, fr = parseFloat(val("rc_fresh")) || 0, total = ov + fr;
        var id = uid(), date = val("rc_date");
        e.recoupments.push({
          id: id,
          date: date,
          overspentAmount: ov,
          freshAmount: fr,
          totalCredit: total,
          mode: mode,
          utr: val("rc_utr"),
          final: false,
          settled: "pending"
        });
        saveEntry(e);
        toast("Recoupment submitted — awaiting settlement confirmation.", "ok");
        document.getElementById("actionFormHost").innerHTML = "";
        render();
      };
    });
    byId("rc_cancel", function(el) {
      el.onclick = function() {
        document.getElementById("actionFormHost").innerHTML = "";
      };
    });
  }
  function confirmRecoupmentSettlement(e, id, decision, remark) {
    var r = (e.recoupments || []).filter(function(x) {
      return x.id === id;
    })[0];
    if (!r) return;
    r.settled = decision;
    r.settledRemark = remark || "";
    r.settledDate = todayISO();
    if (decision === "yes") {
      e.txns.push({
        id: uid(),
        kind: "received",
        amount: r.totalCredit,
        date: r.date,
        mode: r.mode,
        utr: r.utr,
        recoupmentId: r.id,
        overspentAmount: r.overspentAmount,
        freshAmount: r.freshAmount
      });
    }
    saveEntry(e);
    toast(decision === "yes" ? "Recoupment settled — new cycle started." : "Marked as not yet settled.", "ok");
    render();
  }
  function findTxn(e, id) {
    return (e.txns || []).filter(function(t) {
      return t.id === id;
    })[0];
  }
  function ensurePavati(tx) {
    if (!tx.pavati) tx.pavati = {
      generated: false,
      personsCount: 1,
      persons: [ "" ],
      workPerformed: "",
      image: ""
    };
  }
  var editTxnId = null;
  function openEditTxn(e, txId) {
    var tx = findTxn(e, txId);
    if (!tx) return;
    editTxnId = txId;
    txnMode = tx.kind;
    txnDraft = tx.kind === "received" ? {
      mode: tx.mode || "cash"
    } : {
      bill: tx.billAvailable || "no",
      billStage: tx.billStage || "later",
      paid: tx.paid || "cash"
    };
    imgData[tx.kind === "received" ? "tr_img" : "te_img"] = tx.image || "";
    renderTxnForm(e);
  }
  function renderTxnForm(e) {
    var host = document.getElementById("txnFormHost");
    if (!host) return;
    var pf = editTxnId ? findTxn(e, editTxnId) || {} : {};
    host.innerHTML = txnForm(txnMode, pf);
    if (txnMode === null) {
      host.querySelectorAll("[data-txnkind]").forEach(function(el) {
        el.onclick = function() {
          var k = el.getAttribute("data-txnkind");
          if (k === "fromlist") {
            renderFromListPicker(e);
            return;
          }
          txnMode = k;
          txnDraft = {
            bill: "no"
          };
          renderTxnForm(e);
        };
      });
      return;
    }
    if (txnMode === "received") {
      host.querySelectorAll("[data-trmode]").forEach(function(el) {
        el.onclick = function() {
          setPill(el, "data-trmode");
          txnDraft.mode = el.getAttribute("data-trmode");
          document.getElementById("tr_utrWrap").style.display = txnDraft.mode === "online" ? "block" : "none";
        };
      });
      wireImg("tr_img");
      byId("tr_save", function(el) {
        el.onclick = function() {
          var amt = val("tr_amount").replace(/[^0-9.]/g, "");
          if (!amt) {
            toast("Enter amount.", "err");
            return;
          }
          var payload = {
            amount: amt,
            date: val("tr_date"),
            mode: txnDraft.mode || "cash",
            utr: val("tr_utr"),
            image: imgData["tr_img"] || ""
          };
          if (editTxnId) {
            var existing = findTxn(e, editTxnId);
            Object.assign(existing, payload);
            editTxnId = null;
            toast("Received entry updated.", "ok");
          } else {
            e.txns.push(Object.assign({
              id: uid(),
              kind: "received"
            }, payload));
            toast("Received entry added.", "ok");
          }
          saveEntry(e);
          txnMode = null;
          render();
        };
      });
      byId("tr_cancel", function(el) {
        el.onclick = function() {
          txnMode = null;
          editTxnId = null;
          renderTxnForm(e);
        };
      });
    } else {
      host.querySelectorAll("[data-tebill]").forEach(function(el) {
        el.onclick = function() {
          setPill(el, "data-tebill");
          txnDraft.bill = el.getAttribute("data-tebill");
          var yes = txnDraft.bill === "yes";
          document.getElementById("te_billWrap").style.display = yes ? "block" : "none";
          document.getElementById("te_noBillChoice").style.display = yes ? "none" : "block";
          document.getElementById("te_noBillNote").style.display = yes ? "none" : "flex";
          if (!yes && !txnDraft.billStage) txnDraft.billStage = "later";
        };
      });
      host.querySelectorAll("[data-tebillstage]").forEach(function(el) {
        el.onclick = function() {
          setPill(el, "data-tebillstage");
          txnDraft.billStage = el.getAttribute("data-tebillstage");
        };
      });
      host.querySelectorAll("[data-temode]").forEach(function(el) {
        el.onclick = function() {
          setPill(el, "data-temode");
          txnDraft.paid = el.getAttribute("data-temode");
          document.getElementById("te_utrWrap").style.display = txnDraft.paid === "online" ? "block" : "none";
        };
      });
      wireImg("te_img");
      byId("te_save", function(el) {
        el.onclick = function() {
          var amt = val("te_amount").replace(/[^0-9.]/g, "");
          if (!amt) {
            toast("Enter amount.", "err");
            return;
          }
          var bill = txnDraft.bill || "no";
          var billStage = bill === "no" ? txnDraft.billStage || "later" : "";
          var payload = {
            amount: amt,
            date: val("te_date"),
            paidTo: val("te_paidTo"),
            paid: txnDraft.paid || "cash",
            utr: val("te_utr"),
            image: imgData["te_img"] || "",
            billAvailable: bill,
            billStage: billStage,
            nameOfWork: bill === "yes" ? val("te_nameWork") : "",
            agency: bill === "yes" ? val("te_agency") : "",
            billNo: bill === "yes" ? val("te_billNo") : "",
            submittedBy: bill === "yes" ? val("te_submittedBy") : ""
          };
          if (editTxnId) {
            var existing = findTxn(e, editTxnId);
            Object.assign(existing, payload);
            if (!existing.pavati) existing.pavati = {
              generated: false,
              personsCount: 1,
              persons: [ "" ],
              workPerformed: "",
              image: ""
            };
            editTxnId = null;
            toast("Expense updated.", "ok");
          } else {
            payload.pavati = {
              generated: false,
              personsCount: 1,
              persons: [ "" ],
              workPerformed: "",
              image: ""
            };
            e.txns.push(Object.assign({
              id: uid(),
              kind: "expense"
            }, payload));
            toast(bill === "yes" ? "Expense with bill added." : billStage === "fill" ? "Expense booked — fill Pavati below." : "Expense booked — bill pending.", "ok");
          }
          saveEntry(e);
          txnMode = null;
          render();
          if (utilization(e).overspent) {
            showModal("Amount Exhausted", "You are overspending.");
          }
        };
      });
      byId("te_cancel", function(el) {
        el.onclick = function() {
          txnMode = null;
          editTxnId = null;
          renderTxnForm(e);
        };
      });
    }
  }
  function renderFromListPicker(e) {
    var host = document.getElementById("txnFormHost");
    if (!host) return;
    var list = otherExpensesList();
    var rows = list.length ? list.map(function(exp) {
      var meta = (exp.paid === "online" ? "Online · UTR " + esc(exp.utr || "—") : "Cash") + (exp.paidTo ? " · Paid to " + esc(exp.paidTo) : "");
      return '<div class="txn exp" data-pickexp="' + exp.id + '" style="cursor:pointer"><div class="txn-main"><div class="txn-title">' + esc(exp.nameOfWork || exp.paidTo || "Expense") + '</div><div class="hint">' + fmtDate(exp.date) + " · " + meta + "</div></div>" + '<div class="mono txn-amt">Rs. ' + inr(exp.amount) + '</div><button class="btn btn-gold btn-xs" data-pickexp="' + exp.id + '">Select</button></div>';
    }).join("") : '<div class="hint" style="padding:10px 2px">No standalone expenses available. Add some from the “Other Expenses” page first.</div>';
    host.innerHTML = '<div class="card txn-form-card"><div class="card-head"><h3>Select from Other Expense List</h3></div>' + rows + '<button class="btn btn-ghost btn-sm" id="pick_back" style="margin-top:10px">← Back</button></div>';
    document.querySelectorAll("[data-pickexp]").forEach(function(el) {
      el.onclick = function() {
        var id = el.getAttribute("data-pickexp");
        var exp = list.filter(function(x) {
          return x.id === id;
        })[0];
        if (!exp) return;
        var newTx = Object.assign({}, exp, {
          id: uid(),
          kind: "expense"
        });
        e.txns.push(newTx);
        deleteOtherExpense(id);
        saveEntry(e);
        txnMode = null;
        toast("Moved into this " + e.type + "'s Account Statement.", "ok");
        render();
        if (utilization(e).overspent) {
          showModal("Amount Exhausted", "You are overspending.");
        }
      };
    });
    byId("pick_back", function(el) {
      el.onclick = function() {
        txnMode = null;
        renderTxnForm(e);
      };
    });
  }
  function setPill(el, attr) {
    var group = el.parentNode;
    group.querySelectorAll("[" + attr + "]").forEach(function(x) {
      x.classList.remove("sel");
    });
    el.classList.add("sel");
  }
  var imgData = {};
  function wireImg(id) {
    byId(id, function(el) {
      el.onchange = function() {
        var file = el.files[0];
        if (!file) return;
        var r = new FileReader;
        r.onload = function() {
          imgData[id] = r.result;
          var prev = document.getElementById(id + "_prev");
          if (prev) prev.innerHTML = '<img class="thumb" src="' + r.result + '" style="margin-top:8px;width:60px;height:60px">';
        };
        r.readAsDataURL(file);
      };
    });
  }
  function wireForm2(e) {
    byId("f2_save", function(el) {
      el.onclick = function() {
        var F = e.form2;
        F.sapNo = val("f2_sap");
        F.cpfNo = val("f2_cpf");
        F.pmoNo = val("f2_pmo");
        F.dateFrom = val("f2_from");
        F.dateTo = val("f2_to");
        F.amountPaidBack = val("f2_paidback");
        if (document.getElementById("f2_acct")) {
          F.refundAccount = val("f2_acct");
          if (F.refundAccount) {
            var u = state.user;
            if (!u.refundAccounts) u.refundAccounts = [];
            if (u.refundAccounts.indexOf(F.refundAccount) === -1) {
              u.refundAccounts.unshift(F.refundAccount);
              u.refundAccounts = u.refundAccounts.slice(0, 8);
            }
            apiPost("saveEmployee", { profile: u }).then(function(res) {
              if (!res.ok) toast("Could not sync saved account number: " + (res.error || "unknown error"), "err");
            });
          }
        }
        if (document.getElementById("f2_rdate")) F.refundDate = val("f2_rdate");
        F.refundUTR = val("f2_utr");
        saveEntry(e);
        toast("Form-2 details saved.", "ok");
        render();
      };
    });
    byId("f2_back", function(el) {
      el.onclick = function() {
        state.open.form2 = false;
        render();
      };
    });
    byId("f2_excel", function(el) {
      el.onclick = function() {
        downloadForm2Excel(e);
      };
    });
    byId("f2_pdf", function(el) {
      el.onclick = function() {
        downloadForm2Pdf(e);
      };
    });
    byId("f2_preview", function(el) {
      el.onclick = function() {
        var host = document.getElementById("f2PreviewHost");
        if (!host) return;
        if (host.innerHTML) { host.innerHTML = ""; return; }
        host.innerHTML = '<div style="max-height:560px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface-2);margin-top:10px">' + form2PrintHtml(e) + "</div>";
      };
    });
    byId("f2_word", function(el) {
      el.onclick = function() {
        downloadForm2Word(e);
      };
    });
    byId("f2_print", function(el) {
      el.onclick = function() {
        printForm2(e);
      };
    });
  }
  function loadScript(src) {
    return new Promise(function(res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function() {
        rej(new Error("load failed"));
      };
      document.head.appendChild(s);
    });
  }
  function ensureDocx() {
    if (typeof docx !== "undefined") return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/docx/8.5.0/docx.umd.min.js");
  }
  function ensureJsPdf() {
    if (window.jspdf) return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  }
  function ensureXlsx() {
    if (window.XLSX) return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
  }
  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function() {
      URL.revokeObjectURL(a.href);
    }, 1e3);
  }
  var PRINT_CSS = "body{margin:0;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact}" + ".pg{width:210mm;min-height:297mm;box-sizing:border-box;padding:18mm 20mm;margin:0 auto 6mm;page-break-after:always}" + ".pg:last-child{page-break-after:auto}" + ".lt-org{font-weight:700;font-size:16px;text-align:center}" + ".lt-iso{text-align:center;font-size:11.5px;margin:5px 0 22px}" + ".lt-send{font-size:12px;margin-bottom:10px;white-space:pre-wrap}" + ".lt-ref{display:flex;justify-content:space-between;font-size:13px;margin-bottom:20px}" + ".lt-to{margin-bottom:16px}.lt-sub{margin-bottom:14px}.lt-salut{margin-bottom:10px}" + ".lt-para{margin-bottom:11px}" + ".lt-encl{margin-bottom:16px;font-size:12.5px}.lt-encl ol{margin:4px 0 0 18px;padding:0}" + ".lt-emp{text-align:right;margin:24px 0 28px}" + ".lt-rec{border-top:1px dashed #ccc;padding-top:14px}" + ".vch{border:1px solid #999;padding:14px 16px;font-size:11.5px;font-family:'Times New Roman',Georgia,serif;height:47%;box-sizing:border-box;overflow:hidden}" + ".vch-org{font-weight:700;font-size:12.5px;text-align:center;margin-bottom:10px}" + ".vch-row{margin-bottom:5px;border-bottom:1px dotted #ccc;padding-bottom:3px}" + ".vch-cert-title{font-weight:700;margin:8px 0 5px}" + ".vch-sign{text-align:right;font-weight:700;margin-top:14px}" + ".vch-pair{display:flex;flex-direction:column;gap:6mm;height:100%}" + ".f2-table{width:100%;border-collapse:collapse;font-size:12.5px;font-family:Arial,sans-serif;line-height:1.3}" + ".f2-table{border:1px solid #999}" + ".f2-table th,.f2-table td{border:1px dotted #999;padding:5px 7px;text-align:center}" + ".f2-table thead th{border-bottom:1px solid #999}" + ".f2-table tfoot td{border-top:1px solid #999}" + ".f2-table th{background:#eee}" + ".pav-title{font-weight:700;font-size:16px;text-align:center;margin-bottom:14px}";
  function openPrintWindow(pagesHtml) {
    var w = window.open("", "_blank");
    if (!w) {
      toast("Pop-up blocked — please allow pop-ups to print.", "err");
      return;
    }
    w.document.open();
    w.document.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Print</title><style>" + PRINT_CSS + "</style></head><body>" + pagesHtml + "</body></html>");
    w.document.close();
    setTimeout(function() {
      w.focus();
      w.print();
    }, 350);
  }
  function letterPrintHtml(p, e) {
    var L = e.letter;
    var bd = p.bossDesignation || "", bo = p.bossOffice || "", bg = p.bossOrg || "MSETCL";
    var atts = (L.attachments || []).filter(Boolean);
    var salut = p.bossSalutation === "Madam" ? "Madam" : "Sir";
    var body = L.bodyHtml ? '<div class="lt-para">' + L.bodyHtml + "</div>" : "";
    return '<div class="pg"><div class="lt-org">MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LTD.</div><div class="lt-iso">An ISO 9001:2000 CERTIFIED ORGANISATION</div>' + (L.sendingAddress ? '<div class="lt-send">' + esc(L.sendingAddress) + "</div>" : "") + '<div class="lt-ref"><span>' + esc(L.refPrefix || "") + " " + esc(L.refNumber || "") + "</span><span>Date: " + fmtDate(L.refDate) + "</span></div>" + '<div class="lt-to">To,<br>The ' + esc(bd) + ",<br>" + esc(bo) + "<br>" + esc(bg) + "</div>" + '<div class="lt-sub"><b>Sub:</b>&nbsp;&nbsp;' + esc(e.subject || "") + "</div>" + '<div class="lt-salut">Respected ' + salut + ",</div><div>" + body + "</div>" + (atts.length ? '<div class="lt-encl"><b>Encl:</b><ol>' + atts.map(function(a) {
      return "<li>" + esc(a) + "</li>";
    }).join("") + "</ol></div>" : "") + '<div class="lt-emp"><div style="font-weight:700">' + esc(p.name || "") + "</div><div>" + esc(p.designation || "") + "</div></div>" + '<div class="lt-rec"><div style="font-weight:700">Recommended By,</div><div style="height:18px"></div><div style="font-weight:700">' + esc(p.bossName || "") + "</div><div>" + esc(bd) + "</div><div>" + esc(bo) + "</div><div>" + esc(bg) + "</div></div></div>";
  }
  function printLetter(e) {
    openPrintWindow(letterPrintHtml(state.user, e));
  }
  // Single source of truth for the Form-2 layout: used by Preview and Print,
  // and mirrored by the PDF/Word/Excel builders so all five stay identical.
  function form2PrintHtml(e) {
    var d = form2Data(e);
    var rowsHtml = d.rows.map(function(r) {
      return "<tr><td>" + r.sno + "</td><td>" + r.monthDate + "</td><td>" + esc(r.voucherNo) + '</td><td style="text-align:left">' + esc(r.particulars) + '</td><td class="num">' + r.paymentRs + '</td><td class="num">' + r.totalRs + "</td><td></td></tr>";
    }).join("");
    var settleHtml = d.balance >= 0
      ? "<div><b>Amount to be Paid Back =</b> Rs. " + plainNum(d.paidBack) + "</div>" +
        '<div style="font-weight:700;margin-top:6px">Amount transferred details :</div>' +
        '<div style="margin-left:14px">Account No : ' + esc(d.refundAccount || "") + "</div>" +
        '<div style="margin-left:14px">Transaction No : UTR - ' + esc(d.refundUTR || "") + "</div>" +
        '<div style="margin-left:14px">Date : ' + (d.refundDate ? fmtDate(d.refundDate) : "") + "</div>"
      : "<div><b>Extra Amount Paid from Pocket =</b> Rs. " + plainNum(d.paidBack) + "</div>" +
        '<div style="font-weight:700;margin-top:6px">Kindly reimburse the same.</div>' +
        '<div style="margin-left:14px">Reimbursement UTR : ' + esc(d.refundUTR || "") + "</div>";
    return '<div class="pg" style="font-family:Arial,sans-serif;font-size:12px">' +
      '<div style="text-align:center;font-weight:700;font-size:17px;margin-bottom:12px">FORM-2 IMPREST CASH ACCOUNT</div>' +
      "<div>Imprest Cash Book of :- " + esc(d.name) + " , " + esc(d.designation) + " SAP No-" + esc(d.sap) + "&nbsp;&nbsp;&nbsp;&nbsp;CPF No:- " + esc(d.cpf) +
        (d.pmo ? "&nbsp;&nbsp;&nbsp;&nbsp;PMO No. " + esc(d.pmo) : "") + "</div>" +
      "<div>Date from : " + fmtDate(d.dateFrom) + "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date to : " + fmtDate(d.dateTo) + "</div><br>" +
      '<table class="f2-table"><thead><tr><th>Sr No</th><th>Month &amp; Date</th><th>Voucher No</th><th>Transactions</th><th>Amount of<br>Cash Payment (Rs)</th><th>Total (Rs)</th><th>Head of<br>Account (SAP)</th></tr></thead><tbody>' + rowsHtml + "</tbody>" +
      '<tfoot><tr><td colspan="3"></td><td style="text-align:right;font-weight:700">Total Rs. =</td><td class="num" style="font-weight:700">' + d.totalPayment + '</td><td class="num" style="font-weight:700">' + d.totalReceipt + "</td><td></td></tr></tfoot></table><br>" +
      settleHtml +
      '<div style="text-align:right;font-weight:700;margin-top:22px">' + esc(d.name) + ",<br>" + esc(d.designation) + "<br>" + esc(d.office) + "</div>" +
      "</div>";
  }
  function printForm2(e) {
    openPrintWindow(form2PrintHtml(e));
  }
  function loadScript(src) {
    return new Promise(function(res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function() {
        rej(new Error("load failed"));
      };
      document.head.appendChild(s);
    });
  }
  function ensureDocx() {
    if (typeof docx !== "undefined") return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/docx/8.5.0/docx.umd.min.js");
  }
  function ensureJsPdf() {
    if (window.jspdf) return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  }
  function ensureXlsx() {
    if (window.XLSX) return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
  }
  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function() {
      URL.revokeObjectURL(a.href);
    }, 1e3);
  }
  var PRINT_CSS = "body{margin:0;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact}" + ".pg{width:210mm;min-height:297mm;box-sizing:border-box;padding:18mm 20mm;margin:0 auto 6mm;page-break-after:always}" + ".pg:last-child{page-break-after:auto}" + ".lt-org{font-weight:700;font-size:16px;text-align:center}" + ".lt-iso{text-align:center;font-size:11.5px;margin:5px 0 22px}" + ".lt-send{font-size:12px;margin-bottom:10px;white-space:pre-wrap}" + ".lt-ref{display:flex;justify-content:space-between;font-size:13px;margin-bottom:20px}" + ".lt-to{margin-bottom:16px}.lt-sub{margin-bottom:14px}.lt-salut{margin-bottom:10px}" + ".lt-para{margin-bottom:11px}" + ".lt-encl{margin-bottom:16px;font-size:12.5px}.lt-encl ol{margin:4px 0 0 18px;padding:0}" + ".lt-emp{text-align:right;margin:24px 0 28px}" + ".lt-rec{border-top:1px dashed #ccc;padding-top:14px}" + ".vch{border:1px solid #999;padding:14px 16px;font-size:11.5px;font-family:'Times New Roman',Georgia,serif;height:47%;box-sizing:border-box;overflow:hidden}" + ".vch-org{font-weight:700;font-size:12.5px;text-align:center;margin-bottom:10px}" + ".vch-row{margin-bottom:5px;border-bottom:1px dotted #ccc;padding-bottom:3px}" + ".vch-cert-title{font-weight:700;margin:8px 0 5px}" + ".vch-sign{text-align:right;font-weight:700;margin-top:14px}" + ".vch-pair{display:flex;flex-direction:column;gap:6mm;height:100%}" + ".f2-table{width:100%;border-collapse:collapse;font-size:12.5px;font-family:Arial,sans-serif;line-height:1.3}" + ".f2-table{border:1px solid #999}" + ".f2-table th,.f2-table td{border:1px dotted #999;padding:5px 7px;text-align:center}" + ".f2-table thead th{border-bottom:1px solid #999}" + ".f2-table tfoot td{border-top:1px solid #999}" + ".f2-table th{background:#eee}" + ".pav-title{font-weight:700;font-size:16px;text-align:center;margin-bottom:14px}";
  function openPrintWindow(pagesHtml) {
    var w = window.open("", "_blank");
    if (!w) {
      toast("Pop-up blocked — please allow pop-ups to print.", "err");
      return;
    }
    w.document.open();
    w.document.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Print</title><style>" + PRINT_CSS + "</style></head><body>" + pagesHtml + "</body></html>");
    w.document.close();
    setTimeout(function() {
      w.focus();
      w.print();
    }, 350);
  }
  function letterPrintHtml(p, e) {
    var L = e.letter;
    var bd = p.bossDesignation || "", bo = p.bossOffice || "", bg = p.bossOrg || "MSETCL";
    var atts = (L.attachments || []).filter(Boolean);
    var salut = p.bossSalutation === "Madam" ? "Madam" : "Sir";
    var body = L.bodyHtml ? '<div class="lt-para">' + L.bodyHtml + "</div>" : "";
    return '<div class="pg"><div class="lt-org">MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LTD.</div><div class="lt-iso">An ISO 9001:2000 CERTIFIED ORGANISATION</div>' + (L.sendingAddress ? '<div class="lt-send">' + esc(L.sendingAddress) + "</div>" : "") + '<div class="lt-ref"><span>' + esc(L.refPrefix || "") + " " + esc(L.refNumber || "") + "</span><span>Date: " + fmtDate(L.refDate) + "</span></div>" + '<div class="lt-to">To,<br>The ' + esc(bd) + ",<br>" + esc(bo) + "<br>" + esc(bg) + "</div>" + '<div class="lt-sub"><b>Sub:</b>&nbsp;&nbsp;' + esc(e.subject || "") + "</div>" + '<div class="lt-salut">Respected ' + salut + ",</div><div>" + body + "</div>" + (atts.length ? '<div class="lt-encl"><b>Encl:</b><ol>' + atts.map(function(a) {
      return "<li>" + esc(a) + "</li>";
    }).join("") + "</ol></div>" : "") + '<div class="lt-emp"><div style="font-weight:700">' + esc(p.name || "") + "</div><div>" + esc(p.designation || "") + "</div></div>" + '<div class="lt-rec"><div style="font-weight:700">Recommended By,</div><div style="height:18px"></div><div style="font-weight:700">' + esc(p.bossName || "") + "</div><div>" + esc(bd) + "</div><div>" + esc(bo) + "</div><div>" + esc(bg) + "</div></div></div>";
  }
  function printLetter(e) {
    openPrintWindow(letterPrintHtml(state.user, e));
  }
  function letterPlainParas(e) {
    var h = e.letter.bodyHtml;
    if (!h) return [];
    var d = document.createElement("div");
    d.innerHTML = h;
    var t = (d.textContent || "").trim();
    return t ? [ t ] : [];
  }
  function pdfFontFamily(font) {
    if (!font) return "helvetica";
    var f = font.toLowerCase();
    if (f.indexOf("times") > -1 || f.indexOf("georgia") > -1 || f.indexOf("serif") > -1) return "times";
    if (f.indexOf("courier") > -1 || f.indexOf("mono") > -1) return "courier";
    return "helvetica";
  }
  function pdfFontStyle(bold, italic) {
    if (bold && italic) return "bolditalic";
    if (bold) return "bold";
    if (italic) return "italic";
    return "normal";
  }
  function renderRichParagraphPdf(doc, html, x, y, maxWidth, baseSize, forceAlign) {
    var parsed = parseRichHtml(html);
    var align = forceAlign || parsed.align || "left";
    var maxSize = baseSize;
    parsed.runs.forEach(function(r) {
      if (r.size && r.size > maxSize) maxSize = r.size;
    });
    var lineHeight = maxSize * 1.4;
    var lines = [];
    var cur = [];
    parsed.runs.forEach(function(r) {
      var parts = (r.text || "").split(/(\s+|\n)/).filter(function(p) {
        return p.length > 0;
      });
      parts.forEach(function(p) {
        if (p === "\n") {
          lines.push(cur);
          cur = [];
          return;
        }
        cur.push({
          text: p,
          bold: r.bold,
          italic: r.italic,
          underline: r.underline,
          color: r.color,
          font: r.font,
          size: r.size || baseSize
        });
      });
    });
    lines.push(cur);
    var visualLines = [];
    lines.forEach(function(tokens) {
      var line = [], w = 0;
      tokens.forEach(function(tok) {
        doc.setFont(pdfFontFamily(tok.font), pdfFontStyle(tok.bold, tok.italic));
        doc.setFontSize(tok.size);
        var tw = doc.getTextWidth(tok.text);
        if (w + tw > maxWidth && line.length) {
          visualLines.push(line);
          line = [];
          w = 0;
        }
        line.push({
          tok: tok,
          width: tw
        });
        w += tw;
      });
      visualLines.push(line);
    });
    visualLines.forEach(function(lt) {
      var lineW = lt.reduce(function(s, t) {
        return s + t.width;
      }, 0);
      var sx = x;
      if (align === "center") sx = x + (maxWidth - lineW) / 2; else if (align === "right") sx = x + (maxWidth - lineW);
      var cx = sx;
      lt.forEach(function(item) {
        var tok = item.tok;
        doc.setFont(pdfFontFamily(tok.font), pdfFontStyle(tok.bold, tok.italic));
        doc.setFontSize(tok.size);
        try {
          doc.setTextColor(tok.color || "#1a1a1a");
        } catch (_e) {
          doc.setTextColor("#1a1a1a");
        }
        doc.text(tok.text, cx, y);
        if (tok.underline) {
          doc.setDrawColor(0);
          doc.setLineWidth(.5);
          doc.line(cx, y + 2, cx + item.width, y + 2);
        }
        cx += item.width;
      });
      doc.setTextColor("#1a1a1a");
      y += lineHeight;
    });
    return y;
  }
  function downloadLetterWord(e) {
    toast("Preparing Word…", "ok");
    ensureDocx().then(function() {
      buildLetterWord(e);
    }).catch(function() {
      toast("Could not reach the Word library online — use Print instead, or try again when online.", "err");
    });
  }
  function buildLetterWord(e) {
    var p = state.user, L = e.letter;
    var P = docx.Paragraph, T = docx.TextRun, AL = docx.AlignmentType;
    var salut = p.bossSalutation === "Madam" ? "Madam" : "Sir";
    var children = [ new P({
      alignment: AL.CENTER,
      children: [ new T({
        text: "MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LTD.",
        bold: true,
        size: 28
      }) ]
    }), new P({
      alignment: AL.CENTER,
      children: [ new T({
        text: "An ISO 9001:2000 CERTIFIED ORGANISATION",
        size: 18
      }) ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T({
        text: (L.refPrefix || "") + " " + (L.refNumber || "") + "                                     Date: " + fmtDate(L.refDate)
      }) ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T("To,") ]
    }), new P({
      children: [ new T("The " + (p.bossDesignation || "") + ",") ]
    }), new P({
      children: [ new T(p.bossOffice || "") ]
    }), new P({
      children: [ new T(p.bossOrg || "") ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T({
        text: "Sub: ",
        bold: true
      }), new T(e.subject || "") ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T("Respected " + salut + ",") ]
    }) ];
    var letterAlign2docxMap = {
      left: AL.LEFT,
      center: AL.CENTER,
      right: AL.RIGHT,
      justify: AL.JUSTIFIED
    };
    if (L.bodyHtml) {
      var parsed = parseRichHtml(L.bodyHtml);
      var runsChildren = parsed.runs.filter(function(r) {
        return r.text && r.text !== "\n";
      }).map(function(r) {
        var opts = {
          text: r.text
        };
        if (r.bold) opts.bold = true;
        if (r.italic) opts.italics = true;
        if (r.underline) opts.underline = {};
        if (r.color) opts.color = String(r.color).replace("#", "");
        if (r.font) opts.font = String(r.font).split(",")[0].replace(/['"]/g, "").trim();
        if (r.size) opts.size = Math.round(r.size * 2);
        return new T(opts);
      });
      children.push(new P({
        alignment: letterAlign2docxMap[parsed.align] || AL.JUSTIFIED,
        children: runsChildren.length ? runsChildren : [ new T("") ]
      }));
    }
    var atts = (L.attachments || []).filter(Boolean);
    if (atts.length) {
      children.push(new P({
        text: ""
      }));
      children.push(new P({
        children: [ new T({
          text: "Encl:",
          bold: true
        }) ]
      }));
      atts.forEach(function(a, i) {
        children.push(new P({
          children: [ new T(i + 1 + ". " + a) ]
        }));
      });
    }
    children.push(new P({
      text: ""
    }));
    children.push(new P({
      text: ""
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T({
        text: p.name || "",
        bold: true
      }) ]
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T(p.designation || "") ]
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T("") ]
    }));
    children.push(new P({
      text: ""
    }));
    children.push(new P({
      children: [ new T({
        text: "Recommended By,",
        bold: true
      }) ]
    }));
    children.push(new P({
      text: ""
    }));
    children.push(new P({
      children: [ new T({
        text: p.bossName || "",
        bold: true
      }) ]
    }));
    children.push(new P({
      children: [ new T(p.bossDesignation || "") ]
    }));
    children.push(new P({
      children: [ new T(p.bossOffice || "") ]
    }));
    children.push(new P({
      children: [ new T(p.bossOrg || "") ]
    }));
    var doc = new docx.Document({
      sections: [ {
        children: children
      } ]
    });
    docx.Packer.toBlob(doc).then(function(blob) {
      saveBlob(blob, e.type + "_" + (L.refNumber || "letter") + ".docx");
      toast("Word downloaded.", "ok");
    });
  }
  function downloadLetterPdf(e) {
    toast("Preparing PDF…", "ok");
    ensureJsPdf().then(function() {
      buildLetterPdf(e);
    }).catch(function() {
      toast("Could not load PDF library (offline?).", "err");
    });
  }
  function buildLetterPdf(e) {
    var p = state.user, L = e.letter;
    var doc = new window.jspdf.jsPDF({
      unit: "pt",
      format: "a4"
    });
    var W = doc.internal.pageSize.getWidth(), M = 56, y = 56;
    var salut = p.bossSalutation === "Madam" ? "Madam" : "Sir";
    doc.setFont("times", "bold").setFontSize(13);
    doc.text("MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LTD.", W / 2, y, {
      align: "center"
    });
    y += 16;
    doc.setFont("times", "normal").setFontSize(9);
    doc.text("An ISO 9001:2000 CERTIFIED ORGANISATION", W / 2, y, {
      align: "center"
    });
    y += 26;
    doc.setFontSize(11);
    doc.text((L.refPrefix || "") + " " + (L.refNumber || ""), M, y);
    doc.text("Date: " + fmtDate(L.refDate), W - M, y, {
      align: "right"
    });
    y += 22;
    doc.text("To,", M, y);
    y += 15;
    doc.text("The " + (p.bossDesignation || "") + ",", M, y);
    y += 15;
    doc.text(p.bossOffice || "", M, y);
    y += 15;
    doc.text(p.bossOrg || "", M, y);
    y += 22;
    doc.setFont("times", "bold");
    doc.text("Sub: ", M, y);
    var sw = doc.getTextWidth("Sub: ");
    doc.setFont("times", "normal");
    doc.text(doc.splitTextToSize(e.subject || "", W - 2 * M - sw), M + sw, y);
    y += 24;
    doc.text("Respected " + salut + ",", M, y);
    y += 20;
    if (e.letter.bodyHtml) {
      y = renderRichParagraphPdf(doc, e.letter.bodyHtml, M, y, W - 2 * M, 11);
      y += 6;
    }
    doc.setFont("times", "normal");
    doc.setFontSize(11);
    doc.setTextColor("#1a1a1a");
    var atts = (L.attachments || []).filter(Boolean);
    if (atts.length) {
      doc.setFont("times", "bold");
      doc.text("Encl:", M, y);
      doc.setFont("times", "normal");
      y += 15;
      atts.forEach(function(a, i) {
        doc.text(i + 1 + ". " + a, M + 10, y);
        y += 14;
      });
      y += 6;
    }
    y += 10;
    doc.setFont("times", "bold");
    doc.text(p.name || "", W - M, y, {
      align: "right"
    });
    doc.setFont("times", "normal");
    y += 14;
    doc.text(p.designation || "", W - M, y, {
      align: "right"
    });
    y += 14;
    doc.text(p.office || "", W - M, y, {
      align: "right"
    });
    y += 26;
    doc.setFont("times", "bold");
    doc.text("Recommended By,", M, y);
    y += 24;
    doc.text(p.bossName || "", M, y);
    doc.setFont("times", "normal");
    y += 14;
    doc.text(p.bossDesignation || "", M, y);
    y += 14;
    doc.text(p.bossOffice || "", M, y);
    y += 14;
    doc.text(p.bossOrg || "", M, y);
    doc.save(e.type + "_" + (L.refNumber || "letter") + ".pdf");
    toast("PDF downloaded.", "ok");
  }
  function voucherData(e, tx) {
    var p = state.user;
    return {
      voucherNo: tx.billNo ? "Bill No. :" + tx.billNo : "",
      date: fmtDate(tx.date),
      amount: "Rs. " + plainNum(tx.amount) + "./--",
      nameOfWork: (tx.billAvailable === "yes" ? tx.nameOfWork : tx.pavati && tx.pavati.workPerformed || tx.nameOfWork) || "",
      agency: (tx.billAvailable === "yes" ? tx.agency : tx.paidTo) || "",
      officer: p.name || "",
      designation: p.designation || "",
      office: p.office || ""
    };
  }
  function downloadPavatiWord(e, tx) {
    if (!tx) return;
    toast("Preparing Pavati…", "ok");
    ensureDocx().then(function() {
      buildPavatiWord(e, tx);
    }).catch(function() {
      toast("Could not reach the Word library online — use Print instead, or try again when online.", "err");
    });
  }
  function buildPavatiWord(e, tx) {
    var p = state.user;
    var P = docx.Paragraph, T = docx.TextRun, AL = docx.AlignmentType;
    var pv = tx.pavati || {
      persons: [ "" ],
      workPerformed: ""
    };
    var children = [ new P({
      alignment: AL.CENTER,
      children: [ new T({
        text: "पावती",
        bold: true,
        size: 28
      }) ]
    }), new P({
      text: ""
    }), new P({
      alignment: AL.RIGHT,
      children: [ new T({
        text: "दिनांक : ",
        bold: true
      }), new T(fmtDate(tx.date)) ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T({
        text: "पावती लिहून घेणार :- ",
        bold: true
      }), new T((p.designation || "") + ", " + (p.office || "")) ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T({
        text: "पावती लिहून देणार :- ",
        bold: true
      }), new T((pv.persons || []).filter(Boolean).join(", ") || "________________________________") ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T("मी, खालील सही करणार असे लिहून देतो की, मला " + (p.designation || "सहाय्यक अभियंता") + ", यांचे कडून कामाचे") ]
    }), new P({
      children: [ new T("रु ________________(अक्षरी _______________________________________________ रु)") ]
    }), new P({
      children: [ new T("रोख मिळाले. कुठलीही तक्रार नाही.") ]
    }), new P({
      text: ""
    }), new P({
      text: ""
    }) ];
    (pv.persons && pv.persons.length ? pv.persons : [ "" ]).forEach(function(nm) {
      children.push(new P({
        children: [ new T({
          text: "सही : ",
          bold: true
        }) ]
      }));
      children.push(new P({
        children: [ new T({
          text: "नाव : ",
          bold: true
        }), new T(nm || "") ]
      }));
      children.push(new P({
        children: [ new T({
          text: "राहणार : ",
          bold: true
        }) ]
      }));
      children.push(new P({
        text: ""
      }));
    });
    var doc = new docx.Document({
      sections: [ {
        children: children
      } ]
    });
    docx.Packer.toBlob(doc).then(function(blob) {
      saveBlob(blob, "Pavati_" + voucherSeq(e, tx.id) + ".docx");
      toast("Pavati downloaded.", "ok");
    });
  }
  function downloadPavatiPdf(e, tx) {
    if (!tx) return;
    toast("Preparing Pavati PDF…", "ok");
    ensureJsPdf().then(function() {
      return ensureHtml2Canvas();
    }).then(function() {
      buildPavatiPdfViaCanvas(e, tx);
    }).catch(function() {
      toast("Could not load PDF renderer — try Print instead.", "err");
    });
  }
  function pavatiHtmlContent(e, tx) {
    var p = state.user;
    var pv = tx.pavati || {
      persons: [ "" ],
      workPerformed: ""
    };
    var persons = pv.persons && pv.persons.length ? pv.persons : [ "" ];
    return '<div class="pav-title">पावती</div>' + '<div style="text-align:right"><b>दिनांक :</b> ' + fmtDate(tx.date) + "</div><br>" + "<div><b>पावती लिहून घेणार :-</b> &nbsp;&nbsp;" + esc(p.designation || "") + ", " + esc(p.office || "") + "</div><br>" + "<div><b>पावती लिहून देणार :-</b> &nbsp;&nbsp;" + esc(persons.filter(Boolean).join(", ") || "________________________________") + "</div><br>" + "<div>मी, खालील सही करणार असे लिहून देतो की, मला " + esc(p.designation || "सहाय्यक अभियंता") + ", यांचे कडून कामाचे</div>" + "<div>रु ________________(अक्षरी _______________________________________________ रु)</div>" + "<div>रोख मिळाले. कुठलीही तक्रार नाही.</div><br><br>" + persons.map(function(nm) {
      return "<div><b>सही :</b> ________________</div><div><b>नाव :</b> " + esc(nm || "") + "</div><div><b>राहणार :</b> </div><br>";
    }).join("");
  }
  function printPavati(e, tx) {
    var html = '<div class="pg" style="font-family:\'Noto Sans Devanagari\',Arial,sans-serif">' + pavatiHtmlContent(e, tx) + "</div>";
    openPrintWindow(html);
  }
  function ensureHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve();
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
  }
  function buildPavatiPdfViaCanvas(e, tx) {
    var container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-9999px";
    container.style.top = "0";
    container.style.width = "560px";
    container.style.background = "#fff";
    container.style.padding = "30px";
    container.style.fontFamily = "'Noto Sans Devanagari', Arial, sans-serif";
    container.style.fontSize = "15px";
    container.style.lineHeight = "1.7";
    container.innerHTML = pavatiHtmlContent(e, tx);
    document.body.appendChild(container);
    window.html2canvas(container, {
      scale: 2,
      backgroundColor: "#ffffff"
    }).then(function(canvas) {
      var imgData = canvas.toDataURL("image/png");
      var doc = new window.jspdf.jsPDF({
        unit: "pt",
        format: "a5"
      });
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = pageW * (canvas.height / canvas.width);
      doc.addImage(imgData, "PNG", 0, 0, pageW, pageH);
      doc.save("Pavati_" + voucherSeq(e, tx.id) + ".pdf");
      document.body.removeChild(container);
      toast("Pavati PDF downloaded.", "ok");
    }).catch(function() {
      document.body.removeChild(container);
      toast("Could not render Pavati PDF — try Print instead.", "err");
    });
  }
  function voucherHtmlBlock(e, tx) {
    var v = voucherData(e, tx);
    return '<div class="vch"><div class="vch-org">MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED</div>' + '<div class="vch-row"><b>1)</b>&nbsp;&nbsp;Voucher No&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;' + esc(v.voucherNo) + "</div>" + '<div class="vch-row"><b>2)</b>&nbsp;&nbsp;Date&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;' + esc(v.date) + "</div>" + '<div class="vch-row"><b>3)</b>&nbsp;&nbsp;Amount&nbsp;&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;' + esc(v.amount) + "</div>" + '<div class="vch-row"><b>4)</b>&nbsp;&nbsp;Name of Work&nbsp;: &nbsp;&nbsp;' + esc(v.nameOfWork) + "</div>" + '<div class="vch-row"><b>5)</b>&nbsp;&nbsp;Name of Agency: &nbsp;&nbsp;' + esc(v.agency) + "</div>" + '<div class="vch-cert-title">CERTIFICATE:</div>' + '<div class="vch-row"><b>1)</b>&nbsp;&nbsp;Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..</div>' + '<div class="vch-row"><b>2)</b>&nbsp;&nbsp;Paid from my pocket /Temp /Perm. Imprest &amp; may be passed recipient.</div>' + '<div class="vch-sign">Signature of Imprest Holder</div>' + "</div>";
  }
  function allVouchersPreviewHtml(e) {
    var list = expenseTxns(e);
    if (!list.length) return '<div class="hint">No expense vouchers yet.</div>';
    var pages = "";
    for (var i = 0; i < list.length; i += 2) {
      var a = voucherHtmlBlock(e, list[i]);
      var b = list[i + 1] ? voucherHtmlBlock(e, list[i + 1]) : '<div class="vch" style="visibility:hidden"></div>';
      pages += '<div class="pg"><div class="vch-pair">' + a + b + "</div></div>";
    }
    return pages;
  }
  function vouchersInner(e) {
    var list = expenseTxns(e);
    return '<div class="hint" style="margin-bottom:10px">Every expense gets its own voucher (V1, V2…), printed two per page to save paper.</div>' + '<button class="btn btn-ghost btn-sm" id="previewVouchers" style="margin-bottom:10px">Preview all vouchers (' + list.length + ")</button>" + '<div id="voucherPreviewHost"></div>' + '<div class="btn-row" style="margin:10px 0"><button class="btn btn-gold btn-sm" id="allVouchersWord">⬇ Word (.docx)</button><button class="btn btn-ghost btn-sm" id="allVouchersPdf">⬇ PDF</button><button class="btn btn-ghost btn-sm" id="allVouchersPrint">🖶 Print (2/page)</button></div>' + collapse("blankvoucher", "Download Blank Voucher", '<div class="btn-row"><button class="btn btn-ghost btn-sm" id="blankVoucherWord">⬇ Word (.docx)</button><button class="btn btn-ghost btn-sm" id="blankVoucherPdf">⬇ PDF</button><button class="btn btn-ghost btn-sm" id="blankVoucherPrint">🖶 Print</button></div>');
  }
  function wireVouchers(e) {
    byId("previewVouchers", function(el) {
      el.onclick = function() {
        var host = document.getElementById("voucherPreviewHost");
        if (host.innerHTML) {
          host.innerHTML = "";
          return;
        }
        host.innerHTML = '<div style="max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface-2)">' + allVouchersPreviewHtml(e) + "</div>";
      };
    });
    byId("allVouchersWord", function(el) {
      el.onclick = function() {
        downloadAllVouchersWord(e);
      };
    });
    byId("allVouchersPdf", function(el) {
      el.onclick = function() {
        downloadAllVouchersPdf(e);
      };
    });
    byId("allVouchersPrint", function(el) {
      el.onclick = function() {
        openPrintWindow(allVouchersPreviewHtml(e));
      };
    });
    byId("blankVoucherWord", function(el) {
      el.onclick = function() {
        downloadBlankVoucherWord();
      };
    });
    byId("blankVoucherPdf", function(el) {
      el.onclick = function() {
        downloadBlankVoucherPdf();
      };
    });
    byId("blankVoucherPrint", function(el) {
      el.onclick = function() {
        openPrintWindow('<div class="pg"><div class="vch-pair">' + blankVoucherHtml() + blankVoucherHtml() + "</div></div>");
      };
    });
  }
  function blankVoucherHtml() {
    return '<div class="vch"><div class="vch-org">MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED</div>' + '<div class="vch-row"><b>1)</b>&nbsp;&nbsp;Voucher No&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;______________</div>' + '<div class="vch-row"><b>2)</b>&nbsp;&nbsp;Date&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;______________</div>' + '<div class="vch-row"><b>3)</b>&nbsp;&nbsp;Amount&nbsp;&nbsp;&nbsp;&nbsp;: &nbsp;&nbsp;______________</div>' + '<div class="vch-row"><b>4)</b>&nbsp;&nbsp;Name of Work&nbsp;: &nbsp;&nbsp;______________________________</div>' + '<div class="vch-row"><b>5)</b>&nbsp;&nbsp;Name of Agency: &nbsp;&nbsp;______________________________</div>' + '<div class="vch-cert-title">CERTIFICATE:</div>' + '<div class="vch-row"><b>1)</b>&nbsp;&nbsp;Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..</div>' + '<div class="vch-row"><b>2)</b>&nbsp;&nbsp;Paid from my pocket /Temp /Perm. Imprest &amp; may be passed recipient.</div>' + '<div class="vch-sign">Signature of Imprest Holder</div>' + "</div>";
  }
  function downloadAllVouchersWord(e) {
    toast("Preparing Word…", "ok");
    ensureDocx().then(function() {
      buildAllVouchersWord(e);
    }).catch(function() {
      toast("Could not reach the Word library online — use Print instead, or try again when online.", "err");
    });
  }
  function buildAllVouchersWord(e) {
    var list = expenseTxns(e);
    var P = docx.Paragraph, T = docx.TextRun, AL = docx.AlignmentType;
    if (!list.length) {
      toast("No vouchers to export.", "err");
      return;
    }
    var children = [];
    list.forEach(function(tx, i) {
      var v = voucherData(e, tx);
      children.push(new P({
        alignment: AL.CENTER,
        children: [ new T({
          text: "MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED",
          bold: true,
          size: 24
        }) ]
      }));
      children.push(new P({
        text: ""
      }));
      children.push(new P({
        children: [ new T("1)   Voucher No   :   " + v.voucherNo) ]
      }));
      children.push(new P({
        children: [ new T("2)   Date              :   " + v.date) ]
      }));
      children.push(new P({
        children: [ new T("3)   Amount          :   " + v.amount) ]
      }));
      children.push(new P({
        children: [ new T("4)   Name of Work   :   " + v.nameOfWork) ]
      }));
      children.push(new P({
        children: [ new T("5)   Name of Agency :   " + v.agency) ]
      }));
      children.push(new P({
        text: ""
      }));
      children.push(new P({
        children: [ new T({
          text: "CERTIFICATE:",
          bold: true
        }) ]
      }));
      children.push(new P({
        children: [ new T("1)   Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..") ]
      }));
      children.push(new P({
        children: [ new T("2)   Paid from my pocket /Temp /Perm. Imprest & may be passed recipient.") ]
      }));
      children.push(new P({
        text: ""
      }));
      children.push(new P({
        alignment: AL.RIGHT,
        children: [ new T({
          text: "Signature of Imprest Holder",
          bold: true
        }) ]
      }));
      if (i % 2 === 1 && i < list.length - 1) {
        children.push(new P({
          children: [ new docx.PageBreak ]
        }));
      } else {
        children.push(new P({
          text: "",
          border: {
            bottom: {
              color: "999999",
              space: 1,
              style: "single",
              size: 6
            }
          }
        }));
      }
    });
    var doc = new docx.Document({
      sections: [ {
        children: children
      } ]
    });
    docx.Packer.toBlob(doc).then(function(blob) {
      saveBlob(blob, "Vouchers_All.docx");
      toast("Vouchers downloaded.", "ok");
    });
  }
  function downloadAllVouchersPdf(e) {
    toast("Preparing PDF…", "ok");
    ensureJsPdf().then(function() {
      buildAllVouchersPdf(e);
    }).catch(function() {
      toast("Could not load PDF library.", "err");
    });
  }
  function buildAllVouchersPdf(e) {
    var list = expenseTxns(e);
    if (!list.length) {
      toast("No vouchers to export.", "err");
      return;
    }
    var doc = new window.jspdf.jsPDF({
      unit: "pt",
      format: "a4"
    });
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
    function drawVoucher(v, yTop, yBottom) {
      var y = yTop + 20;
      doc.setFont("times", "bold").setFontSize(11.5);
      doc.text("MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED", W / 2, y, {
        align: "center",
        maxWidth: W - 2 * M
      });
      y += 22;
      doc.setFont("times", "normal").setFontSize(10.5);
      [ "1)   Voucher No   :   " + v.voucherNo, "2)   Date              :   " + v.date, "3)   Amount          :   " + v.amount, "4)   Name of Work   :   " + v.nameOfWork, "5)   Name of Agency :   " + v.agency ].forEach(function(line) {
        doc.text(line, M, y);
        y += 15;
      });
      y += 6;
      doc.setFont("times", "bold");
      doc.text("CERTIFICATE:", M, y);
      y += 15;
      doc.setFont("times", "normal");
      var l1 = doc.splitTextToSize("1)   Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..", W - 2 * M - 14);
      doc.text(l1, M + 14, y);
      y += l1.length * 13 + 4;
      doc.text("2)   Paid from my pocket /Temp /Perm. Imprest & may be passed recipient.", M + 14, y);
      y += 20;
      doc.setFont("times", "bold");
      doc.text("Signature of Imprest Holder", W - M, y, {
        align: "right"
      });
      doc.setDrawColor(180);
      doc.line(M, yBottom, W - M, yBottom);
    }
    for (var i = 0; i < list.length; i += 2) {
      if (i > 0) doc.addPage();
      var mid = H / 2;
      drawVoucher(voucherData(e, list[i]), 20, mid);
      if (list[i + 1]) drawVoucher(voucherData(e, list[i + 1]), mid + 10, H - 20);
    }
    doc.save("Vouchers_All.pdf");
    toast("Vouchers PDF downloaded.", "ok");
  }
  function downloadBlankVoucherWord() {
    ensureDocx().then(function() {
      var P = docx.Paragraph, T = docx.TextRun, AL = docx.AlignmentType;
      var children = [ new P({
        alignment: AL.CENTER,
        children: [ new T({
          text: "MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED",
          bold: true,
          size: 24
        }) ]
      }), new P({
        text: ""
      }), new P({
        children: [ new T("1)   Voucher No   :   ______________") ]
      }), new P({
        children: [ new T("2)   Date              :   ______________") ]
      }), new P({
        children: [ new T("3)   Amount          :   ______________") ]
      }), new P({
        children: [ new T("4)   Name of Work   :   ______________________________") ]
      }), new P({
        children: [ new T("5)   Name of Agency :   ______________________________") ]
      }), new P({
        text: ""
      }), new P({
        children: [ new T({
          text: "CERTIFICATE:",
          bold: true
        }) ]
      }), new P({
        children: [ new T("1)   Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..") ]
      }), new P({
        children: [ new T("2)   Paid from my pocket /Temp /Perm. Imprest & may be passed recipient.") ]
      }), new P({
        text: ""
      }), new P({
        alignment: AL.RIGHT,
        children: [ new T({
          text: "Signature of Imprest Holder",
          bold: true
        }) ]
      }) ];
      var doc = new docx.Document({
        sections: [ {
          children: children
        } ]
      });
      docx.Packer.toBlob(doc).then(function(blob) {
        saveBlob(blob, "Voucher_Blank.docx");
        toast("Blank voucher downloaded.", "ok");
      });
    }).catch(function() {
      toast("Could not reach the Word library online — use Print instead, or try again when online.", "err");
    });
  }
  function downloadBlankVoucherPdf() {
    ensureJsPdf().then(function() {
      var doc = new window.jspdf.jsPDF({
        unit: "pt",
        format: "a5"
      });
      var W = doc.internal.pageSize.getWidth(), M = 40, y = 50;
      doc.setFont("times", "bold").setFontSize(12);
      doc.text("MAHARASHTRA STATE ELECTRICITY TRANSMISSION COMPANY LIMITED", W / 2, y, {
        align: "center",
        maxWidth: W - 2 * M
      });
      y += 34;
      doc.setFontSize(11);
      doc.setFont("times", "normal");
      [ "1)   Voucher No   :   ______________", "2)   Date              :   ______________", "3)   Amount          :   ______________", "4)   Name of Work   :   ______________________________", "5)   Name of Agency :   ______________________________" ].forEach(function(line) {
        doc.text(line, M, y);
        y += 18;
      });
      y += 8;
      doc.setFont("times", "bold");
      doc.text("CERTIFICATE:", M, y);
      y += 16;
      doc.setFont("times", "normal");
      var l1 = doc.splitTextToSize("1)   Entry taken in L.P Register/Vehicle log book/MB for the purpose on Book No. …………… at page No. …………………..", W - 2 * M - 14);
      doc.text(l1, M + 14, y);
      y += l1.length * 13 + 4;
      doc.text("2)   Paid from my pocket /Temp /Perm. Imprest & may be passed recipient.", M + 14, y);
      y += 40;
      doc.setFont("times", "bold");
      doc.text("Signature of Imprest Holder", W - M, y, {
        align: "right"
      });
      doc.save("Voucher_Blank.pdf");
      toast("Blank voucher PDF downloaded.", "ok");
    }).catch(function() {
      toast("Could not load PDF library.", "err");
    });
  }
  function formatParticulars(tx, entryType) {
    if (tx.kind === "received") {
      return tx.recoupmentId ? "Amount received as recoupment" : ("Amount received as " + (entryType || "TI"));
    }
    if (tx.billAvailable === "yes") {
      return "Paid to : " + (tx.agency || "—") + ", for " + (tx.nameOfWork || "—");
    }
    var work = tx.pavati && tx.pavati.workPerformed ? tx.pavati.workPerformed : tx.nameOfWork || "expense";
    return "Paid to : " + (tx.paidTo || "—") + ", for " + work;
  }
  function plainNum(n) {
    var v = parseFloat(n);
    if (!isFinite(v) || v === 0) return "";
    return (Math.round(v * 100) / 100).toString();
  }
  function totalFmt(n) {
    var v = parseFloat(n);
    if (!isFinite(v)) return "";
    return v.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  function form2Data(e) {
    var p = state.user, F = e.form2, t = totals(e);
    var allTxns = (e.txns || []).slice().sort(function(a, b) {
      return new Date(a.date) - new Date(b.date);
    });
    var rows = allTxns.map(function(tx, i) {
      var isRecv = tx.kind === "received";
      return {
        sno: i + 1,
        monthDate: fmtDate(tx.date),
        voucherNo: isRecv ? "" : displayVoucherNo(tx) || "",
        particulars: formatParticulars(tx, e.type),
        paymentRs: isRecv ? "" : plainNum(tx.amount),
        totalRs: isRecv ? totalFmt(tx.amount) : ""
      };
    });
    return {
      name: p.name || "",
      designation: p.designation || "",
      office: (e.letter && e.letter.sendingAddress) || "",
      sap: F.sapNo || p.sapNo || "",
      cpf: F.cpfNo || p.cpfNo || "",
      pmo: F.pmoNo || p.pmoNo || "",
      dateFrom: F.dateFrom,
      dateTo: F.dateTo,
      rows: rows,
      totalPayment: plainNum(t.exp),
      totalReceipt: totalFmt(t.recv),
      balance: t.balance,
      paidBack: F.amountPaidBack || (t.balance >= 0 ? t.balance : -t.balance),
      refundAccount: F.refundAccount || "",
      refundUTR: F.refundUTR || "",
      refundDate: F.refundDate || ""
    };
  }
  function downloadForm2Excel(e) {
    toast("Preparing Excel…", "ok");
    ensureXlsx().then(function() {
      buildForm2Excel(e);
    }).catch(function() {
      toast("Could not load Excel library.", "err");
    });
  }
  function buildForm2Excel(e) {
    var d = form2Data(e);
    var aoa = [ [ "FORM-2 IMPREST CASH ACCOUNT" ], [ "Imprest Cash Book of :- " + d.name + " , " + d.designation + " SAP No-" + d.sap, "", "CPF No:- " + d.cpf, "", (d.pmo ? "PMO No. " + d.pmo : "") ], [ "Date from :", fmtDate(d.dateFrom), "", "Date to :", fmtDate(d.dateTo) ], [] ];
    var headerRowIdx = aoa.length;
    aoa.push([ "Sr No", "Month & Date", "Voucher No", "Transactions", "Amount of Cash Payment (Rs)", "Total (Rs)", "Head of Account (SAP)" ]);
    d.rows.forEach(function(r) {
      aoa.push([ r.sno, r.monthDate, r.voucherNo, r.particulars, r.paymentRs, r.totalRs, "" ]);
    });
    var lastDataRow = aoa.length - 1;
    aoa.push([ "", "", "", "Total Rs. =", d.totalPayment, d.totalReceipt, "" ]);
    aoa.push([]);
    if (d.balance >= 0) {
      aoa.push([ "Amount to be Paid Back =", "Rs. " + plainNum(d.paidBack) ]);
      aoa.push([ "Amount transferred details :" ]);
      aoa.push([ "Account No :", d.refundAccount ]);
      aoa.push([ "Transaction No :", "UTR - " + d.refundUTR ]);
      aoa.push([ "Date :", fmtDate(d.refundDate) ]);
    } else {
      aoa.push([ "Extra Amount Paid from Pocket =", "Rs. " + plainNum(d.paidBack) ]);
      aoa.push([ "Kindly reimburse the same." ]);
      aoa.push([ "Reimbursement UTR :", d.refundUTR ]);
    }
    aoa.push([]);
    aoa.push([]);
    aoa.push([ "", "", "", "", "", d.name ]);
    aoa.push([ "", "", "", "", "", d.designation ]);
    aoa.push([ "", "", "", "", "", d.office ]);
    var ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [ {
      wch: 7
    }, {
      wch: 13
    }, {
      wch: 12
    }, {
      wch: 36
    }, {
      wch: 14
    }, {
      wch: 12
    }, {
      wch: 14
    } ];
    try {
      for (var R = headerRowIdx; R <= lastDataRow; R++) {
        for (var C = 0; C <= 6; C++) {
          var addr = window.XLSX.utils.encode_cell({
            r: R,
            c: C
          });
          if (!ws[addr]) continue;
          ws[addr].s = {
            alignment: {
              horizontal: "center",
              vertical: "center",
              wrapText: true
            },
            border: {
              top: {
                style: "thin"
              },
              bottom: {
                style: "thin"
              },
              left: {
                style: "thin"
              },
              right: {
                style: "thin"
              }
            },
            font: R === headerRowIdx ? {
              bold: true
            } : undefined
          };
        }
      }
    } catch (_e) {}
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Form-2");
    window.XLSX.writeFile(wb, "Form2_" + (e.letter.refNumber || e.id) + ".xlsx", {
      cellStyles: true
    });
    toast("Excel downloaded.", "ok");
  }
  function downloadForm2Pdf(e) {
    toast("Preparing PDF…", "ok");
    ensureJsPdf().then(function() {
      buildForm2Pdf(e);
    }).catch(function() {
      toast("Could not load PDF library.", "err");
    });
  }
  function buildForm2Pdf(e) {
    var d = form2Data(e);
    var doc = new window.jspdf.jsPDF({
      unit: "pt",
      format: "a4"
    });
    var W = doc.internal.pageSize.getWidth(), M = 32, y = 44;
    doc.setFont("helvetica", "bold").setFontSize(15);
    doc.text("FORM-2 IMPREST CASH ACCOUNT", W / 2, y, {
      align: "center"
    });
    y += 20;
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "normal");
    doc.text("Imprest Cash Book of :- " + d.name + " , " + d.designation + " SAP No-" + d.sap, M, y);
    doc.text("CPF No:- " + d.cpf, W - 260, y);
    if (d.pmo) doc.text("PMO No. " + d.pmo, W - M - 70, y, { align: "right" });
    y += 16;
    doc.text("Date from : " + fmtDate(d.dateFrom) + "        Date to : " + fmtDate(d.dateTo), M, y);
    y += 14;
    var tableW = W - 2 * M;
    var colW = [ 28, 54, 52, tableW - 28 - 54 - 52 - 70 - 64 - 64, 70, 64, 64 ];
    var colX = [ M ];
    for (var ci = 1; ci < colW.length; ci++) colX.push(colX[ci - 1] + colW[ci - 1]);
    function centerText(text, x, w, yy) {
      doc.text(String(text == null ? "" : text), x + w / 2, yy, {
        align: "center"
      });
    }
    function rowRects(y0, h) {
      colW.forEach(function(w, i) {
        doc.setDrawColor(150);
        try {
          doc.setLineDashPattern([ 1, 1 ], 0);
        } catch (_e) {}
        doc.rect(colX[i], y0, w, h);
        try {
          doc.setLineDashPattern([], 0);
        } catch (_e) {}
      });
    }
    var headers = [ "Sr No", "Month &\nDate", "Voucher\nNo", "Transactions", "Amount of\nCash Payment (Rs)", "Total\n(Rs)", "Head of\nAccount" ];
    doc.setFont("helvetica", "bold").setFontSize(8.5);
    var headH = 24;
    rowRects(y, headH);
    headers.forEach(function(h, i) {
      var lines = h.split("\n");
      lines.forEach(function(ln, li) {
        centerText(ln, colX[i], colW[i], y + 11 + li * 9);
      });
    });
    y += headH;
    doc.setFont("helvetica", "normal").setFontSize(9);
    d.rows.forEach(function(r) {
      var lines = doc.splitTextToSize(String(r.particulars), colW[3] - 8);
      var rh = Math.max(18, lines.length * 11 + 6);
      if (y + rh > 770) {
        doc.addPage();
        y = 44;
        doc.setFont("helvetica", "bold").setFontSize(8.5);
        rowRects(y, headH);
        headers.forEach(function(h, i) {
          var ls = h.split("\n");
          ls.forEach(function(ln, li) {
            centerText(ln, colX[i], colW[i], y + 11 + li * 9);
          });
        });
        y += headH;
        doc.setFont("helvetica", "normal").setFontSize(9);
      }
      rowRects(y, rh);
      centerText(r.sno, colX[0], colW[0], y + rh / 2 + 3);
      centerText(r.monthDate, colX[1], colW[1], y + rh / 2 + 3);
      centerText(r.voucherNo, colX[2], colW[2], y + rh / 2 + 3);
      doc.text(lines, colX[3] + colW[3] / 2, y + rh / 2 - (lines.length - 1) * 5.5 + 3, {
        align: "center"
      });
      centerText(r.paymentRs, colX[4], colW[4], y + rh / 2 + 3);
      centerText(r.totalRs, colX[5], colW[5], y + rh / 2 + 3);
      centerText("", colX[6], colW[6], y + rh / 2 + 3);
      y += rh;
    });
    var totH = 20;
    rowRects(y, totH);
    doc.setFont("helvetica", "bold");
    centerText("Total Rs. =", colX[3], colW[3], y + 13);
    centerText(d.totalPayment, colX[4], colW[4], y + 13);
    centerText(d.totalReceipt, colX[5], colW[5], y + 13);
    y += totH + 22;
    doc.setFontSize(10);
    if (d.balance >= 0) {
      doc.text("Amount to be Paid Back = Rs. " + plainNum(d.paidBack), M, y);
      y += 18;
      doc.setFont("helvetica", "bold");
      doc.text("Amount transferred details :", M, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.text("Account No : " + (d.refundAccount || ""), M + 14, y);
      y += 14;
      doc.text("Transaction No : UTR - " + (d.refundUTR || ""), M + 14, y);
      y += 14;
      doc.text("Date : " + (d.refundDate ? fmtDate(d.refundDate) : ""), M + 14, y);
    } else {
      doc.text("Extra Amount Paid from Pocket = Rs. " + plainNum(d.paidBack), M, y);
      y += 18;
      doc.setFont("helvetica", "bold");
      doc.text("Kindly reimburse the same.", M, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.text("Reimbursement UTR : " + (d.refundUTR || ""), M + 14, y);
    }
    doc.setFont("helvetica", "bold").setFontSize(10.5);
    doc.text(d.name, W - M, y - 42, {
      align: "right"
    });
    doc.text(d.designation, W - M, y - 42 + 13, {
      align: "right"
    });
    doc.text(d.office, W - M, y - 42 + 26, {
      align: "right"
    });
    doc.save("Form2_" + (e.letter.refNumber || e.id) + ".pdf");
    toast("Form-2 PDF downloaded.", "ok");
  }
  function downloadForm2Word(e) {
    toast("Preparing Word…", "ok");
    ensureDocx().then(function() {
      buildForm2Word(e);
    }).catch(function() {
      toast("Could not reach the Word library online — use Print instead, or try again when online.", "err");
    });
  }
  function buildForm2Word(e) {
    var d = form2Data(e);
    var P = docx.Paragraph, T = docx.TextRun, AL = docx.AlignmentType, Tbl = docx.Table, TR = docx.TableRow, TC = docx.TableCell, BS = docx.BorderStyle;
    var children = [ new P({
      alignment: AL.CENTER,
      children: [ new T({
        text: "FORM-2 IMPREST CASH ACCOUNT",
        bold: true,
        size: 28
      }) ]
    }), new P({
      text: ""
    }), new P({
      children: [ new T("Imprest Cash Book of :- " + d.name + " , " + d.designation + " SAP No-" + d.sap + "     CPF No:- " + d.cpf + (d.pmo ? "     PMO No. " + d.pmo : "")) ]
    }), new P({
      children: [ new T("Date from : " + fmtDate(d.dateFrom) + "        Date to : " + fmtDate(d.dateTo)) ]
    }), new P({
      text: ""
    }) ];
    var thinBorder = {
      style: BS.SINGLE,
      size: 2,
      color: "999999"
    };
    var cellBorders = {
      top: thinBorder,
      bottom: thinBorder,
      left: thinBorder,
      right: thinBorder
    };
    function cell(text, bold) {
      return new TC({
        borders: cellBorders,
        children: [ new P({
          alignment: AL.CENTER,
          children: [ new T({
            text: String(text == null ? "" : text),
            bold: !!bold
          }) ]
        }) ]
      });
    }
    var rows = [ new TR({
      children: [ cell("Sr No", true), cell("Month & Date", true), cell("Voucher No", true), cell("Transactions", true), cell("Amount of Cash Payment (Rs)", true), cell("Total (Rs)", true), cell("Head of Account (SAP)", true) ]
    }) ];
    d.rows.forEach(function(r) {
      rows.push(new TR({
        children: [ cell(r.sno), cell(r.monthDate), cell(r.voucherNo), cell(r.particulars), cell(r.paymentRs), cell(r.totalRs), cell("") ]
      }));
    });
    rows.push(new TR({
      children: [ cell(""), cell(""), cell(""), cell("Total Rs. =", true), cell(d.totalPayment, true), cell(d.totalReceipt, true), cell("") ]
    }));
    var table = new Tbl({
      rows: rows,
      width: {
        size: 100,
        type: "pct"
      }
    });
    children.push(table);
    children.push(new P({
      text: ""
    }));
    if (d.balance >= 0) {
      children.push(new P({
        children: [ new T({
          text: "Amount to be Paid Back = ",
          bold: true
        }), new T("Rs. " + plainNum(d.paidBack)) ]
      }));
      children.push(new P({
        children: [ new T({
          text: "Amount transferred details :",
          bold: true
        }) ]
      }));
      children.push(new P({
        children: [ new T("Account No : " + (d.refundAccount || "")) ]
      }));
      children.push(new P({
        children: [ new T("Transaction No : UTR - " + (d.refundUTR || "")) ]
      }));
      children.push(new P({
        children: [ new T("Date : " + (d.refundDate ? fmtDate(d.refundDate) : "")) ]
      }));
    } else {
      children.push(new P({
        children: [ new T({
          text: "Extra Amount Paid from Pocket = ",
          bold: true
        }), new T("Rs. " + plainNum(d.paidBack)) ]
      }));
      children.push(new P({
        children: [ new T({
          text: "Kindly reimburse the same.",
          bold: true
        }) ]
      }));
      children.push(new P({
        children: [ new T("Reimbursement UTR : " + (d.refundUTR || "")) ]
      }));
    }
    children.push(new P({
      text: ""
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T({
        text: d.name,
        bold: true
      }) ]
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T({
        text: d.designation,
        bold: true
      }) ]
    }));
    children.push(new P({
      alignment: AL.RIGHT,
      children: [ new T({
        text: d.office,
        bold: true
      }) ]
    }));
    var doc = new docx.Document({
      sections: [ {
        children: children
      } ]
    });
    docx.Packer.toBlob(doc).then(function(blob) {
      saveBlob(blob, "Form2_" + (e.letter.refNumber || e.id) + ".docx");
      toast("Word downloaded — open with Google Docs if needed.", "ok");
    });
  }
  initAtmos();
  applyAtmos();
  render();
})();