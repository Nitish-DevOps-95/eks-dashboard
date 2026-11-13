const k8s = require("@kubernetes/client-node");
const config = require("./config");
const db = require("./db");

// Track last known restart counts: { "clusterIdx:namespace/pod/container": restartCount }
const restartTracker = {};
let isFirstPoll = true; // Skip capturing on first poll (baseline only)

const TAIL_LINES = 50;
const POLL_INTERVAL = 30000; // 30 seconds
const RETENTION_DAYS = 2;

function getK8sClients(contextName) {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(contextName);
  return {
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
    kc,
  };
}

async function fetchPreviousLogs(coreApi, namespace, podName, containerName) {
  try {
    const res = await coreApi.readNamespacedPodLog(podName, namespace, containerName, false, undefined, undefined, undefined, true, undefined, TAIL_LINES, undefined);
    return stripAnsi(res.body || "");
  } catch (err) {
    return `[Failed to fetch previous logs: ${err.message}]`;
  }
}

// Strip ANSI escape codes from log text
function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[\d;]*m/g, "");
}

function getTerminationReason(containerStatus) {
  const lastState = containerStatus.lastState;
  if (lastState?.terminated) {
    return lastState.terminated.reason || `Exit code ${lastState.terminated.exitCode}`;
  }
  if (containerStatus.state?.waiting) {
    return containerStatus.state.waiting.reason || "Unknown";
  }
  return "Unknown";
}

function getTerminationTime(containerStatus) {
  const lastState = containerStatus.lastState;
  if (lastState?.terminated?.finishedAt) {
    return new Date(lastState.terminated.finishedAt).toISOString();
  }
  return new Date().toISOString();
}

// Extract deployment name from pod name (removes replicaset hash + pod hash)
// e.g. "hcm-benefit-api-5b699cb6c7-9lz7j" -> "hcm-benefit-api"
function getDeploymentPrefix(podName) {
  const parts = podName.split("-");
  if (parts.length >= 3) {
    // Remove last 2 segments (replicaset hash + pod hash)
    return parts.slice(0, -2).join("-");
  }
  return null;
}

function analyzeLog(logText, reason) {
  const analysis = { reason, patterns: [], summary: "" };

  const errorPatterns = [
    { regex: /OOMKilled/i, label: "Out of Memory (OOMKilled)" },
    { regex: /OutOfMemory|java\.lang\.OutOfMemoryError/i, label: "Out of Memory (Application)" },
    { regex: /SIGKILL|SIGTERM/i, label: "Process killed by signal" },
    { regex: /panic:|FATAL|fatal error/i, label: "Fatal/Panic error" },
    { regex: /connection refused|ECONNREFUSED/i, label: "Connection refused (dependency down)" },
    { regex: /timeout|timed out|ETIMEDOUT/i, label: "Timeout error" },
    { regex: /permission denied|EACCES/i, label: "Permission denied" },
    { regex: /no such file|ENOENT/i, label: "File not found" },
    { regex: /segmentation fault|segfault/i, label: "Segmentation fault" },
    { regex: /heap|memory leak/i, label: "Possible memory leak" },
    { regex: /disk full|no space left/i, label: "Disk space exhausted" },
    { regex: /certificate|TLS|SSL/i, label: "TLS/Certificate issue" },
    { regex: /unhealthy|health check|liveness|readiness/i, label: "Health check failure" },
  ];

  for (const { regex, label } of errorPatterns) {
    if (regex.test(logText) || regex.test(reason)) {
      analysis.patterns.push(label);
    }
  }

  if (reason === "OOMKilled") {
    analysis.patterns = ["Out of Memory (OOMKilled)"];
    analysis.summary = "Container was killed due to exceeding memory limits. Consider increasing memory limits or fixing memory leaks.";
  } else if (analysis.patterns.length > 0) {
    analysis.summary = `Detected: ${analysis.patterns.join(", ")}. Check the last logs for details.`;
  } else {
    analysis.summary = `Container restarted with reason: ${reason}. Review logs for root cause.`;
  }

  return JSON.stringify(analysis);
}

