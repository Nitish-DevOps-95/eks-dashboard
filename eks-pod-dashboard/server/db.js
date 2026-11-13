const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");
const config = require("./config");

const db = new Database(path.join(__dirname, "../data.db"));

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_namespace_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cluster_index INTEGER NOT NULL,
    namespace TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, cluster_index, namespace)
  );

  CREATE TABLE IF NOT EXISTS user_cluster_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cluster_index INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, cluster_index)
  );

  CREATE TABLE IF NOT EXISTS pod_restart_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_index INTEGER NOT NULL,
    namespace TEXT NOT NULL,
    pod_name TEXT NOT NULL,
    container_name TEXT NOT NULL,
    restart_count INTEGER NOT NULL,
    reason TEXT,
    previous_logs TEXT,
    ai_analysis TEXT,
    restart_time DATETIME NOT NULL
  );
`);

// Seed default admin if no users exist
const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync(config.defaultAdmin.password, 10);
  db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')").run(
    config.defaultAdmin.username,
    hash
  );
  console.log(`Default admin created: ${config.defaultAdmin.username}`);
}

module.exports = db;
