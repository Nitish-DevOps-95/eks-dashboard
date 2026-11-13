# EKS Pod Dashboard

A web-based Kubernetes pod monitoring and management dashboard built for EKS clusters. Provides real-time pod status, live CPU/memory usage metrics, pod log streaming, and deployment rollout restart — all behind a role-based access control system.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Frontend)                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────┐     ┌─────────────────────────┐     ┌────────────────┐  │
│  │  Login    │────▶│      Dashboard           │     │  Admin Panel   │  │
│  │  Screen   │     │                          │     │ (admin only)   │  │
│  └───────────┘     │ • Pod table with live    │     │                │  │
│                    │   CPU & memory usage     │     │ • Create users │  │
│                    │ • Namespace filter       │     │ • Delete users │  │
│                    │ • Status filter          │     │ • Assign NS    │  │
│                    │ • High CPU/Mem filter    │     │   access per   │  │
│                    │ • Restart button         │     │   cluster      │  │
│                    │ • Live Logs button       │     └────────────────┘  │
│                    └─────────────────────────┘                          │
│                              │                                          │
│               JWT token in Authorization header                         │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     EXPRESS SERVER (server/index.js)                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌────────────────────┐    ┌─────────────────────┐ │
│  │ Auth Routes  │    │   Pod Routes       │    │   Admin Routes      │ │
│  │              │    │                    │    │                     │ │
│  │ POST /login  │    │ GET  /pods         │    │ GET/POST  /users    │ │
│  └──────────────┘    │ POST /pods/restart │    │ DELETE    /users/:id│ │
│                      │ GET  /pods/logs    │    │ GET/POST  /access   │ │
│                      └────────────────────┘    └─────────────────────┘ │
│                               │                                         │
│  ┌────────────────────────────┼──────────────────────────────────────┐ │
│  │                     Middleware Layer                               │ │
│  │  auth.js: JWT verification + role-based access (admin/user)       │ │
│  │  Namespace check: users can only access assigned namespaces       │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ db.js (SQLite via better-sqlite3)                                 │ │
│  │                                                                   │ │
│  │  TABLE: users                    TABLE: user_namespace_access     │ │
│  │  ┌────┬──────────┬──────┐       ┌─────────┬──────────┬────────┐  │ │
│  │  │ id │ username │ role │       │ user_id │ cluster  │   ns   │  │ │
│  │  ├────┼──────────┼──────┤       ├─────────┼──────────┼────────┤  │ │
│  │  │ 1  │ admin    │admin │       │ 2       │ 0        │default │  │ │
│  │  │ 2  │ dev-user │user  │       │ 2       │ 0        │kube-sys│  │ │
│  │  └────┴──────────┴──────┘       └─────────┴──────────┴────────┘  │ │
│  │                                                                   │ │
│  │  • Auto-creates on first run (data.db)                            │ │
│  │  • Seeds default admin user                                       │ │
│  │  • Passwords stored as bcrypt hashes                              │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────�┼──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                EKS CLUSTERS (via ~/.kube/config contexts)                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  @kubernetes/client-node library connects using kubeconfig contexts      │
│                                                                         │
│  ┌──────────────────┐                                                   │
│  │ CoreV1Api        │── listNamespacedPod (get pods per namespace)       │
│  │                  │── readNamespacedPod (get pod details)              │
│  │                  │── deleteNamespacedPod (fallback restart)           │
│  │                  │── listNamespace (get all namespaces)               │
│  ├──────────────────┤                                                   │
│  │ AppsV1Api        │── patchNamespacedDeployment (rollout restart)      │
│  │                  │── readNamespacedReplicaSet (find parent deploy)    │
│  ├──────────────────┤                                                   │
│  │ Metrics API      │── getPodMetrics (live CPU/memory usage)            │
│  ├──────────────────┤                                                   │
│  │ Log API          │── log() with follow:true (stream live logs)        │
│  └──────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Features

### Authentication & RBAC
- JWT-based login (8h token expiry)
- Two roles: `admin` and `user`
- Admin has full access to all namespaces across all clusters
- Normal users only see pods in namespaces explicitly assigned by admin
- Restart and logs are also restricted by namespace access

### Pod Monitoring
- Lists all pods with status, ready count, restarts, and age
- Live CPU and memory usage from Kubernetes Metrics API (same as `kubectl top pod`)
- Static CPU/memory requests and limits from pod spec
- Filters: All, Crashed/Errors, Restarted, High Memory (top 30), High CPU (top 30)
- Namespace filter dropdown
- Multi-cluster support

### Restart (Rollout Restart)
- Does NOT delete pods directly
- Traces: Pod → ReplicaSet → Deployment
- Patches deployment annotation `kubectl.kubernetes.io/restartedAt` (identical to `kubectl rollout restart deployment`)
- Graceful rolling restart respecting your deployment strategy
- Fallback: if pod has no parent Deployment (standalone or ReplicaSet-only), deletes the pod

### Live Pod Logs
- Streams logs in real-time via Server-Sent Events (SSE)
- Shows last 100 lines then follows new output
- Streams directly from Kubernetes Log API — nothing stored on disk

### Admin Panel
- Create and delete users
- Assign namespace access per cluster per user (checkbox UI)
- View current access summary

---

## File Structure

