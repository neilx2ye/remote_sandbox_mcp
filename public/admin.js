/* remote-sandbox-mcp 管理台（原生 JS，无外部依赖） */
(function () {
  "use strict";

  var state = {
    token: sessionStorage.getItem("adminToken") || "",
    projects: [],
    editingId: null,
    browser: { project: null, path: "." },
  };

  function $(sel) { return document.querySelector(sel); }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k]; // 仅用于静态受控内容
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- API ---------- */

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + state.token }, opts.headers || {});
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        showLogin("admin token 无效或已过期，请重新输入");
        throw new Error("unauthorized");
      }
      return res;
    });
  }

  function apiJson(path, opts) {
    return api(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        return data;
      });
    });
  }

  /* ---------- 通用 UI ---------- */

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = "已复制 ✓";
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = el("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  function showBanner(text, isError) {
    var b = $("#banner");
    b.textContent = text;
    b.classList.remove("hidden");
    b.classList.toggle("banner-error", !!isError);
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(function () { b.classList.add("hidden"); }, isError ? 8000 : 5000);
  }

  function fmtTime(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function fmtSize(n) {
    if (n === null || n === undefined) return "-";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ---------- 登录 ---------- */

  function showLogin(msg) {
    state.token = "";
    sessionStorage.removeItem("adminToken");
    $("#view-login").classList.remove("hidden");
    $("#view-main").classList.add("hidden");
    $("#btn-logout").classList.add("hidden");
    var e = $("#login-error");
    if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
    else e.classList.add("hidden");
  }

  function showMain() {
    $("#view-login").classList.add("hidden");
    $("#view-main").classList.remove("hidden");
    $("#btn-logout").classList.remove("hidden");
    loadProjects();
    loadOAuthClients();
  }

  $("#form-login").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var t = $("#input-token").value.trim();
    if (!t) return;
    state.token = t;
    apiJson("/api/projects").then(function () {
      sessionStorage.setItem("adminToken", t);
      showMain();
    }).catch(function (err) {
      if (err.message !== "unauthorized") showLogin("连接失败：" + err.message);
    });
  });

  $("#btn-logout").addEventListener("click", function () { showLogin(); });

  /* ---------- 项目列表 ---------- */

  function loadProjects() {
    return apiJson("/api/projects").then(function (data) {
      state.projects = data.projects || [];
      renderProjects();
    }).catch(function (err) {
      if (err.message !== "unauthorized") showBanner("加载项目失败：" + err.message, true);
    });
  }

  function modeTags(p) {
    var frag = document.createDocumentFragment();
    if (p.readOnly) frag.appendChild(el("span", { class: "tag ro" }, "只读"));
    else frag.appendChild(el("span", { class: "tag" }, "读写"));
    if (p.execEnabled) frag.appendChild(el("span", { class: "tag exec" }, "exec"));
    return frag;
  }

  function renderProjects() {
    var tbody = $("#tbl-projects tbody");
    tbody.textContent = "";
    $("#projects-empty").classList.toggle("hidden", state.projects.length > 0);
    $("#projects-count").textContent = state.projects.length ? "共 " + state.projects.length + " 个" : "";

    state.projects.forEach(function (p) {
      var tr = el("tr");

      var nameTd = el("td");
      nameTd.appendChild(el("div", { class: "proj-name" }, p.name));
      nameTd.appendChild(el("div", { class: "slug-line mono" }, p.slug));
      tr.appendChild(nameTd);

      tr.appendChild(el("td", { class: "mono root-path" }, p.root));
      tr.appendChild(el("td")).appendChild(modeTags(p));
      tr.appendChild(el("td", null, fmtTime(p.createdAt)));

      // MCP 端点（相对路径；前面拼隧道域名即可用于连接器）
      var mcpTd = el("td");
      mcpTd.appendChild(el("span", { class: "mcp-path", title: "接入连接器时，在前面加上你的隧道域名，如 https://xxx.trycloudflare.com" + p.mcpPath }, p.mcpPath));
      var copyMcp = el("button", { class: "btn btn-small", title: "复制端点路径" }, "复制");
      copyMcp.addEventListener("click", function () { copyText(p.mcpPath, copyMcp); });
      mcpTd.appendChild(document.createTextNode(" "));
      mcpTd.appendChild(copyMcp);
      tr.appendChild(mcpTd);

      // Token（掩码 + 显示完整 + 复制）
      var tokTd = el("td");
      var tokSpan = el("span", { class: "mono token-value" }, p.token);
      tokTd.appendChild(tokSpan);
      var eye = el("button", { class: "btn btn-small", title: "显示完整 token" }, "👁");
      var fullToken = null;
      eye.addEventListener("click", function () {
        if (fullToken) { tokSpan.textContent = fullToken; return; }
        apiJson("/api/projects/" + encodeURIComponent(p.id)).then(function (d) {
          fullToken = d.project.token;
          tokSpan.textContent = fullToken;
        }).catch(function (err) { showBanner("获取 token 失败：" + err.message, true); });
      });
      var copyTok = el("button", { class: "btn btn-small", title: "复制完整 token" }, "复制");
      copyTok.addEventListener("click", function () {
        if (fullToken) { copyText(fullToken, copyTok); return; }
        apiJson("/api/projects/" + encodeURIComponent(p.id)).then(function (d) {
          fullToken = d.project.token;
          tokSpan.textContent = fullToken;
          copyText(fullToken, copyTok);
        }).catch(function (err) { showBanner("获取 token 失败：" + err.message, true); });
      });
      tokTd.appendChild(document.createTextNode(" "));
      tokTd.appendChild(eye);
      tokTd.appendChild(copyTok);
      tr.appendChild(tokTd);

      // 操作
      var actTd = el("td", { class: "actions" });
      var btnFiles = el("button", { class: "btn btn-small" }, "文件");
      btnFiles.addEventListener("click", function () { openBrowser(p); });
      var btnEdit = el("button", { class: "btn btn-small" }, "编辑");
      btnEdit.addEventListener("click", function () { openForm(p); });
      var btnRegen = el("button", { class: "btn btn-small" }, "重置 token");
      btnRegen.addEventListener("click", function () {
        if (!confirm("确定要重新生成项目「" + p.name + "」的 token 吗？\n旧 token 将立即失效，所有使用旧 token 的连接器都会断开。")) return;
        apiJson("/api/projects/" + encodeURIComponent(p.id) + "/regenerate-token", { method: "POST" }).then(function (d) {
          fullToken = d.project.token;
          tokSpan.textContent = fullToken;
          showBanner("项目「" + p.name + "」的新 token：" + fullToken + "（请立即复制保存，旧 token 已失效）");
        }).catch(function (err) { showBanner("重置 token 失败：" + err.message, true); });
      });
      var btnDel = el("button", { class: "btn btn-small btn-danger" }, "删除");
      btnDel.addEventListener("click", function () {
        if (!confirm("确定删除项目「" + p.name + "」（" + p.slug + "）吗？\n只会删除登记信息，不会删除磁盘上的任何文件。")) return;
        apiJson("/api/projects/" + encodeURIComponent(p.id), { method: "DELETE" }).then(function () {
          showBanner("项目「" + p.name + "」已删除");
          if (state.browser.project && state.browser.project.id === p.id) closeBrowser();
          loadProjects();
        }).catch(function (err) { showBanner("删除失败：" + err.message, true); });
      });
      [btnFiles, btnEdit, btnRegen, btnDel].forEach(function (b) { actTd.appendChild(b); });
      tr.appendChild(actTd);

      tbody.appendChild(tr);
    });
  }

  $("#btn-refresh").addEventListener("click", loadProjects);

  /* ---------- OAuth 授权客户端 ---------- */

  function loadOAuthClients() {
    return apiJson("/api/oauth/clients").then(function (data) {
      renderOAuthClients(data.clients || [], data.stats || {});
    }).catch(function (err) {
      if (err.message !== "unauthorized") showBanner("加载 OAuth 客户端失败：" + err.message, true);
    });
  }

  function renderOAuthClients(clients, stats) {
    var tbody = $("#tbl-oauth tbody");
    tbody.textContent = "";
    $("#oauth-empty").classList.toggle("hidden", clients.length > 0);
    $("#oauth-count").textContent = clients.length
      ? "共 " + clients.length + " 个客户端 · " + (stats.accessTokens || 0) + " 个有效令牌"
      : "";

    clients.forEach(function (c) {
      var tr = el("tr");

      var nameTd = el("td");
      nameTd.appendChild(el("div", { class: "oauth-client-name" }, c.clientName || "(未命名客户端)"));
      nameTd.appendChild(el("div", { class: "slug-line mono" }, c.clientId));
      tr.appendChild(nameTd);

      var projTd = el("td");
      if (c.projects && c.projects.length) {
        var wrap = el("div", { class: "oauth-projects" });
        c.projects.forEach(function (slug) {
          var p = state.projects.find(function (x) { return x.slug === slug; });
          wrap.appendChild(el("span", { class: "mcp-path" }, "/mcp/" + slug + (p ? "（" + p.name + "）" : "")));
        });
        projTd.appendChild(wrap);
      } else {
        projTd.appendChild(el("span", { class: "muted" }, "无有效令牌"));
      }
      tr.appendChild(projTd);

      tr.appendChild(el("td", null, c.confidential ? "client_secret" : "公开客户端（PKCE）"));
      tr.appendChild(el("td", null, fmtTime(c.createdAt)));
      tr.appendChild(el("td", null, fmtTime(c.lastUsedAt)));

      var actTd = el("td", { class: "actions" });
      var btnRevoke = el("button", { class: "btn btn-small btn-danger" }, "撤销授权");
      btnRevoke.addEventListener("click", function () {
        if (!confirm("撤销客户端「" + (c.clientName || c.clientId) + "」的全部授权吗？\n该客户端已签发的 access/refresh token 会立即失效，需要重新授权。")) return;
        apiJson("/api/oauth/clients/" + encodeURIComponent(c.clientId), { method: "DELETE" }).then(function (data) {
          showBanner("已撤销该客户端的授权");
          renderOAuthClients(data.clients || [], data.stats || {});
        }).catch(function (err) { showBanner("撤销失败：" + err.message, true); });
      });
      actTd.appendChild(btnRevoke);
      tr.appendChild(actTd);

      tbody.appendChild(tr);
    });
  }

  $("#btn-refresh-oauth").addEventListener("click", loadOAuthClients);

  /* ---------- 新建 / 编辑表单 ---------- */

  function isSystemishRoot(p) {
    var s = p.trim().replace(/\\/g, "/");
    if (/^[a-zA-Z]:\/?$/.test(s)) return true;                 // C:\ 盘符根
    if (/^\//.test(s) && /^\/(etc|home|root|var|usr|bin|sbin|boot|proc|sys|dev)?\/?$/.test(s)) return true;
    if (/^[a-zA-Z]:\/Windows(\/|$)/i.test(s)) return true;     // C:\Windows
    if (/^[a-zA-Z]:\/Program Files/i.test(s)) return true;
    return false;
  }

  $("#f-root").addEventListener("input", function () {
    $("#root-warning").classList.toggle("hidden", !isSystemishRoot($("#f-root").value));
  });

  function openForm(project) {
    state.editingId = project ? project.id : null;
    $("#form-title").textContent = project ? ("编辑项目：" + project.name) : "新建项目";
    $("#f-name").value = project ? project.name : "";
    $("#f-slug").value = project ? project.slug : "";
    $("#f-slug").disabled = !!project; // slug 创建后不可改
    $("#f-root").value = project ? project.root : "";
    $("#f-readonly").checked = project ? project.readOnly : false;
    $("#f-exec").checked = project ? project.execEnabled : true;
    $("#root-warning").classList.toggle("hidden", !project || !isSystemishRoot(project.root));
    $("#panel-form").classList.remove("hidden");
    $("#f-name").focus();
  }

  function closeForm() {
    state.editingId = null;
    $("#panel-form").classList.add("hidden");
  }

  $("#btn-new").addEventListener("click", function () { openForm(null); });
  $("#btn-cancel-form").addEventListener("click", closeForm);

  $("#form-project").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      name: $("#f-name").value.trim(),
      root: $("#f-root").value.trim(),
      readOnly: $("#f-readonly").checked,
      execEnabled: $("#f-exec").checked,
    };
    var slug = $("#f-slug").value.trim();
    var req;
    if (state.editingId) {
      req = apiJson("/api/projects/" + encodeURIComponent(state.editingId), { method: "PATCH", body: JSON.stringify(body) })
        .then(function () {
          showBanner("项目已保存（如修改了根目录，已有 MCP 会话需重新连接才会生效）");
        });
    } else {
      if (slug) body.slug = slug;
      req = apiJson("/api/projects", { method: "POST", body: JSON.stringify(body) })
        .then(function (d) {
          showBanner("项目「" + d.project.name + "」已创建！token：" + d.project.token + "（仅此一次完整显示，请立即复制保存）");
        });
    }
    req.then(function () { closeForm(); loadProjects(); })
      .catch(function (err) { showBanner("保存失败：" + err.message, true); });
  });

  /* ---------- 文件浏览 ---------- */

  function joinPath(base, name) {
    return base === "." ? name : base + "/" + name;
  }

  function parentPath(p) {
    if (p === "." || p.indexOf("/") === -1) return ".";
    return p.slice(0, p.lastIndexOf("/"));
  }

  function openBrowser(project) {
    state.browser.project = project;
    state.browser.path = ".";
    $("#browser-title").textContent = "文件浏览：" + project.name + "（" + project.root + "）";
    $("#panel-browser").classList.remove("hidden");
    closePreview();
    loadFiles();
    $("#panel-browser").scrollIntoView({ behavior: "smooth" });
  }

  function closeBrowser() {
    state.browser.project = null;
    $("#panel-browser").classList.add("hidden");
  }

  $("#btn-close-browser").addEventListener("click", closeBrowser);
  $("#btn-up").addEventListener("click", function () {
    state.browser.path = parentPath(state.browser.path);
    closePreview();
    loadFiles();
  });

  function renderBreadcrumb() {
    var bc = $("#breadcrumb");
    bc.textContent = "";
    var cur = state.browser.path;
    var rootLink = el("a", null, "根目录");
    rootLink.addEventListener("click", function () { state.browser.path = "."; closePreview(); loadFiles(); });
    bc.appendChild(rootLink);
    if (cur !== ".") {
      var parts = cur.split("/");
      var acc = "";
      parts.forEach(function (part, i) {
        acc = acc ? acc + "/" + part : part;
        bc.appendChild(el("span", { class: "sep" }, " / "));
        if (i === parts.length - 1) {
          bc.appendChild(el("span", null, part));
        } else {
          (function (pathAcc) {
            var a = el("a", null, part);
            a.addEventListener("click", function () { state.browser.path = pathAcc; closePreview(); loadFiles(); });
            bc.appendChild(a);
          })(acc);
        }
      });
    }
  }

  function loadFiles() {
    var p = state.browser.project;
    if (!p) return;
    renderBreadcrumb();
    apiJson("/api/projects/" + encodeURIComponent(p.id) + "/files?path=" + encodeURIComponent(state.browser.path))
      .then(function (data) {
        state.browser.path = data.path;
        renderBreadcrumb();
        $("#files-truncated").classList.toggle("hidden", !data.truncated);
        var tbody = $("#tbl-files tbody");
        tbody.textContent = "";
        if (!data.entries.length) {
          var tr = el("tr");
          var td = el("td", { colspan: "4", class: "muted" }, "（空目录）");
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }
        data.entries.forEach(function (entry) {
          var tr = el("tr");
          var nameTd = el("td");
          var nameSpan = el("span", { class: "file-name" + (entry.type !== "other" ? " link" : "") },
            (entry.type === "dir" ? "📁 " : entry.type === "file" ? "📄 " : "🔗 ") + entry.name);
          if (entry.type === "dir") {
            nameSpan.addEventListener("click", function () {
              state.browser.path = joinPath(state.browser.path, entry.name);
              closePreview();
              loadFiles();
            });
          } else if (entry.type === "file") {
            nameSpan.addEventListener("click", function () { previewFile(entry.name); });
          }
          nameTd.appendChild(nameSpan);
          tr.appendChild(nameTd);
          tr.appendChild(el("td", null, entry.type === "dir" ? "目录" : entry.type === "file" ? "文件" : "其它"));
          tr.appendChild(el("td", null, fmtSize(entry.size)));
          tr.appendChild(el("td", null, fmtTime(entry.mtime)));
          tbody.appendChild(tr);
        });
      })
      .catch(function (err) { showBanner("读取目录失败：" + err.message, true); });
  }

  /* ---------- 文件预览 ---------- */

  function closePreview() {
    $("#preview").classList.add("hidden");
    $("#preview-content").textContent = "";
  }

  $("#btn-close-preview").addEventListener("click", closePreview);

  function previewFile(name) {
    var p = state.browser.project;
    var filePath = joinPath(state.browser.path, name);
    $("#preview-name").textContent = filePath;
    var box = $("#preview-content");
    box.textContent = "加载中…";
    $("#preview").classList.remove("hidden");

    api("/api/projects/" + encodeURIComponent(p.id) + "/file?path=" + encodeURIComponent(filePath))
      .then(function (res) {
        var ctype = res.headers.get("Content-Type") || "";
        if (ctype.indexOf("application/json") === 0) {
          return res.json().then(function (data) {
            box.textContent = "";
            if (data.kind === "text") {
              var pre = el("pre", { class: "preview-body-text" });
              data.content.split("\n").forEach(function (line, i) {
                pre.appendChild(el("span", { class: "ln" }, String(i + 1)));
                pre.appendChild(document.createTextNode(line + "\n"));
              });
              box.appendChild(pre);
              if (data.truncated) {
                box.appendChild(el("p", { class: "muted" }, "文件过大，仅显示开头部分（共 " + fmtSize(data.size) + "）。"));
              }
            } else {
              var note = data.reason === "too_large"
                ? "文件过大（" + fmtSize(data.size) + "），不支持预览。"
                : "二进制文件，不支持预览。";
              box.appendChild(el("div", { class: "binary-note" }, note));
            }
          });
        }
        // 位图：直接 blob 渲染
        return res.blob().then(function (blob) {
          box.textContent = "";
          var img = el("img", { alt: name });
          img.src = URL.createObjectURL(blob);
          box.appendChild(img);
        });
      })
      .catch(function (err) {
        box.textContent = "";
        box.appendChild(el("div", { class: "binary-note" }, "预览失败：" + err.message));
      });
  }

  /* ---------- 启动 ---------- */

  $("#endpoint-pill").textContent = location.host;

  if (state.token) {
    apiJson("/api/projects").then(showMain).catch(function () { showLogin(); });
  } else {
    showLogin();
  }
})();
