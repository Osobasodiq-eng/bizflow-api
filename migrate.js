// db/migrate.js
// Run this once against a fresh database to create all the tables.
// Usage: npm run migrate   (reads DATABASE_URL from the environment)

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await pool.query(schema);
  console.log('Done — all tables created (or already existed).');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
