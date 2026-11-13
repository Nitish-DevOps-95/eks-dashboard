const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const k8s = require("@kubernetes/client-node");
const config = require("./config");
const db = require("./db");
const { authMiddleware, adminOnly } = require("./auth");
const { startWatcher } = require("./restart-watcher");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// --- K8s helpers ---
function getK8sClients(contextName) {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(contextName);
  return {
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
    appsApi: kc.makeApiClient(k8s.AppsV1Api),
    kc,
  };
}

function getUserAllowedNamespaces(userId, clusterIndex) {
  if (!userId) return [];
  const rows = db.prepare(
    "SELECT namespace FROM user_namespace_access WHERE user_id = ? AND cluster_index = ?"
  ).all(userId, clusterIndex);
  return rows.map((r) => r.namespace);
}

function getUserAllowedClusters(userId) {
  if (!userId) return [];
  const rows = db.prepare(
    "SELECT cluster_index FROM user_cluster_access WHERE user_id = ?"
  ).all(userId);
  return rows.map((r) => r.cluster_index);
}

// --- Auth routes ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: "8h" }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// --- Admin: User management ---
app.get("/api/admin/users", authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare("SELECT id, username, role, created_at FROM users").all();
  res.json(users);
});

app.post("/api/admin/users", authMiddleware, adminOnly, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run(
      username, hash, role || "user"
    );
    res.json({ id: result.lastInsertRowid, username, role: role || "user" });
  } catch (err) {
    res.status(400).json({ error: "Username already exists" });
  }
});

app.delete("/api/admin/users/:id", authMiddleware, adminOnly, (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  res.json({ message: "User deleted" });
});

// --- Admin: Namespace access management ---
app.get("/api/admin/users/:id/access", authMiddleware, adminOnly, (req, res) => {
  const access = db.prepare("SELECT * FROM user_namespace_access WHERE user_id = ?").all(req.params.id);
  const clusterAccess = db.prepare("SELECT * FROM user_cluster_access WHERE user_id = ?").all(req.params.id);
  res.json({ namespaces: access, clusters: clusterAccess });
});

app.post("/api/admin/users/:id/cluster-access", authMiddleware, adminOnly, (req, res) => {
  const { clusterIndices } = req.body;
  const userId = parseInt(req.params.id);

  // Replace all cluster access for this user
  db.prepare("DELETE FROM user_cluster_access WHERE user_id = ?").run(userId);

  const insert = db.prepare("INSERT INTO user_cluster_access (user_id, cluster_index) VALUES (?, ?)");
  const insertMany = db.transaction((indices) => {
    for (const ci of indices) {
      insert.run(userId, ci);
    }
  });
  insertMany(clusterIndices || []);

  // Also remove namespace access for clusters the user no longer has access to
  if (clusterIndices && clusterIndices.length > 0) {
    db.prepare(
      `DELETE FROM user_namespace_access WHERE user_id = ? AND cluster_index NOT IN (${clusterIndices.map(() => "?").join(",")})`
    ).run(userId, ...clusterIndices);
  } else {
    db.prepare("DELETE FROM user_namespace_access WHERE user_id = ?").run(userId);
  }

  res.json({ message: "Cluster access updated" });
});

app.post("/api/admin/users/:id/access", authMiddleware, adminOnly, (req, res) => {
  const { clusterIndex, namespaces } = req.body;
  const userId = parseInt(req.params.id);

  // Remove existing access for this cluster
  db.prepare("DELETE FROM user_namespace_access WHERE user_id = ? AND cluster_index = ?").run(userId, clusterIndex);

  // Add new access
  const insert = db.prepare("INSERT INTO user_namespace_access (user_id, cluster_index, namespace) VALUES (?, ?, ?)");
  const insertMany = db.transaction((nsList) => {
    for (const ns of nsList) {
      insert.run(userId, clusterIndex, ns);
    }
  });
  insertMany(namespaces || []);
  res.json({ message: "Access updated" });
});

