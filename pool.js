// db/pool.js
// A "pool" manages a handful of open database connections and reuses them,
// instead of opening a new one for every single query (slow and wasteful).
// Every route file imports this same pool.

const { Pool } = require('pg');

// DATABASE_URL is provided by Render automatically once you attach a
// Postgres database to this service (see README for setup steps).
// Locally, it falls back to our test database.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:devpass@localhost:5432/bizflow_dev',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false, // Render's Postgres requires SSL
});

module.exports = pool;
