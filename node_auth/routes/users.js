// routes/users.js — User Management Service
// GET /api/users        → list all users (with optional role filter)
// GET /api/users/:id    → get single user profile
const router = require('express').Router();
const pool   = require('../config/db');
const auth   = require('../middleware/auth');

// GET /api/users  &  GET /api/users?role=buyer  |  GET /api/users?role=seller
router.get('/', auth, async (req, res) => {
  try {
    const { role } = req.query;
    const values = [];
    let where = '';
    if (role && ['buyer', 'seller', 'both'].includes(role)) {
      values.push(role);
      where = 'WHERE role = $1';
    }
    const result = await pool.query(
      `SELECT id, organisation_name, email, organisation_type,
              country, state, district, zone, ward, role, created_at
       FROM users ${where}
       ORDER BY created_at DESC`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('users list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, organisation_name, email, organisation_type,
              country, state, district, zone, ward, role, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('user fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