```
eks-pod-dashboard/
├── server/
│   ├── index.js          # Express server, all API routes, K8s logic
│   ├── config.js         # Cluster list, port, JWT secret
│   ├── db.js             # SQLite setup, tables, seed admin
│   └── auth.js           # JWT middleware (authMiddleware, adminOnly)
├── public/
│   ├── index.html        # Login screen, dashboard, admin modal, log modal
│   ├── app.js            # Frontend logic (auth, pods, admin, logs)
│   └── style.css         # Dark theme UI
├── data.db               # SQLite database (auto-created on first run)
├── package.json
└── README.md
```

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/login` | No | Login, returns JWT |
| GET | `/api/clusters` | Yes | List configured clusters |
| GET | `/api/clusters/:id/namespaces` | Yes | List all namespaces in a cluster |
| GET | `/api/clusters/:id/pods` | Yes | Get pods (filtered by user's allowed namespaces) + live metrics |
| POST | `/api/clusters/:id/pods/restart` | Yes | Rollout restart the pod's parent deployment |
| GET | `/api/clusters/:id/pods/:ns/:pod/logs` | Yes | Stream live pod logs (SSE) |
| GET | `/api/admin/users` | Admin | List all users |
| POST | `/api/admin/users` | Admin | Create user |
| DELETE | `/api/admin/users/:id` | Admin | Delete user |
| GET | `/api/admin/users/:id/access` | Admin | Get user's namespace access |
| POST | `/api/admin/users/:id/access` | Admin | Set user's namespace access for a cluster |

---

## Setup & Run

### Prerequisites
- Node.js 18+
- `~/.kube/config` with contexts configured for your EKS clusters
- Metrics Server installed in your EKS cluster (for live CPU/memory)

### Install
```bash
npm install
```

### Configure Clusters
Edit `server/config.js`:
```javascript
module.exports = {
  clusters: [
    { name: "EKS-Dev (ap-south-1)", context: "alcsng-dev" },
    { name: "EKS-Prod (ap-south-1)", context: "alcsng-prod" },
  ],
  port: 3000,
  jwtSecret: process.env.JWT_SECRET || "change-this-secret-in-production",
  defaultAdmin: {
    username: "admin",
    password: "admin123",
  },
};
```

The `context` field must match the context name in your kubeconfig (`kubectl config get-contexts`).

### Run
```bash
npm start
# or
node server/index.js
```

Dashboard available at: http://localhost:3000

### Default Login
- Username: `admin`
- Password: `admin123`

Change this after first login by creating a new admin user and deleting the default one.

---

## How It Works (Detailed)

### 1. Authentication Flow
```
Browser → POST /api/login (username, password)
Server  → bcrypt.compare against SQLite → returns JWT (8h expiry)
Browser → stores JWT in localStorage
Browser → all subsequent requests include: Authorization: Bearer <token>
Server  → authMiddleware verifies JWT on every request
```

### 2. Pod Data Flow
```
Browser → GET /api/clusters/0/pods
Server  → Check user role:
           - admin: fetch ALL namespaces
           - user: fetch only assigned namespaces from SQLite
Server  → For each allowed namespace:
           - CoreV1Api.listNamespacedPod() → pod spec data
           - Metrics.getPodMetrics() → live CPU/memory usage
Server  → Merge pod spec + metrics → return to browser
Browser → Render table with all columns
```

### 3. Restart Flow
```
Browser → POST /api/clusters/0/pods/restart { name, namespace }
Server  → Verify user has access to that namespace
Server  → CoreV1Api.readNamespacedPod() → get ownerReferences
Server  → Find ReplicaSet owner → read ReplicaSet → find Deployment owner
Server  → AppsV1Api.patchNamespacedDeployment() with restart annotation
           (same as: kubectl rollout restart deployment <name>)
EKS     → Rolling restart: new pods up, old pods terminated gracefully
```

### 4. Log Streaming Flow
```
Browser → GET /api/clusters/0/pods/ns/podname/logs (with JWT header)
Server  → Verify namespace access
Server  → k8s.Log.log(namespace, pod, container, stream, {follow: true})
Server  → SSE: data: <log line>\n\n → continuously sent to browser
Browser → ReadableStream reader → append to <pre> element in real-time
Browser → Close modal → abort connection → stream destroyed
```

---

## Security Considerations for Production (EKS Deployment)

1. Set `JWT_SECRET` as an environment variable (don't use default)
2. Change default admin password immediately
3. Run behind an ALB/NLB with HTTPS termination
4. Restrict the kubeconfig RBAC — the service account used should only have:
   - `pods: get, list, delete`
   - `deployments: get, patch`
   - `replicasets: get`
   - `namespaces: list`
   - `pods/log: get`
   - `metrics.k8s.io/pods: get`
5. Consider adding rate limiting for the login endpoint
6. The SQLite database file (`data.db`) should be on a persistent volume if running in K8s

---

## Dependencies

| Package | Purpose |
|---------|---------|
| express | HTTP server and routing |
| @kubernetes/client-node | Kubernetes API client (pods, deployments, metrics, logs) |
| better-sqlite3 | SQLite database for users and access control |
| bcryptjs | Password hashing |
| jsonwebtoken | JWT token generation and verification |
| cors | Cross-origin resource sharing |