async function checkCluster(clusterIndex, baselineOnly) {
  const cluster = config.clusters[clusterIndex];
  if (!cluster) return;

  try {
    const { coreApi } = getK8sClients(cluster.context);

    const nsRes = await coreApi.listNamespace();
    const namespaces = nsRes.body.items.map((ns) => ns.metadata.name);

    for (const ns of namespaces) {
      try {
        const podRes = await coreApi.listNamespacedPod(ns);
        for (const pod of podRes.body.items) {
          const containers = pod.status?.containerStatuses || [];
          for (const cs of containers) {
            const key = `${clusterIndex}:${ns}/${pod.metadata.name}/${cs.name}`;
            const currentRestarts = cs.restartCount || 0;

            // First poll: just record baseline, never capture events
            if (baselineOnly) {
              restartTracker[key] = currentRestarts;
              continue;
            }

            // New pod we haven't seen before
            if (restartTracker[key] === undefined) {
              restartTracker[key] = currentRestarts;

              // New pod with 0 restarts = fresh deployment
              // Clean old restart events for the same deployment (same prefix)
              if (currentRestarts === 0) {
                const deployPrefix = getDeploymentPrefix(pod.metadata.name);
                if (deployPrefix) {
                  db.prepare(
                    "DELETE FROM pod_restart_events WHERE cluster_index = ? AND namespace = ? AND pod_name LIKE ? AND container_name = ?"
                  ).run(clusterIndex, ns, deployPrefix + "%", cs.name);
                }
              }
              continue;
            }

            // Restart count went to 0 = new deployment, clear old events for this pod
            if (currentRestarts === 0 && restartTracker[key] > 0) {
              db.prepare(
                "DELETE FROM pod_restart_events WHERE cluster_index = ? AND namespace = ? AND pod_name = ? AND container_name = ?"
              ).run(clusterIndex, ns, pod.metadata.name, cs.name);
              console.log(`[RestartWatcher] New deployment detected, cleared old events: ${ns}/${pod.metadata.name}/${cs.name}`);
              restartTracker[key] = 0;
              continue;
            }

            // Only capture if restart count INCREASED and is > 0
            if (currentRestarts > restartTracker[key] && currentRestarts > 0) {
              const reason = getTerminationReason(cs);
              const restartTime = getTerminationTime(cs);

              // Avoid duplicate: check if we already have this exact event
              const existing = db.prepare(
                "SELECT id FROM pod_restart_events WHERE cluster_index = ? AND pod_name = ? AND container_name = ? AND restart_count = ?"
              ).get(clusterIndex, pod.metadata.name, cs.name, currentRestarts);

              if (existing) {
                restartTracker[key] = currentRestarts;
                continue;
              }

              console.log(`[RestartWatcher] Restart detected: ${ns}/${pod.metadata.name}/${cs.name} (${restartTracker[key]} -> ${currentRestarts}), reason: ${reason}`);

              const logs = await fetchPreviousLogs(coreApi, ns, pod.metadata.name, cs.name);
              const aiAnalysis = analyzeLog(logs, reason);

              db.prepare(`
                INSERT INTO pod_restart_events (cluster_index, namespace, pod_name, container_name, restart_count, reason, previous_logs, ai_analysis, restart_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(clusterIndex, ns, pod.metadata.name, cs.name, currentRestarts, reason, logs, aiAnalysis, restartTime);

              restartTracker[key] = currentRestarts;
            }
          }
        }
      } catch (err) {
        // Skip namespace on error
      }
    }
  } catch (err) {
    console.error(`[RestartWatcher] Error checking cluster ${cluster.name}:`, err.message);
  }
}

// Clean up pods that no longer exist from tracker to prevent memory leak
function cleanupTracker(clusterIndex, activePodKeys) {
  const prefix = `${clusterIndex}:`;
  for (const key of Object.keys(restartTracker)) {
    if (key.startsWith(prefix) && !activePodKeys.has(key)) {
      delete restartTracker[key];
    }
  }
}

function cleanupOldEvents() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM pod_restart_events WHERE restart_time < ?").run(cutoff);
  if (result.changes > 0) {
    console.log(`[RestartWatcher] Cleaned up ${result.changes} old restart events`);
  }
}

async function pollAll() {
  const baselineOnly = isFirstPoll;
  if (isFirstPoll) {
    console.log("[RestartWatcher] First poll — recording baseline restart counts (no events captured)");
    isFirstPoll = false;
  }

  for (let i = 0; i < config.clusters.length; i++) {
    await checkCluster(i, baselineOnly);
  }
}

function startWatcher() {
  console.log(`[RestartWatcher] Started - polling every ${POLL_INTERVAL / 1000}s, retaining ${RETENTION_DAYS} days, capturing last ${TAIL_LINES} lines`);

  // First poll is baseline only
  pollAll();

  // Subsequent polls detect actual restarts
  setInterval(pollAll, POLL_INTERVAL);

  // Cleanup old events every hour
  setInterval(cleanupOldEvents, 60 * 60 * 1000);
  cleanupOldEvents();
}

module.exports = { startWatcher };
