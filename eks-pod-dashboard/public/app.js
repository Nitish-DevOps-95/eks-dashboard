const API = "";
let token = localStorage.getItem("token");
let currentUser = JSON.parse(localStorage.getItem("user") || "null");
let allPods = [];
let clusters = [];
let allowedNamespaces = [];
let logEventSource = null;

// --- Auth ---
function authHeaders() {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function apiFetch(url, opts = {}) {
  opts.headers = { ...authHeaders(), ...opts.headers };
  const res = await fetch(url, opts);
  if (res.status === 401) { logout(); throw new Error("Session expired"); }
  return res;
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;
  try {
    const res = await fetch(`${API}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    showApp();
  } catch (err) {
    document.getElementById("loginError").textContent = err.message;
  }
});

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appScreen").classList.add("hidden");
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appScreen").classList.remove("hidden");
  document.getElementById("userInfo").textContent = `${currentUser.username} (${currentUser.role})`;
  if (currentUser.role === "admin") {
    document.getElementById("adminBtn").classList.remove("hidden");
  } else {
    document.getElementById("adminBtn").classList.add("hidden");
  }
  init();
}

// --- Main App ---
async function init() {
  const res = await apiFetch(`${API}/api/clusters`);
  clusters = await res.json();
  const select = document.getElementById("clusterSelect");
  select.innerHTML = '<option value="all">All Clusters</option>';
  clusters.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.index;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  await loadPods();
}

async function loadPods() {
  const tableDiv = document.getElementById("podTable");
  tableDiv.innerHTML = '<div class="loading">Loading pods...</div>';
  allPods = [];
  allowedNamespaces = [];

  const clusterVal = document.getElementById("clusterSelect").value;
  const indices = clusterVal === "all" ? clusters.map((c) => c.index) : [parseInt(clusterVal)];

  const results = await Promise.allSettled(
    indices.map((i) =>
      apiFetch(`${API}/api/clusters/${i}/pods`)
        .then((r) => r.json())
        .then((data) => {
          if (data.allowedNamespaces) allowedNamespaces.push(...data.allowedNamespaces);
          return data.pods.map((p) => ({ ...p, cluster: data.cluster, clusterIndex: i }));
        })
    )
  );

  results.forEach((r) => {
    if (r.status === "fulfilled") allPods.push(...r.value);
  });

  // Populate namespace filter
  const nsSet = [...new Set(allPods.map((p) => p.namespace))].sort();
  const nsSelect = document.getElementById("namespaceFilter");
  nsSelect.innerHTML = '<option value="all">All Namespaces</option>';
  nsSet.forEach((ns) => {
    const opt = document.createElement("option");
    opt.value = ns;
    opt.textContent = ns;
    nsSelect.appendChild(opt);
  });

  renderSummary();
  renderTable();
}

function renderSummary() {
  const total = allPods.length;
  const running = allPods.filter((p) => p.status === "Running").length;
  const crashed = allPods.filter((p) => ["Failed", "CrashLoopBackOff", "Error"].includes(p.status) || p.reason).length;
  const restarted = allPods.filter((p) => p.restarts > 0).length;

  document.getElementById("summary").innerHTML = `
    <div class="summary-card success"><div class="value">${running}</div><div class="label">Running</div></div>
    <div class="summary-card danger"><div class="value">${crashed}</div><div class="label">Crashed/Error</div></div>
    <div class="summary-card warning"><div class="value">${restarted}</div><div class="label">Restarted</div></div>
    <div class="summary-card"><div class="value">${total}</div><div class="label">Total Pods</div></div>
  `;
}

function renderTable() {
  const filter = document.getElementById("filterSelect").value;
  const nsFilter = document.getElementById("namespaceFilter").value;
  let pods = [...allPods];

  if (nsFilter !== "all") pods = pods.filter((p) => p.namespace === nsFilter);
  if (filter === "crashed") pods = pods.filter((p) => p.status !== "Running" || p.reason);
  else if (filter === "restarted") pods = pods.filter((p) => p.restarts > 0);
  else if (filter === "high-memory") pods = pods.sort((a, b) => (b.memUsage || 0) - (a.memUsage || 0)).slice(0, 30);
  else if (filter === "high-cpu") pods = pods.sort((a, b) => (b.cpuUsage || 0) - (a.cpuUsage || 0)).slice(0, 30);

  const tableDiv = document.getElementById("podTable");
  if (pods.length === 0) {
    tableDiv.innerHTML = '<div class="loading">No pods found</div>';
    return;
  }

  tableDiv.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Cluster</th><th>Namespace</th><th>Pod Name</th><th>Status</th>
          <th>Ready</th><th>Restarts</th><th>CPU Usage</th><th>CPU (Req/Limit)</th><th>Memory Usage</th><th>Memory (Req/Limit)</th><th>Age</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${pods.map((p) => `
          <tr>
            <td><span class="cluster-tag">${p.cluster}</span></td>
            <td>${p.namespace}</td>
            <td>${p.name}</td>
            <td class="status-${(p.reason || p.status).toLowerCase()}">${p.reason || p.status}</td>
            <td>${p.ready}</td>
            <td>${p.restarts > 0 ? `<strong style="color:#d29922">${p.restarts}</strong>` : "0"}</td>
            <td><strong style="color:#58a6ff">${formatCpu(p.cpuUsage)}</strong></td>
            <td>${formatCpu(p.cpuRequests)} / ${formatCpu(p.cpuLimits)}</td>
            <td><strong style="color:#58a6ff">${formatMemory(p.memUsage)}</strong></td>
            <td>${formatMemory(p.memoryRequests)} / ${formatMemory(p.memoryLimits)}</td>
            <td>${timeAgo(p.age)}</td>
            <td>
              <button class="restart-btn" onclick="restartPod(${p.clusterIndex}, '${p.name}', '${p.namespace}')">Restart</button>
              <button class="log-btn" onclick="viewLogs(${p.clusterIndex}, '${p.name}', '${p.namespace}')">Logs</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// --- Restart ---
async function restartPod(clusterIndex, name, namespace) {
  if (!confirm(`Restart deployment for pod "${name}" in namespace "${namespace}"?`)) return;
  try {
    const res = await apiFetch(`${API}/api/clusters/${clusterIndex}/pods/restart`, {
      method: "POST",
      body: JSON.stringify({ name, namespace }),
    });
    const data = await res.json();
    alert(data.message || data.error);
    await loadPods();
  } catch (err) {
    alert("Failed: " + err.message);
  }
}

// --- Live Logs ---
function viewLogs(clusterIndex, podName, namespace) {
  document.getElementById("logModal").classList.remove("hidden");
  document.getElementById("logTitle").textContent = `Logs: ${podName}`;
  const output = document.getElementById("logOutput");
  output.textContent = "Connecting...\n";

  if (logEventSource) { logEventSource.close(); logEventSource = null; }

  const url = `${API}/api/clusters/${clusterIndex}/pods/${namespace}/${podName}/logs?tailLines=100`;
  logEventSource = new EventSource(url);

  // SSE doesn't support custom headers, so we use a workaround with fetch
  logEventSource.close();
  logEventSource = null;

  // Use fetch with streaming instead
  streamLogs(clusterIndex, podName, namespace, output);
}

async function streamLogs(clusterIndex, podName, namespace, output) {
  try {
    const res = await fetch(
      `${API}/api/clusters/${clusterIndex}/pods/${namespace}/${podName}/logs?tailLines=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      const err = await res.json();
      output.textContent = `Error: ${err.error}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    output.textContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      // Parse SSE data lines
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          output.textContent += line.slice(6) + "\n";
          output.scrollTop = output.scrollHeight;
        }
      }
    }
  } catch (err) {
    if (output) output.textContent += `\n[Stream closed: ${err.message}]`;
  }
}

function closeLogs() {
  document.getElementById("logModal").classList.add("hidden");
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
}

// --- Admin Panel ---
function showAdminPanel() {
  document.getElementById("adminModal").classList.remove("hidden");
  switchTab("users");
}

function closeAdmin() {
  document.getElementById("adminModal").classList.add("hidden");
}

async function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  event.target?.classList?.add("active");

  if (tab === "users") await renderUsersTab();
  else await renderAccessTab();
}

async function renderUsersTab() {
  const res = await apiFetch(`${API}/api/admin/users`);
  const users = await res.json();
  document.getElementById("adminContent").innerHTML = `
    <div class="admin-form">
      <input id="newUser" placeholder="Username" />
      <input id="newPass" type="password" placeholder="Password" />
      <select id="newRole"><option value="user">User</option><option value="admin">Admin</option></select>
      <button onclick="createUser()">Add User</button>
    </div>
    <table class="admin-table">
      <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Action</th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${u.username}</td><td>${u.role}</td><td>${new Date(u.created_at).toLocaleDateString()}</td>
            <td>${u.role !== "admin" ? `<button class="btn-danger" onclick="deleteUser(${u.id})">Delete</button>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function createUser() {
  const username = document.getElementById("newUser").value;
  const password = document.getElementById("newPass").value;
  const role = document.getElementById("newRole").value;
  if (!username || !password) return alert("Fill all fields");
  await apiFetch(`${API}/api/admin/users`, {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });
  await renderUsersTab();
}

async function deleteUser(id) {
  if (!confirm("Delete this user?")) return;
  await apiFetch(`${API}/api/admin/users/${id}`, { method: "DELETE" });
  await renderUsersTab();
}

// --- Access Tab ---
async function renderAccessTab() {
  const res = await apiFetch(`${API}/api/admin/users`);
  const users = await res.json();
  const normalUsers = users.filter((u) => u.role === "user");

  // Fetch all clusters (admin sees all)
  const clusterRes = await apiFetch(`${API}/api/clusters`);
  const allClusters = await clusterRes.json();

  document.getElementById("adminContent").innerHTML = `
    <div style="margin-bottom:16px">
      <label>Select User: </label>
      <select id="accessUser" onchange="onAccessUserChange()">
        <option value="">-- Select --</option>
        ${normalUsers.map((u) => `<option value="${u.id}">${u.username}</option>`).join("")}
      </select>
    </div>
    <div id="clusterAccessSection" class="hidden">
      <h4 style="color:#8b949e;margin-bottom:8px">Cluster Access</h4>
      <div id="clusterCheckboxes" class="ns-checkbox-grid">
        ${allClusters.map((c) => `
          <label><input type="checkbox" class="cluster-cb" value="${c.index}" onchange="onClusterCheckChange()" /> <span>${c.name}</span></label>
        `).join("")}
      </div>
      <button class="btn-small" style="margin-top:8px" onclick="saveClusterAccess()">Save Cluster Access</button>
    </div>
    <hr style="border-color:#30363d;margin:16px 0" />
    <div id="nsAccessSection" class="hidden">
      <h4 style="color:#8b949e;margin-bottom:8px">Namespace Access</h4>
      <label>Cluster: </label>
      <select id="accessCluster" onchange="loadClusterNamespaces()"></select>
      <div id="nsCheckboxes" style="margin-top:12px"></div>
      <button class="btn-small" style="margin-top:12px" onclick="saveAccess()">Save Namespace Access</button>
    </div>
    <div id="currentAccess" style="margin-top:20px"></div>
  `;
}

async function onAccessUserChange() {
  const userId = document.getElementById("accessUser")?.value;
  if (!userId) {
    document.getElementById("clusterAccessSection").classList.add("hidden");
    document.getElementById("nsAccessSection").classList.add("hidden");
    document.getElementById("currentAccess").innerHTML = "";
    return;
  }

  document.getElementById("clusterAccessSection").classList.remove("hidden");

  const res = await apiFetch(`${API}/api/admin/users/${userId}/access`);
  const access = await res.json();

  // Check cluster checkboxes based on saved access
  document.querySelectorAll(".cluster-cb").forEach((cb) => {
    cb.checked = access.clusters.some((a) => a.cluster_index === parseInt(cb.value));
  });

  // Build cluster dropdown for namespace section (only checked clusters)
  updateNsClusterDropdown(access);

  // Show current access summary
  showAccessSummary(access);
}

function onClusterCheckChange() {
  // After changing cluster checkboxes, update the namespace cluster dropdown
  const checkedClusters = [...document.querySelectorAll(".cluster-cb:checked")].map((cb) => parseInt(cb.value));
  const select = document.getElementById("accessCluster");
  select.innerHTML = "";

  if (checkedClusters.length === 0) {
    document.getElementById("nsAccessSection").classList.add("hidden");
    return;
  }

  document.getElementById("nsAccessSection").classList.remove("hidden");
  checkedClusters.forEach((ci) => {
    const clusterName = clusters.find((c) => c.index === ci)?.name || `Cluster ${ci}`;
    const opt = document.createElement("option");
    opt.value = ci;
    opt.textContent = clusterName;
    select.appendChild(opt);
  });

  loadClusterNamespaces();
}

function updateNsClusterDropdown(access) {
  const checkedClusters = [...document.querySelectorAll(".cluster-cb:checked")].map((cb) => parseInt(cb.value));
  const select = document.getElementById("accessCluster");
  select.innerHTML = "";

  if (checkedClusters.length === 0) {
    document.getElementById("nsAccessSection").classList.add("hidden");
    return;
  }

  document.getElementById("nsAccessSection").classList.remove("hidden");
  checkedClusters.forEach((ci) => {
    const clusterName = clusters.find((c) => c.index === ci)?.name || `Cluster ${ci}`;
    const opt = document.createElement("option");
    opt.value = ci;
    opt.textContent = clusterName;
    select.appendChild(opt);
  });

  loadClusterNamespaces();
}

function showAccessSummary(access) {
  const currentDiv = document.getElementById("currentAccess");
  if (access.namespaces.length > 0 || access.clusters.length > 0) {
    currentDiv.innerHTML = `
      <h4 style="color:#8b949e;margin-bottom:8px">Current access:</h4>
      <ul style="font-size:12px;color:#8b949e">
        ${access.clusters.map((a) => `<li><strong>Cluster:</strong> ${clusters.find((c) => c.index === a.cluster_index)?.name || a.cluster_index}</li>`).join("")}
        ${access.namespaces.map((a) => `<li>↳ Cluster ${clusters.find((c) => c.index === a.cluster_index)?.name || a.cluster_index} → ${a.namespace}</li>`).join("")}
      </ul>`;
  } else {
    currentDiv.innerHTML = '<p style="font-size:12px;color:#8b949e">No access assigned</p>';
  }
}

async function loadUserAccess() {
  const userId = document.getElementById("accessUser")?.value;
  if (!userId) return;
  const res = await apiFetch(`${API}/api/admin/users/${userId}/access`);
  const access = await res.json();
  showAccessSummary(access);
}

async function saveClusterAccess() {
  const userId = document.getElementById("accessUser")?.value;
  if (!userId) return alert("Select a user first");

  const clusterIndices = [...document.querySelectorAll(".cluster-cb:checked")].map((cb) => parseInt(cb.value));
  await apiFetch(`${API}/api/admin/users/${userId}/cluster-access`, {
    method: "POST",
    body: JSON.stringify({ clusterIndices }),
  });
  alert("Cluster access saved");
  closeAdmin();
}

async function loadClusterNamespaces() {
  const clusterIndex = document.getElementById("accessCluster")?.value;
  if (clusterIndex === undefined || clusterIndex === null || clusterIndex === "") return;

  const container = document.getElementById("nsCheckboxes");
  container.innerHTML = '<div class="loading">Loading namespaces...</div>';

  try {
    const res = await apiFetch(`${API}/api/clusters/${clusterIndex}/namespaces`);
    const namespaces = await res.json();
    container.innerHTML = `
      <div class="ns-checkbox-grid">
        ${namespaces.map((ns) => `
          <label><input type="checkbox" class="ns-cb" value="${ns}" /> <span>${ns}</span></label>
        `).join("")}
      </div>
    `;
    // Auto-check saved namespace access
    await loadNamespaceChecks();
  } catch (err) {
    container.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function loadNamespaceChecks() {
  const userId = document.getElementById("accessUser")?.value;
  const clusterIndex = document.getElementById("accessCluster")?.value;
  if (!userId || clusterIndex === undefined) return;

  const res = await apiFetch(`${API}/api/admin/users/${userId}/access`);
  const access = await res.json();
  const clusterAccess = access.namespaces.filter((a) => a.cluster_index === parseInt(clusterIndex));

  document.querySelectorAll(".ns-cb").forEach((cb) => {
    cb.checked = clusterAccess.some((a) => a.namespace === cb.value);
  });
}

async function saveAccess() {
  const userId = document.getElementById("accessUser")?.value;
  const clusterIndex = parseInt(document.getElementById("accessCluster")?.value);
  if (!userId) return alert("Select a user first");

  const namespaces = [...document.querySelectorAll(".ns-cb:checked")].map((cb) => cb.value);
  await apiFetch(`${API}/api/admin/users/${userId}/access`, {
    method: "POST",
    body: JSON.stringify({ clusterIndex, namespaces }),
  });
  alert("Namespace access saved");
  closeAdmin();
}

// --- Utilities ---
function formatCpu(cores) {
  if (cores === undefined || cores === null) return "—";
  if (cores === 0) return "0m";
  if (cores < 1) return Math.round(cores * 1000) + "m";
  return cores.toFixed(1) + " cores";
}

function formatMemory(bytes) {
  if (!bytes) return "—";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " Gi";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + " Mi";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " Ki";
  return bytes + " B";
}

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  return Math.floor(hrs / 24) + "d";
}

// --- Event Listeners ---
document.getElementById("refreshBtn").addEventListener("click", loadPods);
document.getElementById("clusterSelect").addEventListener("change", loadPods);
document.getElementById("namespaceFilter").addEventListener("change", renderTable);
document.getElementById("filterSelect").addEventListener("change", renderTable);

// --- Boot ---
if (token && currentUser) {
  showApp();
} else {
  document.getElementById("loginScreen").classList.remove("hidden");
}

// --- Restart Events ---
async function showRestartsPanel() {
  document.getElementById("restartModal").classList.remove("hidden");

  // Populate cluster filter (uses same `clusters` array which is already filtered by access)
  const clusterSelect = document.getElementById("restartClusterFilter");
  clusterSelect.innerHTML = '<option value="all">All Clusters</option>';
  clusters.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.index;
    opt.textContent = c.name;
    clusterSelect.appendChild(opt);
  });

  await loadRestartEvents();
}

async function loadRestartEvents() {
  const cluster = document.getElementById("restartClusterFilter").value;
  const namespace = document.getElementById("restartNsFilter").value;
  const content = document.getElementById("restartContent");
  content.innerHTML = '<div class="loading">Loading restart events...</div>';

  try {
    const params = new URLSearchParams();
    if (cluster !== "all") params.set("cluster", cluster);
    if (namespace !== "all") params.set("namespace", namespace);

    const res = await apiFetch(`${API}/api/restarts?${params}`);
    const events = await res.json();

    if (events.length === 0) {
      content.innerHTML = '<div class="loading">No restart events in the last 2 days</div>';
      return;
    }

    // Populate namespace filter from events
    const nsSet = [...new Set(events.map((e) => e.namespace))].sort();
    const nsSelect = document.getElementById("restartNsFilter");
    const currentNs = nsSelect.value;
    nsSelect.innerHTML = '<option value="all">All Namespaces</option>';
    nsSet.forEach((ns) => {
      const opt = document.createElement("option");
      opt.value = ns;
      opt.textContent = ns;
      if (ns === currentNs) opt.selected = true;
      nsSelect.appendChild(opt);
    });

    content.innerHTML = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Time</th><th>Cluster</th><th>Namespace</th><th>Pod</th><th>Container</th><th>Restarts</th><th>Reason</th><th>Analysis</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${events.map((e) => {
            const analysis = safeParseJSON(e.ai_analysis);
            const clusterName = clusters.find((c) => c.index === e.cluster_index)?.name || `Cluster ${e.cluster_index}`;
            return `
              <tr>
                <td>${formatTime(e.restart_time)}</td>
                <td><span class="cluster-tag">${clusterName}</span></td>
                <td>${e.namespace}</td>
                <td title="${e.pod_name}">${truncate(e.pod_name, 35)}</td>
                <td>${e.container_name}</td>
                <td><strong style="color:#d29922">${e.restart_count}</strong></td>
                <td><span class="reason-tag reason-${classifyReason(e.reason)}">${e.reason}</span></td>
                <td class="analysis-cell">${analysis?.patterns?.length ? analysis.patterns[0] : "—"}</td>
                <td><button class="log-btn" onclick="viewRestartDetail(${e.id})">Details</button></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    content.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

async function viewRestartDetail(id) {
  document.getElementById("restartDetailModal").classList.remove("hidden");
  const content = document.getElementById("restartDetailContent");
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await apiFetch(`${API}/api/restarts/${id}`);
    const event = await res.json();
    const analysis = safeParseJSON(event.ai_analysis);
    const clusterName = clusters.find((c) => c.index === event.cluster_index)?.name || `Cluster ${event.cluster_index}`;

    document.getElementById("restartDetailTitle").textContent = `Restart: ${event.pod_name}`;

    content.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Time</span><span>${formatTime(event.restart_time)}</span></div>
        <div class="detail-item"><span class="detail-label">Cluster</span><span>${clusterName}</span></div>
        <div class="detail-item"><span class="detail-label">Namespace</span><span>${event.namespace}</span></div>
        <div class="detail-item"><span class="detail-label">Pod</span><span>${event.pod_name}</span></div>
        <div class="detail-item"><span class="detail-label">Container</span><span>${event.container_name}</span></div>
        <div class="detail-item"><span class="detail-label">Restart Count</span><span style="color:#d29922;font-weight:700">${event.restart_count}</span></div>
        <div class="detail-item"><span class="detail-label">Reason</span><span class="reason-tag reason-${classifyReason(event.reason)}">${event.reason}</span></div>
      </div>
      ${analysis ? `
        <div class="analysis-box">
          <h4>AI Analysis</h4>
          <p>${analysis.summary}</p>
          ${analysis.patterns?.length ? `<div class="pattern-tags">${analysis.patterns.map((p) => `<span class="pattern-tag">${p}</span>`).join("")}</div>` : ""}
        </div>
      ` : ""}
      <div class="logs-section">
        <h4>Last ${TAIL_LINES_DISPLAY} Lines (Previous Container)</h4>
        <div class="log-viewer">${formatLogLines(event.previous_logs || "No logs captured")}</div>
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

function formatLogLines(logText) {
  const lines = logText.split("\n");
  return lines.map((line, i) => {
    const level = detectLogLevel(line);
    const lineNum = String(i + 1).padStart(2, " ");
    return `<div class="log-line log-level-${level}"><span class="log-num">${lineNum}</span><span class="log-text">${escapeHtml(line)}</span></div>`;
  }).join("");
}

function detectLogLevel(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("fatal") || l.includes("panic") || l.includes("exception")) return "error";
  if (l.includes("warn")) return "warn";
  if (l.includes("debug") || l.includes("trace")) return "debug";
  return "info";
}

const TAIL_LINES_DISPLAY = 50;

function closeRestarts() {
  document.getElementById("restartModal").classList.add("hidden");
}

function closeRestartDetail() {
  document.getElementById("restartDetailModal").classList.add("hidden");
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function formatTime(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleString();
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function classifyReason(reason) {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();
  if (r.includes("oom")) return "oom";
  if (r.includes("error") || r.includes("crash")) return "error";
  if (r.includes("exit")) return "exit";
  return "other";
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Event listeners for restart filters
document.getElementById("restartClusterFilter")?.addEventListener("change", () => {
  document.getElementById("restartNsFilter").value = "all";
  loadRestartEvents();
});
document.getElementById("restartNsFilter")?.addEventListener("change", loadRestartEvents);