// --- Cluster routes ---
app.get("/api/clusters", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    return res.json(config.clusters.map((c, i) => ({ index: i, name: c.name })));
  }
  const allowedClusters = getUserAllowedClusters(req.user.id);
  const filtered = config.clusters
    .map((c, i) => ({ index: i, name: c.name }))
    .filter((c) => allowedClusters.includes(c.index));
  res.json(filtered);
});

app.get("/api/clusters/:clusterIndex/namespaces", authMiddleware, async (req, res) => {
  try {
    const clusterIndex = parseInt(req.params.clusterIndex);
    const cluster = config.clusters[clusterIndex];
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    // Check cluster access for non-admin
    if (req.user.role !== "admin") {
      const allowedClusters = getUserAllowedClusters(req.user.id);
      if (!allowedClusters.includes(clusterIndex)) {
        return res.status(403).json({ error: "No access to this cluster" });
      }
    }

    const { coreApi } = getK8sClients(cluster.context);
    const nsRes = await coreApi.listNamespace();
    const namespaces = nsRes.body.items.map((ns) => ns.metadata.name);
    res.json(namespaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Pod routes ---
app.get("/api/clusters/:clusterIndex/pods", authMiddleware, async (req, res) => {
  try {
    const clusterIndex = parseInt(req.params.clusterIndex);
    const cluster = config.clusters[clusterIndex];
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    const { coreApi, kc } = getK8sClients(cluster.context);

    // Check cluster access for non-admin users
    if (req.user.role !== "admin") {
      const allowedClusters = getUserAllowedClusters(req.user.id);
      if (!allowedClusters.includes(clusterIndex)) {
        return res.status(403).json({ error: "No access to this cluster" });
      }
    }

    // Determine allowed namespaces
    let allowedNs = [];
    if (req.user.role === "admin") {
      const nsRes = await coreApi.listNamespace();
      allowedNs = nsRes.body.items.map((ns) => ns.metadata.name);
    } else {
      allowedNs = getUserAllowedNamespaces(req.user.id, clusterIndex);
    }

    if (allowedNs.length === 0) {
      return res.json({ cluster: cluster.name, pods: [], allowedNamespaces: [] });
    }

    // Fetch pods for allowed namespaces
    const podPromises = allowedNs.map((ns) =>
      coreApi.listNamespacedPod(ns).then((r) => r.body.items).catch(() => [])
    );
    const podArrays = await Promise.all(podPromises);
    const allItems = podArrays.flat();

    // Fetch live metrics (cpu/memory usage)
    let metricsMap = {};
    try {
      const metricsClient = new k8s.Metrics(kc);
      const metricsPromises = allowedNs.map((ns) =>
        metricsClient.getPodMetrics(ns).then((r) => r.items || []).catch(() => [])
      );
      const metricsArrays = await Promise.all(metricsPromises);
      metricsArrays.flat().forEach((m) => {
        const cpuUsage = (m.containers || []).reduce((sum, c) => sum + parseCpu(c.usage?.cpu || "0"), 0);
        const memUsage = (m.containers || []).reduce((sum, c) => sum + parseMemory(c.usage?.memory || "0"), 0);
        metricsMap[`${m.metadata.namespace}/${m.metadata.name}`] = { cpuUsage, memUsage };
      });
    } catch (e) {
      // metrics-server may not be available, continue without usage data
    }

    const pods = allItems.map((pod) => {
      const containers = pod.status.containerStatuses || [];
      const memoryRequests = (pod.spec.containers || []).reduce((sum, c) => {
        return sum + parseMemory(c.resources?.requests?.memory || "0");
      }, 0);
      const memoryLimits = (pod.spec.containers || []).reduce((sum, c) => {
        return sum + parseMemory(c.resources?.limits?.memory || "0");
      }, 0);
      const cpuRequests = (pod.spec.containers || []).reduce((sum, c) => {
        return sum + parseCpu(c.resources?.requests?.cpu || "0");
      }, 0);
      const cpuLimits = (pod.spec.containers || []).reduce((sum, c) => {
        return sum + parseCpu(c.resources?.limits?.cpu || "0");
      }, 0);

      const key = `${pod.metadata.namespace}/${pod.metadata.name}`;
      const metrics = metricsMap[key] || { cpuUsage: 0, memUsage: 0 };

      return {
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        status: pod.status.phase,
        reason: containers.find((c) => c.state?.waiting)?.state?.waiting?.reason || "",
        restarts: containers.reduce((sum, c) => sum + (c.restartCount || 0), 0),
        memoryRequests,
        memoryLimits,
        cpuRequests,
        cpuLimits,
        cpuUsage: metrics.cpuUsage,
        memUsage: metrics.memUsage,
        ready: containers.filter((c) => c.ready).length + "/" + containers.length,
        age: pod.metadata.creationTimestamp,
        ownerKind: pod.metadata.ownerReferences?.[0]?.kind || "",
        ownerName: pod.metadata.ownerReferences?.[0]?.name || "",
      };
    });

    res.json({ cluster: cluster.name, pods, allowedNamespaces: allowedNs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart pod's parent deployment (rollout restart)
app.post("/api/clusters/:clusterIndex/pods/restart", authMiddleware, async (req, res) => {
  try {
    const clusterIndex = parseInt(req.params.clusterIndex);
    const cluster = config.clusters[clusterIndex];
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    const { name, namespace } = req.body;
    if (!name || !namespace) return res.status(400).json({ error: "name and namespace required" });

    // Check access
    if (req.user.role !== "admin") {
      const allowedClusters = getUserAllowedClusters(req.user.id);
      if (!allowedClusters.includes(clusterIndex)) {
        return res.status(403).json({ error: "No access to this cluster" });
      }
      const allowed = getUserAllowedNamespaces(req.user.id, clusterIndex);
      if (!allowed.includes(namespace)) {
        return res.status(403).json({ error: "No access to this namespace" });
      }
    }

    const { coreApi, appsApi } = getK8sClients(cluster.context);

    // Get pod to find its owner deployment
    const podRes = await coreApi.readNamespacedPod(name, namespace);
    const ownerRef = podRes.body.metadata.ownerReferences?.find(
      (ref) => ref.kind === "ReplicaSet"
    );

    if (!ownerRef) {
      // Fallback: delete pod if not managed by a deployment
      await coreApi.deleteNamespacedPod(name, namespace);
      return res.json({ message: `Pod ${name} deleted (no parent deployment found)` });
    }

    // Get ReplicaSet to find Deployment
    const rsRes = await appsApi.readNamespacedReplicaSet(ownerRef.name, namespace);
    const deployOwner = rsRes.body.metadata.ownerReferences?.find(
      (ref) => ref.kind === "Deployment"
    );

    if (!deployOwner) {
      await coreApi.deleteNamespacedPod(name, namespace);
      return res.json({ message: `Pod ${name} deleted (owned by ReplicaSet, not Deployment)` });
    }

    // Rollout restart: patch deployment annotation
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
            },
          },
        },
      },
    };

    await appsApi.patchNamespacedDeployment(
      deployOwner.name, namespace, patch,
      undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
    );

    res.json({ message: `Deployment ${deployOwner.name} rollout restart triggered` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Pod logs (streaming via SSE) ---
app.get("/api/clusters/:clusterIndex/pods/:namespace/:podName/logs", authMiddleware, async (req, res) => {
  try {
    const clusterIndex = parseInt(req.params.clusterIndex);
    const cluster = config.clusters[clusterIndex];
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    const { namespace, podName } = req.params;
    const container = req.query.container || undefined;
    const tailLines = parseInt(req.query.tailLines) || 100;

    // Check access
    if (req.user.role !== "admin") {
      const allowedClusters = getUserAllowedClusters(req.user.id);
      if (!allowedClusters.includes(clusterIndex)) {
        return res.status(403).json({ error: "No access to this cluster" });
      }
      const allowed = getUserAllowedNamespaces(req.user.id, clusterIndex);
      if (!allowed.includes(namespace)) {
        return res.status(403).json({ error: "No access to this namespace" });
      }
    }

    const { kc } = getK8sClients(cluster.context);
    const log = new k8s.Log(kc);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const logStream = new (require("stream").PassThrough)();
    logStream.on("data", (chunk) => {
      res.write(`data: ${chunk.toString().replace(/\n/g, "\ndata: ")}\n\n`);
    });

    logStream.on("end", () => {
      res.write("event: end\ndata: stream ended\n\n");
      res.end();
    });

    req.on("close", () => {
      logStream.destroy();
    });

    await log.log(namespace, podName, container, logStream, {
      follow: true,
      tailLines,
      pretty: false,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`event: error\ndata: ${err.message}\n\n`);
      res.end();
    }
  }
});

// --- Utility ---
function parseMemory(memStr) {
  if (!memStr || memStr === "0") return 0;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const match = String(memStr).match(/^(\d+)(Ki|Mi|Gi|Ti)?$/);
  if (!match) return 0;
  return parseInt(match[1]) * (units[match[2]] || 1);
}

function parseCpu(cpuStr) {
  if (!cpuStr || cpuStr === "0") return 0;
  const str = String(cpuStr).trim();
  if (str.endsWith("m")) return parseInt(str) / 1000;
  if (str.endsWith("n")) return parseInt(str) / 1000000000;
  if (str.endsWith("u")) return parseInt(str) / 1000000;
  return parseFloat(str) || 0;
}

// --- Restart Events API ---
app.get("/api/restarts", authMiddleware, (req, res) => {
  const { cluster, namespace } = req.query;
  let query = "SELECT * FROM pod_restart_events WHERE 1=1";
  const params = [];

  if (cluster !== undefined && cluster !== "all") {
    query += " AND cluster_index = ?";
    params.push(parseInt(cluster));
  }
  if (namespace && namespace !== "all") {
    query += " AND namespace = ?";
    params.push(namespace);
  }

  // Filter by user access (non-admin)
  if (req.user.role !== "admin") {
    const allowedClusters = getUserAllowedClusters(req.user.id);
    if (allowedClusters.length === 0) {
      return res.json([]);
    }
    query += ` AND cluster_index IN (${allowedClusters.map(() => "?").join(",")})`;
    params.push(...allowedClusters);

    // Also filter by namespace access
    const nsConditions = [];
    for (const ci of allowedClusters) {
      const allowedNs = getUserAllowedNamespaces(req.user.id, ci);
      if (allowedNs.length > 0) {
        nsConditions.push(`(cluster_index = ? AND namespace IN (${allowedNs.map(() => "?").join(",")}))`);
        params.push(ci, ...allowedNs);
      }
    }
    if (nsConditions.length > 0) {
      query += ` AND (${nsConditions.join(" OR ")})`;
    } else {
      return res.json([]);
    }
  }

  // Only return events within retention period (2 days)
  query += " AND restart_time >= datetime('now', '-2 days')";
  query += " ORDER BY restart_time DESC LIMIT 200";

  const events = db.prepare(query).all(...params);
  res.json(events);
});

app.get("/api/restarts/:id", authMiddleware, (req, res) => {
  const event = db.prepare("SELECT * FROM pod_restart_events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  // Check access for non-admin
  if (req.user.role !== "admin") {
    const allowedClusters = getUserAllowedClusters(req.user.id);
    if (!allowedClusters.includes(event.cluster_index)) {
      return res.status(403).json({ error: "No access" });
    }
    const allowedNs = getUserAllowedNamespaces(req.user.id, event.cluster_index);
    if (!allowedNs.includes(event.namespace)) {
      return res.status(403).json({ error: "No access" });
    }
  }

  res.json(event);
});

app.listen(config.port, () => {
  console.log(`EKS Pod Dashboard running on http://localhost:${config.port}`);
  startWatcher();
});
