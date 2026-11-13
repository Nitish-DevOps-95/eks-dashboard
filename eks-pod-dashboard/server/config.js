module.exports = {
  clusters: [
    { name: "CLUSTER1 (ap-south-1)", context: "1" },
    { name: "CLUSTER2 (ap-south-1)", context: "2" },
    { name: "CLUSTER3 (ap-south-1)", context: "3" },
    { name: "CLUSTER4 (ap-south-1)", context: "4" },
  ],
  port: 3000,
  jwtSecret: process.env.JWT_SECRET || "change-this-secret-in-production",
  defaultAdmin: {
    username: "admin",
    password: "admin123", // Change on first login
  },
};
